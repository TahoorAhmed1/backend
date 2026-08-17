const { prisma } = require("./prisma");

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const startOfDay = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
};

const endOfDay = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
};

// weekStartDate is assumed already normalized to Monday UTC-midnight, the
// same convention toDateOnly()/mondayOfCurrentWeek() use elsewhere in
// weeklySchedule_controller.js.
const dateForDayInWeek = (weekStartDate, dayKey) => {
  const offsetFromMonday = DAY_KEYS.indexOf(dayKey); // monday=0 ... sunday=6
  const d = new Date(weekStartDate);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetFromMonday));
};

// A day counts as "on" for an employee if that day's column isn't
// OFF/ABSENT and the employee is still ACTIVE.
const isEligibleForDay = (schedule, dayKey) => {
  const dayValue = schedule[dayKey];
  return (
    dayValue &&
    dayValue !== "OFF" &&
    dayValue !== "ABSENT" &&
    schedule.employee?.status === "ACTIVE"
  );
};

/**
 * Re-derives PENDING Ride rows for every driver with an ACTIVE,
 * fully-assigned WeeklySchedule entry in the given week. Call this after
 * ANY write to WeeklySchedule for that week (create, update, delete,
 * reassign, optimize, or a finished bulk-upload job).
 *
 * @param {Date} weekStartDate - Monday (UTC midnight) of the week to sync.
 * @returns {Promise<Array<{driverId: string, rideDate: Date, rideId?: string, passengerCount?: number, cancelled?: boolean, skipped?: boolean, reason?: string}>>}
 */
async function syncPendingRidesForWeek(weekStartDate) {
  console.log('weekStartDate', weekStartDate);
  // NOTE: driverId/vehicleId on WeeklySchedule are denormalized copies of
  // the assigned Trip's driver/vehicle. Newer assignments only set tripId
  // and rely on the route/trip controller to backfill driverId/vehicleId —
  // if that backfill hasn't happened (or the row predates it), the
  // denormalized columns can be null even though a trip (and therefore a
  // real driver/vehicle) is assigned. Filtering on routeId alone here and
  // resolving driver/vehicle from trip as a fallback keeps those rows from
  // being silently skipped.
  const schedules = await prisma.weeklySchedule.findMany({
    where: {
      weekStart: { gte: startOfDay(weekStartDate), lte: endOfDay(weekStartDate) },
      status: "ACTIVE",
      routeId: { not: null },
      OR: [
        { driverId: { not: null }, vehicleId: { not: null } },
        { tripId: { not: null } },
      ],
    },
    include: {
      employee: {
        select: { id: true, name: true, contactNumber: true, address: true, status: true, area: true, subArea: true },
      },
      trip: {
        select: { driverId: true, vehicleId: true },
      },
    },
  });

  // Resolve effective driver/vehicle: prefer the denormalized columns,
  // fall back to the linked trip's driver/vehicle. Drop rows where neither
  // source yields both a driver and a vehicle — those genuinely aren't
  // assignable to a ride yet.
  const resolved = schedules
    .map((s) => ({
      ...s,
      driverId: s.driverId ?? s.trip?.driverId ?? null,
      vehicleId: s.vehicleId ?? s.trip?.vehicleId ?? null,
    }))
    .filter((s) => s.driverId && s.vehicleId);

  // Group by driver AND trip/route, not driver alone. A single driver can
  // legitimately be assigned to more than one route/trip on the same day
  // (e.g. an early run and a later run, or covering a second trip on a
  // multi-trip route). Grouping by driverId only would merge every
  // employee from every one of that driver's routes into a single ride —
  // silently attaching the wrong passengers to the wrong route. Keying by
  // tripId (falling back to routeId for legacy rows without a trip) keeps
  // each route's roster in its own group.
  const groupKey = (s) => `${s.driverId}::${s.tripId || s.routeId}`;

  const byDriverTrip = new Map();
  for (const s of resolved) {
    const key = groupKey(s);
    if (!byDriverTrip.has(key)) byDriverTrip.set(key, []);
    byDriverTrip.get(key).push(s);
  }

  const results = [];

  for (const driverSchedules of byDriverTrip.values()) {
    const driverId = driverSchedules[0].driverId;
    // routeId is consistent across the whole group (that's what we grouped
    // on), so it's safe to read from the first row here, before we know
    // which employees are eligible on a given day.
    const groupRouteId = driverSchedules[0].routeId;

    for (const dayKey of DAY_KEYS) {
      const dayEligible = driverSchedules.filter((s) => isEligibleForDay(s, dayKey));
      const rideDate = dateForDayInWeek(weekStartDate, dayKey);

      // Scoped to this route too — not just driver+date — so a driver's
      // second route that day gets (and keeps) its own Ride row instead of
      // colliding with the first route's.
      const existing = await prisma.ride.findFirst({
        where: {
          driverId,
          routeId: groupRouteId,
          rideDate: { gte: startOfDay(rideDate), lte: endOfDay(rideDate) },
        },
      });

      if (dayEligible.length === 0) {
        // Nobody's actually assigned to this driver for this day anymore
        // (last employee unassigned, schedule deleted, etc). If a planned
        // ride is still sitting there PENDING, it's now stale — cancel it
        // rather than leaving a driver-facing "route" with zero passengers.
        // A ride that's already live (STARTED+) is never touched here.
        if (existing && existing.status === "PENDING") {
          await prisma.ride.update({ where: { id: existing.id }, data: { status: "CANCELLED" } });
          await prisma.ridePassenger.deleteMany({ where: { rideId: existing.id } });
          await prisma.auditLog.create({
            data: {
              action: "PENDING_RIDE_CANCELLED_NO_SCHEDULE",
              model: "Ride",
              recordId: existing.id,
              after: { driverId, rideDate },
            },
          });
          results.push({ driverId, rideDate, cancelled: true });
        }
        continue;
      }

      if (existing && existing.status !== "PENDING") {
        // Already live or finished — never overwritten by a later
        // schedule edit.
        results.push({ driverId, rideDate, skipped: true, reason: `existing ride is ${existing.status}` });
        continue;
      }

      // All rows in this group share the same driver+trip/route by
      // construction (that's what byDriverTrip grouped on), so any one of
      // them is a valid source of truth for the ride's route/vehicle/timing.
      const primary = dayEligible[0];

      const ride = await prisma.$transaction(async (tx) => {
        const savedRide = existing
          ? await tx.ride.update({
              where: { id: existing.id },
              data: {
                routeId: primary.routeId,
                vehicleId: primary.vehicleId,
                vendorId: primary.vendorId,
                pickupTime: primary.pickupTime,
                dropTime: primary.dropTime,
                status: "PENDING",
              },
            })
          : await tx.ride.create({
              data: {
                rideDate,
                routeId: primary.routeId,
                driverId,
                vehicleId: primary.vehicleId,
                vendorId: primary.vendorId,
                pickupTime: primary.pickupTime,
                dropTime: primary.dropTime,
                status: "PENDING",
              },
            });

        // Rewrite the passenger list to match the current schedule rather
        // than diffing — simplest way to stay correct as dispatch adds,
        // removes, or reassigns employees before the ride goes live.
        await tx.ridePassenger.deleteMany({ where: { rideId: savedRide.id } });
        await tx.ridePassenger.createMany({
          data: dayEligible.map((s) => ({
            rideId: savedRide.id,
            employeeId: s.employeeId,
            address: s.employee.address,
            contact: s.employee.contactNumber,
            area: s.employee.area,
            subArea: s.employee.subArea,
          })),
        });

        return savedRide;
      });

      await prisma.auditLog.create({
        data: {
          action: existing ? "PENDING_RIDE_SYNCED_FROM_SCHEDULE" : "PENDING_RIDE_CREATED_FROM_SCHEDULE",
          model: "Ride",
          recordId: ride.id,
          after: { driverId, routeId: primary.routeId, rideDate, passengerCount: dayEligible.length },
        },
      });

      results.push({ driverId, rideDate, rideId: ride.id, passengerCount: dayEligible.length });
    }
  }

  return results;
}

/**
 * Thin wrapper for call sites that want "fire this, never let it fail the
 * request" without repeating the try/catch + console.warn boilerplate at
 * every one of the six write paths.
 */
async function syncPendingRidesForWeekBestEffort(weekStartDate) {
  try {
    return await syncPendingRidesForWeek(weekStartDate);
  } catch (syncError) {
    console.warn(`[ridePlanning] Failed to sync PENDING rides for week ${weekStartDate}: ${syncError.message}`);
    return null;
  }
}

module.exports = {
  syncPendingRidesForWeek,
  syncPendingRidesForWeekBestEffort,
};