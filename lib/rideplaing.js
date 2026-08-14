
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
  const schedules = await prisma.weeklySchedule.findMany({
    where: {
      weekStart: { gte: startOfDay(weekStartDate), lte: endOfDay(weekStartDate) },
      status: "ACTIVE",
      routeId: { not: null },
      driverId: { not: null },
      vehicleId: { not: null },
    },
    include: {
      employee: {
        select: { id: true, name: true, contactNumber: true, address: true, status: true },
      },
    },
  });

  const byDriver = new Map();
  for (const s of schedules) {
    if (!byDriver.has(s.driverId)) byDriver.set(s.driverId, []);
    byDriver.get(s.driverId).push(s);
  }

  const results = [];

  for (const [driverId, driverSchedules] of byDriver) {
    for (const dayKey of DAY_KEYS) {
      const dayEligible = driverSchedules.filter((s) => isEligibleForDay(s, dayKey));
      const rideDate = dateForDayInWeek(weekStartDate, dayKey);

      const existing = await prisma.ride.findFirst({
        where: {
          driverId,
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

      // All rows for this driver on this day are expected to share the
      // same route/vehicle/trip/timing; use the first as source of truth
      // (see the multi-trip-per-day caveat in the file header comment).
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