const { prisma } = require("../lib/prisma");

const {
  notifyEmployeeScheduleUpdatedBestEffort,
} = require("./rideNotifications");

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const WRITE_CHUNK_SIZE = 40;
const WRITE_CONCURRENCY = 4;
const TX_OPTIONS = { maxWait: 10000, timeout: 20000 };

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

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

function extractTimeOfDay(value) {
  if (!value) return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return {
      hours: value.getUTCHours(),
      minutes: value.getUTCMinutes(),
    };
  }

  if (typeof value === "string") {
    const cleaned = value.trim();
    const match = cleaned.match(/^(\d{1,2}):?(\d{2})?\s*(AM|PM)?$/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = match[2] ? parseInt(match[2], 10) : 0;
      const meridiem = match[3] ? match[3].toUpperCase() : null;

      if (meridiem === "PM" && hours < 12) hours += 12;
      if (meridiem === "AM" && hours === 12) hours = 0;

      return { hours, minutes };
    }

    try {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return {
          hours: date.getUTCHours(),
          minutes: date.getUTCMinutes(),
        };
      }
    } catch (_) {}
  }

  return null;
}

function constructTimeDate(timeValue, baseDate) {
  const time = extractTimeOfDay(timeValue);
  if (!time) return null;

  const result = new Date(baseDate);
  result.setUTCHours(time.hours, time.minutes, 0, 0);
  return result;
}

function formatTimeForLog(value) {
  if (!value) return null;
  try {
    if (value instanceof Date && !isNaN(value.getTime())) {
      return value.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Karachi",
      });
    }
    if (typeof value === "string") return value;
  } catch (_) {}
  return String(value);
}

async function syncPendingRidesForWeek(weekStartDate, scope = {}) {
  const toArray = (v) =>
    v == null ? [] : Array.isArray(v) ? v.filter((x) => x != null) : [v];
  const scopeDriverIds = toArray(scope.driverId ?? scope.driverIds);
  const scopeTripIds = toArray(scope.tripId ?? scope.tripIds);
  const scopeRouteIds = toArray(scope.routeId ?? scope.routeIds);
  const isScoped =
    scopeDriverIds.length || scopeTripIds.length || scopeRouteIds.length;

  console.log("weekStartDate", weekStartDate, "scope", scope);

  const schedules = await prisma.weeklySchedule.findMany({
    where: {
      weekStart: {
        gte: startOfDay(weekStartDate),
        lte: endOfDay(weekStartDate),
      },
      status: "ACTIVE",
      routeId: { not: null },
      AND: [
        {
          OR: [
            { driverId: { not: null }, vehicleId: { not: null } },
            { tripId: { not: null } },
          ],
        },
        ...(isScoped
          ? [
              {
                OR: [
                  ...(scopeDriverIds.length
                    ? [{ driverId: { in: scopeDriverIds } }]
                    : []),
                  ...(scopeTripIds.length
                    ? [{ tripId: { in: scopeTripIds } }]
                    : []),
                  ...(scopeRouteIds.length
                    ? [{ routeId: { in: scopeRouteIds } }]
                    : []),
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ employeeId: "asc" }],
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

  console.log(`[rideSync] Found ${schedules.length} schedules to process`);

  const resolved = schedules
    .map((s) => ({
      ...s,
      driverId: s.driverId ?? s.trip?.driverId ?? null,
      vehicleId: s.vehicleId ?? s.trip?.vehicleId ?? null,
    }))
    .filter((s) => s.driverId && s.vehicleId);

  console.log(`[rideSync] ${resolved.length} schedules have driver+vehicle`);

  const groupKey = (s) => `${s.driverId}::${s.tripId || `route:${s.routeId}`}`;

  const byDriverTrip = new Map();
  for (const s of resolved) {
    const key = groupKey(s);
    if (!byDriverTrip.has(key)) byDriverTrip.set(key, []);
    byDriverTrip.get(key).push(s);
  }

  console.log(`[rideSync] ${byDriverTrip.size} driver-trip groups`);

  const weekDates = DAY_KEYS.map((dayKey) =>
    dateForDayInWeek(weekStartDate, dayKey),
  );
  const weekRangeStart = startOfDay(weekDates[0]);
  const weekRangeEnd = endOfDay(weekDates[weekDates.length - 1]);

  const driverIds = [...new Set(resolved.map((s) => s.driverId))];

  const existingRides = driverIds.length
    ? await prisma.ride.findMany({
        where: {
          driverId: { in: driverIds },
          rideDate: { gte: weekRangeStart, lte: weekRangeEnd },
        },
      })
    : [];

  console.log(`[rideSync] Found ${existingRides.length} existing rides`);

  const existingByIdentity = new Map();
  for (const r of existingRides) {
    existingByIdentity.set(
      rideIdentityKey(r.driverId, r.tripId, r.routeId, r.rideDate),
      r,
    );
  }

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

  console.log(`[rideSync] Found ${existingPassengerRows.length} existing passengers`);

  const existingPassengersByRide = new Map();
  for (const p of existingPassengerRows) {
    if (!existingPassengersByRide.has(p.rideId)) {
      existingPassengersByRide.set(p.rideId, new Map());
    }
    existingPassengersByRide.get(p.rideId).set(p.employeeId, p);
  }

  const cancelNoScheduleRides = [];
  const rideWritePlans = [];
  const results = [];
  const currentRideIdentityKeys = new Set();
  // Kept separate (not merged) so we can send exactly ONE notification per
  // employee and ONE per driver for the whole week, instead of one per
  // ride/day (a schedule can touch the same person up to 7 times/week).
  const affectedEmployeeIds = new Set();
  const affectedDriverIds = new Set();

  for (const driverSchedules of byDriverTrip.values()) {
    const driverId = driverSchedules[0].driverId;
    const groupTripId = driverSchedules[0].tripId || null;
    const groupRouteId = driverSchedules[0].routeId;

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
          console.log(`[rideSync] CANCELLING ride ${existing.id} - no schedule for ${dayKey}`);
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
        console.log(`[rideSync] SKIPPING ride ${existing.id} - status is ${existing.status}`);
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

      const pickupTime = constructTimeDate(primary.pickupTime, rideDate);
      const officeArrivalTime = constructTimeDate(
        primary.officeArrivalTime,
        rideDate,
      );
      const dropTime = constructTimeDate(primary.dropTime, rideDate);

      const pickupStr = formatTimeForLog(primary.pickupTime);
      const officeArrivalStr = formatTimeForLog(primary.officeArrivalTime);
      const dropStr = formatTimeForLog(primary.dropTime);

      const rideData = {
        routeId: primaryRouteId,
        tripId: groupTripId,
        vehicleId: primary.vehicleId,
        vendorId: primary.vendorId,
        areaId,
        subAreaId,
        pickupTime,
        officeArrivalTime,
        dropTime,
        status: "PENDING",
      };

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
          console.log(`[rideSync] MIGRATING legacy ride ${legacyRide.id} to trip ${groupTripId}`);
        }
      }

      const action = targetRideId ? (migrated ? "MIGRATED" : "UPDATED") : "CREATED";
      console.log(`[rideSync] ${action} ride for ${dayKey} with ${dayEligible.length} passengers`);

      rideWritePlans.push({
        driverId,
        tripId: groupTripId,
        routeId: primaryRouteId,
        rideDate,
        rideData,
        existingRideId: targetRideId,
        migrated,
        dayEligible,
        pickupStr,
        officeArrivalStr,
        dropStr,
      });

      currentRideIdentityKeys.add(key);

      if (driverId) {
        affectedDriverIds.add(driverId);
      }
      for (const s of dayEligible) {
        if (s.employeeId) {
          affectedEmployeeIds.add(s.employeeId);
        }
      }
    }
  }

  console.log(`[rideSync] ${rideWritePlans.length} ride write plans`);

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
    return prisma.ride.create({
      data: {
        rideDate: plan.rideDate,
        driverId: plan.driverId,
        ...plan.rideData,
      },
    });
  });
  const savedRides = await runChunkedTransactions(rideOps);

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
      console.log(`[rideSync] Removing ${toRemoveIds.length} passengers from ride ${savedRide.id}`);
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
        console.log(`[rideSync] Adding passenger ${s.employeeId} to ride ${savedRide.id}`);
        passengerCreateData.push({
          rideId: savedRide.id,
          employeeId: s.employeeId,
          ...snapshot,
        });
      } else if (snapshotChanged(existingPassenger, snapshot)) {
        console.log(`[rideSync] Updating passenger ${s.employeeId} in ride ${savedRide.id}`);
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
        pickupTime: plan.pickupStr,
        officeArrivalTime: plan.officeArrivalStr,
        dropTime: plan.dropStr,
      },
    });

    results.push({
      driverId: plan.driverId,
      tripId: plan.tripId,
      rideDate: plan.rideDate,
      rideId: savedRide.id,
      passengerCount: plan.dayEligible.length,
      pickupTime: plan.pickupStr,
      officeArrivalTime: plan.officeArrivalStr,
      dropTime: plan.dropStr,
    });
  });

  if (cancelNoScheduleRides.length) {
    const ids = cancelNoScheduleRides.map((r) => r.id);
    console.log(`[rideSync] CANCELLING ${ids.length} rides with no schedule`);
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

  if (passengerDeleteOps.length) {
    console.log(`[rideSync] Running ${passengerDeleteOps.length} passenger delete ops`);
    await runChunkedTransactions(passengerDeleteOps);
  }
  if (passengerUpdateOps.length) {
    console.log(`[rideSync] Running ${passengerUpdateOps.length} passenger update ops`);
    await runChunkedTransactions(passengerUpdateOps);
  }
  if (passengerCreateData.length) {
    console.log(`[rideSync] Creating ${passengerCreateData.length} passengers`);
    for (const c of chunk(passengerCreateData, 500))
      await prisma.ridePassenger.createMany({ data: c });
  }
  if (auditLogEntries.length) {
    console.log(`[rideSync] Creating ${auditLogEntries.length} audit log entries`);
    for (const c of chunk(auditLogEntries, 500))
      await prisma.auditLog.createMany({ data: c });
  }

  const candidatePendingRides = await prisma.ride.findMany({
    where: {
      rideDate: { gte: weekRangeStart, lte: weekRangeEnd },
      status: "PENDING",
      ...(isScoped
        ? {
            OR: [
              ...(scopeDriverIds.length
                ? [{ driverId: { in: scopeDriverIds } }]
                : []),
              ...(scopeTripIds.length
                ? [{ tripId: { in: scopeTripIds } }]
                : []),
              ...(scopeRouteIds.length
                ? [{ routeId: { in: scopeRouteIds } }]
                : []),
            ],
          }
        : {}),
    },
  });

  console.log(`[rideSync] Checking ${candidatePendingRides.length} pending rides for staleness`);

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
      console.log(`[rideSync] CANCELLING ${staleIds.length} stale rides (identity no longer exists)`);
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

  console.log(`[rideSync] COMPLETED - ${results.length} total results`);

  // Fire exactly ONE notification per affected employee and ONE per
  // affected driver for this week, no matter how many day-rows (up to 7)
  // were created/updated for them above. Best-effort: never throws, never
  // blocks the sync result from being returned.
  await notifyEmployeeScheduleUpdatedBestEffort({
    employeeIds: [...affectedEmployeeIds],
    driverIds: [...affectedDriverIds],
    weekStartDate,
  });

  return results;
}

async function syncPendingRidesForWeekBestEffort(weekStartDate, scope = {}) {
  try {
    return await syncPendingRidesForWeek(weekStartDate, scope);
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