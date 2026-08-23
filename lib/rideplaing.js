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

const CHUNK_SIZE = 200; // rows per createMany/audit-log batch (single-query, no per-item txn overhead)

// Ride writes (upsert/update/create) each cost a real round trip, so
// packing too many into one $transaction([...]) can blow past Prisma's
// default 5s interactive/array transaction timeout well before it's
// actually "slow" in absolute terms (200 ops * ~25-30ms each ≈ 5-6s).
// Keep these batches small AND run several of them concurrently (bounded
// by your DB connection pool) for real throughput, with an explicit
// timeout that has headroom instead of relying on the 5s default.
const WRITE_CHUNK_SIZE = 40;
const WRITE_CONCURRENCY = 4; // stay well under your pg pool size
const TX_OPTIONS = { maxWait: 10000, timeout: 20000 };

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Splits `ops` (an array of not-yet-awaited Prisma Client calls) into
// small transactional batches and runs up to `concurrency` of those
// batches at once. Promise.all preserves array order regardless of which
// batch finishes first, and chunk() preserves item order within each
// batch, so the returned array lines up 1:1 with the input `ops` order.
async function runChunkedTransactions(
  ops,
  { chunkSize = WRITE_CHUNK_SIZE, concurrency = WRITE_CONCURRENCY } = {},
) {
  const chunks = chunk(ops, chunkSize);
  const out = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const window = chunks.slice(i, i + concurrency);
    const windowResults = await Promise.all(
      window.map((c) => prisma.$transaction(c, TX_OPTIONS)),
    );
    for (const r of windowResults) out.push(...r);
  }
  return out;
}

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
  const offsetFromMonday = DAY_KEYS.indexOf(dayKey);
  const d = new Date(weekStartDate);
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + offsetFromMonday,
    ),
  );
};

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

const PASSENGER_SNAPSHOT_FIELDS = [
  "employeeName",
  "address",
  "contact",
  "area",
  "subArea",
];

function buildSnapshot(scheduleRow) {
  return {
    employeeName: scheduleRow.employee.name,
    address: scheduleRow.employee.address,
    contact: scheduleRow.employee.contactNumber,
    area: scheduleRow.employee.area?.name ?? null,
    subArea: scheduleRow.employee.subArea?.name ?? null,
  };
}

function snapshotChanged(existingPassenger, snapshot) {
  return PASSENGER_SNAPSHOT_FIELDS.some(
    (field) => existingPassenger[field] !== snapshot[field],
  );
}

/**
 * Rewrite of syncPendingRidesForWeek. Behaviour is the same as before
 * (same eligibility rules, same ride identity rules, same stale-sweep
 * safety net) but the *execution strategy* changes in three ways:
 *
 * 1. PASSENGER DIFFING INSTEAD OF DELETE+RECREATE
 *    The old code did `ridePassenger.deleteMany` + `createMany` for every
 *    ride, every run — which meant any employee who had already confirmed
 *    their pickup (RidePassenger.confirmationStatus / confirmedAt) had that
 *    state silently destroyed and replaced with a fresh PENDING row on the
 *    very next sync. Now we diff desired vs. existing passengers per ride:
 *    only truly new employees get inserted, only truly dropped employees
 *    get deleted, and existing rows are left untouched unless their
 *    snapshot fields (name/address/contact/area) actually changed — and
 *    even then we only touch the snapshot fields, never confirmationStatus.
 *
 * 2. DETERMINISTIC "PRIMARY" SELECTION
 *    The old code picked `dayEligible[0]` as the source of truth for a
 *    ride's routeId/timing/area, relying on whatever order Postgres
 *    happened to return rows in (no ORDER BY = no guarantee). That could
 *    make ride metadata flip-flop between runs with no underlying data
 *    change. We now sort each day's eligible schedules by employeeId
 *    before picking [0], so "primary" is stable run to run.
 *
 * 3. BULK QUERIES + BATCHED WRITES INSTEAD OF PER-GROUP-PER-DAY ROUND TRIPS
 *    The old code ran, per (driver, trip, day) — i.e. up to
 *    (#trips * 7) times — a findFirst, then a whole interactive
 *    transaction (its own BEGIN/COMMIT) with an upsert/find + delete +
 *    createMany, then a separate audit log insert. For a few hundred
 *    trips that's thousands of sequential round trips. Now: existing
 *    Rides and RidePassengers for the week are loaded in two queries up
 *    front, all ride writes are computed as plain data first and then
 *    submitted in chunked `$transaction([...])` batches (so we still get
 *    atomicity per batch without paying per-item transaction overhead),
 *    and audit logs are inserted via `createMany`.
 *
 * 4. LEGACY-RIDE MIGRATION ON tripId BACKFILL
 *    When a schedule row gains a tripId it didn't have before (e.g. a
 *    trip-assignment pass runs after rides were already created under the
 *    route-only identity), the ride's identity changes from
 *    (driverId, routeId, date) to (driverId, tripId, date). The old code
 *    treated that as an unrelated identity: it created a brand new ride
 *    under the new identity and left the old one to be caught — and
 *    cancelled, passengers wiped — by the stale-identity sweep. Same
 *    driver/route/day, two rows, one of them a cancelled, passenger-less
 *    husk. We now check for a still-PENDING legacy ride under the old
 *    identity first and, if found, update it in place (same id, same
 *    passengers) instead of orphaning + duplicating it.
 *
 * CONCURRENCY NOTE: because existing Ride/RidePassenger state is now read
 * once up front rather than re-checked immediately before each write,
 * this function assumes it is not run concurrently with itself for the
 * same week (true of a cron/scheduled sync). If you need concurrent-safe
 * behaviour too, keep the tripId-based `ride.upsert` path (still race-safe
 * against the DB constraint) and add the partial unique index for the
 * legacy no-tripId path mentioned in the original comments.
 */
async function syncPendingRidesForWeek(weekStartDate) {
  console.log("weekStartDate", weekStartDate);

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
    orderBy: [{ employeeId: "asc" }], // belt-and-suspenders; real determinism enforced below
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
      trip: { select: { driverId: true, vehicleId: true } },
      route: { select: { areaId: true, subAreaId: true } },
    },
  });

  const resolved = schedules
    .map((s) => ({
      ...s,
      driverId: s.driverId ?? s.trip?.driverId ?? null,
      vehicleId: s.vehicleId ?? s.trip?.vehicleId ?? null,
    }))
    .filter((s) => s.driverId && s.vehicleId);

  const groupKey = (s) => `${s.driverId}::${s.tripId || `route:${s.routeId}`}`;

  const byDriverTrip = new Map();
  for (const s of resolved) {
    const key = groupKey(s);
    if (!byDriverTrip.has(key)) byDriverTrip.set(key, []);
    byDriverTrip.get(key).push(s);
  }

  const weekDates = DAY_KEYS.map((dayKey) =>
    dateForDayInWeek(weekStartDate, dayKey),
  );
  const weekRangeStart = startOfDay(weekDates[0]);
  const weekRangeEnd = endOfDay(weekDates[weekDates.length - 1]);

  // ---- Bulk-preload existing Ride + RidePassenger state for the week ----
  const driverIds = [...new Set(resolved.map((s) => s.driverId))];

  const existingRides = driverIds.length
    ? await prisma.ride.findMany({
        where: {
          driverId: { in: driverIds },
          rideDate: { gte: weekRangeStart, lte: weekRangeEnd },
        },
      })
    : [];

  const existingByIdentity = new Map();
  for (const r of existingRides) {
    existingByIdentity.set(
      rideIdentityKey(r.driverId, r.tripId, r.routeId, r.rideDate),
      r,
    );
  }

  // Legacy (pre-Trip) rides that a newly trip-aware schedule row can be
  // migrated onto IN PLACE, instead of being treated as an unrelated
  // identity change. Without this, backfilling a tripId onto a schedule
  // orphans the old (driverId, routeId, date) ride — it gets cancelled and
  // its passengers wiped by the stale sweep below — while a brand new
  // ride + passenger set is created alongside it under the new
  // (driverId, tripId, date) identity. Same driver, same route, same day,
  // but two rows: one a passenger-less CANCELLED husk. Migrating in place
  // means the SAME row just gains a tripId — no delete, no duplicate.
  const legacyByDriverRouteDate = new Map();
  for (const r of existingRides) {
    if (r.tripId) continue;
    const dateStr = r.rideDate.toISOString().slice(0, 10);
    legacyByDriverRouteDate.set(`${r.driverId}::${r.routeId}::${dateStr}`, r);
  }
  const claimedLegacyRideIds = new Set();

  const existingRideIds = existingRides.map((r) => r.id);
  const existingPassengerRows = existingRideIds.length
    ? await prisma.ridePassenger.findMany({
        where: { rideId: { in: existingRideIds } },
      })
    : [];

  const existingPassengersByRide = new Map();
  for (const p of existingPassengerRows) {
    if (!existingPassengersByRide.has(p.rideId)) {
      existingPassengersByRide.set(p.rideId, new Map());
    }
    existingPassengersByRide.get(p.rideId).set(p.employeeId, p);
  }

  // ---- Walk groups x days, building write plans (no DB calls here) ----
  const cancelNoScheduleRides = []; // Ride rows to cancel because nobody's eligible today
  const rideWritePlans = []; // { driverId, tripId, routeId, rideDate, rideData, existingRideId, dayEligible }
  const results = [];
  const currentRideIdentityKeys = new Set();

  for (const driverSchedules of byDriverTrip.values()) {
    const driverId = driverSchedules[0].driverId;
    const groupTripId = driverSchedules[0].tripId || null;
    const groupRouteId = driverSchedules[0].routeId; // only used for legacy (no-trip) identity

    for (const dayKey of DAY_KEYS) {
      const dayEligible = driverSchedules
        .filter((s) => isEligibleForDay(s, dayKey))
        .sort((a, b) => a.employeeId.localeCompare(b.employeeId));

      const rideDate = dateForDayInWeek(weekStartDate, dayKey);
      const key = rideIdentityKey(
        driverId,
        groupTripId,
        groupRouteId,
        rideDate,
      );
      const existing = existingByIdentity.get(key) || null;

      if (dayEligible.length === 0) {
        if (existing && existing.status === "PENDING") {
          cancelNoScheduleRides.push(existing);
          results.push({
            driverId,
            tripId: groupTripId,
            rideDate,
            cancelled: true,
          });
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

      const distinctRouteIds = new Set(dayEligible.map((s) => s.routeId));
      if (distinctRouteIds.size > 1) {
        console.warn(
          `[ridePlanning] driver ${driverId} trip ${groupTripId} on ` +
            `${rideDate.toISOString().slice(0, 10)} has eligible schedule rows pointing ` +
            `at ${distinctRouteIds.size} different routeIds; using routeId=${primaryRouteId} ` +
            `from the (deterministically) first eligible row.`,
        );
      }

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

      // If there's no ride under the new (trip-based) identity yet, check
      // for a still-PENDING legacy ride under the old (route-based)
      // identity for this same driver/route/day before creating a new
      // row — migrate onto it instead so the id, and its passengers'
      // confirmation state, carry over untouched.
      let targetRideId = existing ? existing.id : null;
      let migrated = false;
      if (!targetRideId && groupTripId) {
        const dateStr = rideDate.toISOString().slice(0, 10);
        const legacyRide = legacyByDriverRouteDate.get(
          `${driverId}::${primaryRouteId}::${dateStr}`,
        );
        if (
          legacyRide &&
          legacyRide.status === "PENDING" &&
          !claimedLegacyRideIds.has(legacyRide.id)
        ) {
          targetRideId = legacyRide.id;
          migrated = true;
          claimedLegacyRideIds.add(legacyRide.id);
        }
      }

      rideWritePlans.push({
        driverId,
        tripId: groupTripId,
        routeId: primaryRouteId,
        rideDate,
        rideData,
        existingRideId: targetRideId,
        migrated,
        dayEligible,
      });

      currentRideIdentityKeys.add(key);
    }
  }

  // ---- Batch-write Ride rows, capturing back real rows (with ids) ----
  const rideOps = rideWritePlans.map((plan) => {
    if (plan.existingRideId) {
      return prisma.ride.update({
        where: { id: plan.existingRideId },
        data: plan.rideData,
      });
    }
    if (plan.tripId) {
      return prisma.ride.upsert({
        where: {
          ride_driver_trip_date_unique: {
            driverId: plan.driverId,
            tripId: plan.tripId,
            rideDate: plan.rideDate,
          },
        },
        update: plan.rideData,
        create: {
          rideDate: plan.rideDate,
          driverId: plan.driverId,
          ...plan.rideData,
        },
      });
    }
    // Legacy no-tripId row with nothing found in preload. Small residual
    // race window vs. concurrent runs — see CONCURRENCY NOTE above.
    return prisma.ride.create({
      data: {
        rideDate: plan.rideDate,
        driverId: plan.driverId,
        ...plan.rideData,
      },
    });
  });
  const savedRides = await runChunkedTransactions(rideOps);

  // ---- Diff + batch passenger writes, batch audit logs ----
  const passengerDeleteOps = [];
  const passengerUpdateOps = [];
  const passengerCreateData = [];
  const auditLogEntries = [];

  rideWritePlans.forEach((plan, i) => {
    const savedRide = savedRides[i];
    const existingMap =
      existingPassengersByRide.get(plan.existingRideId) || new Map();
    const desiredIds = new Set(plan.dayEligible.map((s) => s.employeeId));

    const toRemoveIds = [...existingMap.keys()].filter(
      (id) => !desiredIds.has(id),
    );
    if (toRemoveIds.length) {
      passengerDeleteOps.push(
        prisma.ridePassenger.deleteMany({
          where: { rideId: savedRide.id, employeeId: { in: toRemoveIds } },
        }),
      );
    }

    for (const s of plan.dayEligible) {
      const snapshot = buildSnapshot(s);
      const existingPassenger = existingMap.get(s.employeeId);

      if (!existingPassenger) {
        passengerCreateData.push({
          rideId: savedRide.id,
          employeeId: s.employeeId,
          ...snapshot,
        });
      } else if (snapshotChanged(existingPassenger, snapshot)) {
        // Only the display/contact snapshot changes here — confirmationStatus
        // and confirmedAt are never touched, so a rider's confirm survives.
        passengerUpdateOps.push(
          prisma.ridePassenger.update({
            where: { id: existingPassenger.id },
            data: snapshot,
          }),
        );
      }
    }

    auditLogEntries.push({
      action: plan.migrated
        ? "PENDING_RIDE_MIGRATED_TRIP_ASSIGNED"
        : plan.existingRideId
          ? "PENDING_RIDE_SYNCED_FROM_SCHEDULE"
          : "PENDING_RIDE_CREATED_FROM_SCHEDULE",
      model: "Ride",
      recordId: savedRide.id,
      after: {
        driverId: plan.driverId,
        tripId: plan.tripId,
        routeId: plan.routeId,
        rideDate: plan.rideDate,
        passengerCount: plan.dayEligible.length,
      },
    });

    results.push({
      driverId: plan.driverId,
      tripId: plan.tripId,
      rideDate: plan.rideDate,
      rideId: savedRide.id,
      passengerCount: plan.dayEligible.length,
    });
  });

  // ---- Batch-cancel rides with no schedule left ----
  if (cancelNoScheduleRides.length) {
    const ids = cancelNoScheduleRides.map((r) => r.id);
    await prisma.ride.updateMany({
      where: { id: { in: ids } },
      data: { status: "CANCELLED" },
    });
    passengerDeleteOps.push(
      prisma.ridePassenger.deleteMany({ where: { rideId: { in: ids } } }),
    );
    for (const r of cancelNoScheduleRides) {
      auditLogEntries.push({
        action: "PENDING_RIDE_CANCELLED_NO_SCHEDULE",
        model: "Ride",
        recordId: r.id,
        after: { driverId: r.driverId, tripId: r.tripId, rideDate: r.rideDate },
      });
    }
  }

  if (passengerDeleteOps.length)
    await runChunkedTransactions(passengerDeleteOps);
  if (passengerUpdateOps.length)
    await runChunkedTransactions(passengerUpdateOps);
  for (const c of chunk(passengerCreateData, 500))
    await prisma.ridePassenger.createMany({ data: c });
  for (const c of chunk(auditLogEntries, 500))
    await prisma.auditLog.createMany({ data: c });

  // ---- Stale-identity sweep (same safety condition as before: only ----
  // ---- touch rides this function itself created/synced, per audit log) ----
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
            "PENDING_RIDE_MIGRATED_TRIP_ASSIGNED",
          ],
        },
      },
      select: { recordId: true },
      distinct: ["recordId"],
    });
    const syncManagedRideIds = new Set(syncCreatedLogs.map((l) => l.recordId));

    const staleRides = candidatePendingRides.filter((r) => {
      if (!syncManagedRideIds.has(r.id)) return false;
      const key = rideIdentityKey(r.driverId, r.tripId, r.routeId, r.rideDate);
      return !currentRideIdentityKeys.has(key);
    });

    if (staleRides.length) {
      const staleIds = staleRides.map((r) => r.id);
      await prisma.ride.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "CANCELLED" },
      });
      await prisma.ridePassenger.deleteMany({
        where: { rideId: { in: staleIds } },
      });

      const staleAuditEntries = staleRides.map((r) => ({
        action: "PENDING_RIDE_CANCELLED_STALE_IDENTITY",
        model: "Ride",
        recordId: r.id,
        after: {
          driverId: r.driverId,
          tripId: r.tripId,
          routeId: r.routeId,
          rideDate: r.rideDate,
        },
      }));
      for (const c of chunk(staleAuditEntries, 500))
        await prisma.auditLog.createMany({ data: c });

      for (const r of staleRides) {
        results.push({
          driverId: r.driverId,
          rideDate: r.rideDate,
          cancelledStale: true,
        });
      }
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
