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
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
};

const endOfDay = (date) => {
  const d = new Date(date);
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
};

const dateForDayInWeek = (weekStartDate, dayKey) => {
  const offsetFromMonday = DAY_KEYS.indexOf(dayKey); // monday=0 ... sunday=6
  const d = new Date(weekStartDate);
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + offsetFromMonday,
    ),
  );
};

// Shared identity format used both to mark a ride as "current" while
// processing, and to match against when sweeping for stale PENDING rides
// left behind by an identity change (see syncPendingRidesForWeek's cleanup
// pass below for why that sweep exists).
const rideIdentityKey = (driverId, tripId, routeId, rideDate) => {
  const dateStr = rideDate.toISOString().slice(0, 10);
  return tripId
    ? `${driverId}::trip:${tripId}::${dateStr}`
    : `${driverId}::route:${routeId}::${dateStr}`;
};

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
 * BUG FIX (grouping key / duplicate-or-orphaned Ride rows):
 *
 * The old code grouped schedules by `${driverId}::${tripId || routeId}`,
 * then read the ride's routeId from `driverSchedules[0].routeId` (the FIRST
 * row in the whole group, "groupRouteId") while separately building the
 * ride's data payload from `dayEligible[0]` (the first row eligible on THIS
 * specific day, "primary"). If those two rows ever disagreed on routeId —
 * e.g. one schedule row drifted to a different route while sharing the same
 * tripId — the existing-Ride lookup and the upsert's `where` clause used one
 * routeId while the `create`/`update` data used another. That could silently
 * overwrite an existing Ride's routeId (orphaning it from future lookups,
 * so the next sync run created a DUPLICATE Ride for the same driver/day) or
 * write inconsistent data.
 *
 * Fix: every schedule considered for a given (driver, trip, day) ride now
 * has its routeId read directly off the same row used to build the ride
 * data (`primary`). We no longer read a separate "group-level" routeId at
 * all.
 *
 * BUG FIX (multi-trip-per-driver-per-day collapsing into one Ride):
 *
 * Ride identity used to be effectively (driverId, routeId, rideDate) only.
 * That's indistinguishable for two different trips run by the same driver,
 * on the same route, on the same day (a real scenario — e.g. a morning leg
 * and an evening leg). The old code would resolve BOTH trip-groups to the
 * SAME Ride row, and because each group's block does
 * `ridePassenger.deleteMany` + `createMany` for that ride, whichever
 * trip-group's loop iteration ran last would silently wipe out and replace
 * the other trip's passenger list — a silent passenger drop with no error
 * and no audit trail explaining it.
 *
 * Fix: Ride identity is now (driverId, tripId, rideDate) whenever a tripId
 * is available (the normal case), falling back to (driverId, routeId,
 * rideDate) only for legacy rows that predate Trips.
 *
 * SCHEMA STATUS: Ride now has `tripId` and a `ride_driver_trip_date_unique`
 * constraint on (driverId, tripId, rideDate) — see MIGRATION_NOTES.md and
 * prisma_migration/schema_ride_model.prisma. This file uses a real
 * `prisma.ride.upsert(...)` against that constraint for the normal
 * (tripId present) case, giving proper atomic, race-safe writes. Legacy
 * rows with no tripId fall back to a manual find-then-create/update against
 * (driverId, routeId, rideDate), because Postgres unique constraints don't
 * dedupe across multiple NULLs — see the caveat in schema_ride_model.prisma
 * for why, and ride_legacy_partial_unique.sql if you want that path fully
 * race-safe too.
 */

async function syncPendingRidesForWeek(weekStartDate) {
  console.log("weekStartDate", weekStartDate);

  await prisma.$queryRaw`SELECT 1`;

  const schedules = await prisma.weeklySchedule.findMany({
    where: {
      weekStart: {
        gte: startOfDay(weekStartDate),
        lte: endOfDay(weekStartDate),
      },
      status: "ACTIVE",
      routeId: { not: null },
      OR: [
        { driverId: { not: null }, vehicleId: { not: null } },
        { tripId: { not: null } },
      ],
    },
    include: {
      employee: {
        select: {
          id: true,
          name: true,
          contactNumber: true,
          address: true,
          status: true,
          area: true,
          subArea: true,
        },
      },
      trip: {
        select: { driverId: true, vehicleId: true },
      },
      route: {
        select: { areaId: true, subAreaId: true },
      },
    },
  });

  const resolved = schedules
    .map((s) => ({
      ...s,
      driverId: s.driverId ?? s.trip?.driverId ?? null,
      vehicleId: s.vehicleId ?? s.trip?.vehicleId ?? null,
    }))
    .filter((s) => s.driverId && s.vehicleId);

  // Group by (driver, trip) so two different trips run by the same driver
  // on the same day never merge. Rows without a tripId (legacy, pre-Trip
  // data) fall back to grouping by route instead.
  const groupKey = (s) => `${s.driverId}::${s.tripId || `route:${s.routeId}`}`;

  // Tracks every (driver, tripId-or-routeId, day) identity this run
  // actually confirmed as current/valid, so the stale-ride sweep at the
  // end (see below) knows which PENDING rides to leave alone vs. cancel.
  const currentRideIdentityKeys = new Set();

  const byDriverTrip = new Map();
  for (const s of resolved) {
    const key = groupKey(s);
    if (!byDriverTrip.has(key)) byDriverTrip.set(key, []);
    byDriverTrip.get(key).push(s);
  }

  const results = [];

  for (const driverSchedules of byDriverTrip.values()) {
    const driverId = driverSchedules[0].driverId;
    const groupTripId = driverSchedules[0].tripId || null;

    for (const dayKey of DAY_KEYS) {
      const dayEligible = driverSchedules.filter((s) =>
        isEligibleForDay(s, dayKey),
      );
      const rideDate = dateForDayInWeek(weekStartDate, dayKey);

      // Identify the ride by (driverId, tripId, rideDate) when we have a
      // tripId — this is what actually distinguishes two trips a driver
      // runs on the same route/day. Only fall back to routeId when there's
      // no trip at all (legacy rows).
      const rideIdentity = groupTripId
        ? { driverId, tripId: groupTripId, rideDate: { gte: startOfDay(rideDate), lte: endOfDay(rideDate) } }
        : { driverId, routeId: driverSchedules[0].routeId, tripId: null, rideDate: { gte: startOfDay(rideDate), lte: endOfDay(rideDate) } };

      const existing = await prisma.ride.findFirst({ where: rideIdentity });

      if (dayEligible.length === 0) {
        if (existing && existing.status === "PENDING") {
          await prisma.ride.update({
            where: { id: existing.id },
            data: { status: "CANCELLED" },
          });
          await prisma.ridePassenger.deleteMany({
            where: { rideId: existing.id },
          });
          await prisma.auditLog.create({
            data: {
              action: "PENDING_RIDE_CANCELLED_NO_SCHEDULE",
              model: "Ride",
              recordId: existing.id,
              after: { driverId, tripId: groupTripId, rideDate },
            },
          });
          results.push({ driverId, tripId: groupTripId, rideDate, cancelled: true });
        }
        continue;
      }

      if (existing && existing.status !== "PENDING") {
        results.push({
          driverId,
          tripId: groupTripId,
          rideDate,
          skipped: true,
          reason: `existing ride is ${existing.status}`,
        });
        continue;
      }

      // `primary` is the single source of truth for this ride's routeId /
      // vehicleId / vendorId / timing — never mix in a routeId read from
      // elsewhere in the group (that was the root cause of the old
      // groupRouteId/primary mismatch bug).
      const primary = dayEligible[0];
      const primaryRouteId = primary.routeId;

      const areaId = primary.route?.areaId ?? primary.employee.area?.id ?? null;
      const subAreaId =
        primary.route?.subAreaId ?? primary.employee.subArea?.id ?? null;

      const distinctEmployeeAreaIds = new Set(
        dayEligible.map((s) => s.employee.area?.id).filter(Boolean),
      );
      if (distinctEmployeeAreaIds.size > 1) {
        console.warn(
          `[ridePlanning] driver ${driverId} route ${primaryRouteId} on ` +
            `${rideDate.toISOString().slice(0, 10)} has eligible passengers spanning ` +
            `${distinctEmployeeAreaIds.size} different home areas; recording ` +
            `Ride.areaId=${areaId} (source: ${primary.route?.areaId ? "route" : "primary passenger"}).`,
        );
      }

      // Sanity check: warn (don't silently overwrite) if rows in this
      // driver/trip group actually disagree on routeId — that indicates
      // upstream data drift (e.g. a partial reassignment) that should be
      // fixed at the schedule level, not papered over here.
      const distinctRouteIds = new Set(dayEligible.map((s) => s.routeId));
      if (distinctRouteIds.size > 1) {
        console.warn(
          `[ridePlanning] driver ${driverId} trip ${groupTripId} on ` +
            `${rideDate.toISOString().slice(0, 10)} has eligible schedule rows pointing ` +
            `at ${distinctRouteIds.size} different routeIds; using routeId=${primaryRouteId} ` +
            `from the first eligible row. This usually means a reassignment didn't fully propagate.`,
        );
      }

      const ride = await prisma.$transaction(
        async (tx) => {
          const rideData = {
            routeId: primaryRouteId,
            tripId: groupTripId,
            vehicleId: primary.vehicleId,
            vendorId: primary.vendorId,
            areaId,
            subAreaId,
            pickupTime: primary.pickupTime,
            dropTime: primary.dropTime,
            status: "PENDING",
          };

          let savedRide;
          if (groupTripId) {
            // Normal case: atomic upsert against the real DB constraint.
            savedRide = await tx.ride.upsert({
              where: {
                ride_driver_trip_date_unique: {
                  driverId,
                  tripId: groupTripId,
                  rideDate,
                },
              },
              update: rideData,
              create: { rideDate, driverId, ...rideData },
            });
          } else {
            // Legacy rows with no tripId: no full DB uniqueness across
            // NULLs (see schema_ride_model.prisma caveat), so this stays a
            // manual find-then-write against (driverId, routeId, rideDate)
            // unless you've also applied ride_legacy_partial_unique.sql.
            const current = await tx.ride.findFirst({ where: rideIdentity });
            savedRide = current
              ? await tx.ride.update({ where: { id: current.id }, data: rideData })
              : await tx.ride.create({ data: { rideDate, driverId, ...rideData } });
          }

          await tx.ridePassenger.deleteMany({
            where: { rideId: savedRide.id },
          });
          await tx.ridePassenger.createMany({
            data: dayEligible.map((s) => ({
              rideId: savedRide.id,
              employeeId: s.employeeId,
              employeeName: s.employee.name,
              address: s.employee.address,
              contact: s.employee.contactNumber,
              area: s.employee.area?.name ?? null,
              subArea: s.employee.subArea?.name ?? null,
            })),
          });

          return savedRide;
        },
        {
          maxWait: 10000,
          timeout: 20000,
        },
      );

      await prisma.auditLog.create({
        data: {
          action: existing
            ? "PENDING_RIDE_SYNCED_FROM_SCHEDULE"
            : "PENDING_RIDE_CREATED_FROM_SCHEDULE",
          model: "Ride",
          recordId: ride.id,
          after: {
            driverId,
            tripId: groupTripId,
            routeId: primaryRouteId,
            rideDate,
            passengerCount: dayEligible.length,
          },
        },
      });

      currentRideIdentityKeys.add(
        rideIdentityKey(driverId, groupTripId, primaryRouteId, rideDate),
      );

      results.push({
        driverId,
        tripId: groupTripId,
        rideDate,
        rideId: ride.id,
        passengerCount: dayEligible.length,
      });
    }
  }

  // BUG FIX (orphaned/duplicate PENDING rides after a tripId change):
  //
  // When a schedule row's tripId changes — e.g. optimizeWeekAssignments
  // backfills a tripId onto a legacy row, or a reassignment moves an
  // employee to a different trip — its ride identity changes too (identity
  // is (driverId, tripId, rideDate), or (driverId, routeId, rideDate) for
  // legacy tripId-null rows). The loop above only ever cancels a ride
  // within its OWN group when that group's dayEligible list empties out.
  // It has no way to notice "this driver+tripId combination doesn't exist
  // in this week's schedules AT ALL anymore" — so a ride created under an
  // old identity just sits there, forever PENDING. Repeated across sync
  // runs, this is exactly the kind of thing that turns "300 rides" into
  // "1500+ rides" for a route whose driver/trip assignments keep getting
  // backfilled/reshuffled.
  //
  // SCOPING THIS CAREFULLY (this is the part worth reading before trusting
  // it in production):
  //   - Scoping the sweep to "drivers currently in `resolved`" would miss
  //     a driver who's been pulled off the week's roster ENTIRELY (every
  //     WeeklySchedule row for them deleted/deactivated) — their orphaned
  //     ride would never get swept, since they'd never appear in any group
  //     this run.
  //   - But dropping that scoping and just sweeping every PENDING ride in
  //     the week's date range is dangerous in the other direction: it would
  //     also cancel any PENDING ride that came from some OTHER flow this
  //     file doesn't know about (a manual dispatcher-created ride, an
  //     admin override, anything not generated by this sync function) —
  //     I haven't seen the rest of the codebase, so I can't rule that out.
  //
  // Resolution: only ever touch a ride that has AUDIT-LOG PROOF this exact
  // sync function created or last synced it (the
  // PENDING_RIDE_CREATED_FROM_SCHEDULE / PENDING_RIDE_SYNCED_FROM_SCHEDULE
  // actions logged above). That's a strictly narrower, safer condition than
  // "driver still has a schedule this week" — it correctly reaches a fully
  // removed driver's orphaned ride, while never touching a ride this
  // function didn't itself create.
  //
  // RECOMMENDATION: the first time this runs against real data, log
  // `results.filter(r => r.cancelledStale)` and eyeball it (or run once
  // with the two `prisma.ride.update`/`ridePassenger.deleteMany` calls
  // below commented out, so it only reports candidates) before trusting it
  // to auto-cancel in production — I've reasoned through this carefully but
  // haven't run it against your actual data.
  const weekDates = DAY_KEYS.map((dayKey) => dateForDayInWeek(weekStartDate, dayKey));
  const weekRangeStart = startOfDay(weekDates[0]);
  const weekRangeEnd = endOfDay(weekDates[weekDates.length - 1]);

  const candidatePendingRides = await prisma.ride.findMany({
    where: {
      rideDate: { gte: weekRangeStart, lte: weekRangeEnd },
      status: "PENDING",
    },
  });

  if (candidatePendingRides.length) {
    const syncCreatedLogs = await prisma.auditLog.findMany({
      where: {
        model: "Ride",
        recordId: { in: candidatePendingRides.map((r) => r.id) },
        action: {
          in: [
            "PENDING_RIDE_CREATED_FROM_SCHEDULE",
            "PENDING_RIDE_SYNCED_FROM_SCHEDULE",
          ],
        },
      },
      select: { recordId: true },
      distinct: ["recordId"],
    });
    const syncManagedRideIds = new Set(syncCreatedLogs.map((l) => l.recordId));

    for (const staleRide of candidatePendingRides) {
      if (!syncManagedRideIds.has(staleRide.id)) continue; // never created by this function — don't touch it

      const key = rideIdentityKey(
        staleRide.driverId,
        staleRide.tripId,
        staleRide.routeId,
        staleRide.rideDate,
      );
      if (currentRideIdentityKeys.has(key)) continue; // still valid, leave it

      await prisma.ride.update({
        where: { id: staleRide.id },
        data: { status: "CANCELLED" },
      });
      await prisma.ridePassenger.deleteMany({
        where: { rideId: staleRide.id },
      });
      await prisma.auditLog.create({
        data: {
          action: "PENDING_RIDE_CANCELLED_STALE_IDENTITY",
          model: "Ride",
          recordId: staleRide.id,
          after: {
            driverId: staleRide.driverId,
            tripId: staleRide.tripId,
            routeId: staleRide.routeId,
            rideDate: staleRide.rideDate,
          },
        },
      });
      results.push({
        driverId: staleRide.driverId,
        rideDate: staleRide.rideDate,
        cancelledStale: true,
      });
    }
  }

  return results;
}

async function syncPendingRidesForWeekBestEffort(weekStartDate) {
  try {
    return await syncPendingRidesForWeek(weekStartDate);
  } catch (syncError) {
    console.warn(
      `[ridePlanning] Failed to sync PENDING rides for week ${weekStartDate}: ${syncError.message}`,
    );
    return null;
  }
}

module.exports = {
  syncPendingRidesForWeek,
  syncPendingRidesForWeekBestEffort,
};