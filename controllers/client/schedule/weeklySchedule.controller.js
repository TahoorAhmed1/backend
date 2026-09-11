const XLSX = require("xlsx");
const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecordById,
  updateRecord,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");
const { normalizeShift } = require("../../../utils/shiftTime");
const {
  syncPendingRidesForWeekBestEffort,
} = require("../../../lib/rideplaing");

const {
  toDateOnly,
  formatDateOnly,
  saturdayOfCurrentWeek,
  toShiftTimeDate,
  toIsoOrNull,
  computePickupTime,
  DAY_KEYS,
  toSaturdayUtcMidnight,
  normalizeTime,
} = require("../../../utils/dateTimeHelpers");
const {
  normalizeEntity,
  normalizeVehicleType,
  HEADER_ALIASES,
} = require("../../../utils/xlsxParsing");
const { tryAcquireWeekAreaLock } = require("../../../utils/locking");

const {
  findVehicleConflict,
} = require("../../../services/conflictDetection.service");
const {
  findOrCreateVehicleForDriver,
} = require("../../../services/autoAssignment.service");
const {
  recordAssignmentHistory,
} = require("../../../services/auditLog.service");
const {
  findOrCreateRouteAndTrip,
} = require("../../../services/routeTrip.service");
const {
  optimizeWeekAssignments,
} = require("../../../services/routeOptimization.service");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  enqueueBulkUpload,
  enqueueUpdateSchedule,
  enqueuePendingRideResync,
  getBulkUploadJobStatus,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} = require("../../../services/bulkupload.producer");

const {
  notifyEmployeeById,
  notifyDriverById,
} = require("../../../services/notification.service");

const FK_CHECKS = [
  { field: "routeId", model: "route", label: "Route" },
  { field: "tripId", model: "trip", label: "Trip" },
  { field: "driverId", model: "driver", label: "Driver" },
  { field: "vehicleId", model: "vehicle", label: "Vehicle" },
  { field: "vendorId", model: "vendor", label: "Vendor" },
];

const validateWeeklyScheduleForeignKeys = async (data) => {
  const checks = FK_CHECKS.filter(
    ({ field }) => field in data && data[field] != null,
  );
  if (checks.length === 0) return null;

  const results = await Promise.all(
    checks.map(({ model, field }) =>
      prisma[model].findUnique({
        where: { id: data[field] },
        select: { id: true },
      }),
    ),
  );

  const missing = checks
    .filter((_, i) => !results[i])
    .map(({ label }) => label);

  if (missing.length === 0) return null;
  return `${missing.join(", ")} not found for the given id${missing.length > 1 ? "s" : ""}.`;
};

const deleteScheduleAndOrphanedRides = async (schedule) => {
  const weekStartDate = schedule.weekStart;
  const employeeId = schedule.employeeId;
  const weekEnd = new Date(weekStartDate);
  weekEnd.setDate(weekEnd.getDate() + 7);

  await prisma.$transaction(async (tx) => {
    await tx.ridePassenger.deleteMany({
      where: {
        employeeId,
        ride: { rideDate: { gte: weekStartDate, lt: weekEnd } },
      },
    });

    await tx.ride.deleteMany({
      where: {
        rideDate: { gte: weekStartDate, lt: weekEnd },
        passengers: { none: {} },
      },
    });

    await tx.weeklySchedule.delete({ where: { id: schedule.id } });
  });

  return { weekStartDate, employeeId };
};

const finalizeOrphanedTripResources = async (
  tx,
  { driverId, vehicleId, routeId },
) => {
  if (driverId) {
    const otherDriverTrips = await tx.trip.count({
      where: { driverId, status: "ACTIVE" },
    });
    if (otherDriverTrips === 0) {
      await tx.driver.update({
        where: { id: driverId },
        data: { status: "AVAILABLE" },
      });
    }
  }

  if (vehicleId) {
    const otherVehicleTrips = await tx.trip.count({
      where: { vehicleId, status: "ACTIVE" },
    });
    if (otherVehicleTrips === 0) {
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: { status: "ACTIVE" },
      });
    }
  }

  if (routeId) {
    const remainingTrips = await tx.trip.count({
      where: { routeId, status: "ACTIVE" },
    });
    const remainingSchedules =
      remainingTrips === 0
        ? await tx.weeklySchedule.count({
            where: { routeId, status: { not: "CANCELLED" } },
          })
        : 0;

    if (remainingTrips === 0 && remainingSchedules === 0) {
      await tx.route.delete({ where: { id: routeId } });
    }
  }
};

const finalizeBulkDeletedTripResources = async (deletedTrips) => {
  const driverIds = [
    ...new Set(deletedTrips.map((trip) => trip.driverId).filter(Boolean)),
  ];
  const vehicleIds = [
    ...new Set(deletedTrips.map((trip) => trip.vehicleId).filter(Boolean)),
  ];

  if (driverIds.length === 0 && vehicleIds.length === 0) return;

  await prisma.$transaction(async (tx) => {
    if (driverIds.length > 0) {
      await tx.driver.updateMany({
        where: {
          id: { in: driverIds },
          trips: { none: { status: "ACTIVE" } },
        },
        data: { status: "AVAILABLE" },
      });
    }

    if (vehicleIds.length > 0) {
      await tx.vehicle.updateMany({
        where: {
          id: { in: vehicleIds },
          trips: { none: { status: "ACTIVE" } },
        },
        data: { status: "ACTIVE" },
      });
    }
  });
};

const deleteTripIfOrphaned = async (tripId) => {
  if (!tripId) return false;

  const remainingSchedules = await prisma.weeklySchedule.count({
    where: { tripId, status: { not: "CANCELLED" } },
  });
  if (remainingSchedules > 0) return false;

  return prisma.$transaction(async (tx) => {
    const stillAssigned = await tx.weeklySchedule.count({
      where: { tripId, status: { not: "CANCELLED" } },
    });
    if (stillAssigned > 0) return false;

    const trip = await tx.trip.findUnique({
      where: { id: tripId },
      select: { driverId: true, vehicleId: true, routeId: true },
    });
    if (!trip) return false;

    await tx.ride.deleteMany({ where: { tripId } });
    const deleted = await tx.trip.deleteMany({ where: { id: tripId } });
    if (deleted.count > 0) {
      await finalizeOrphanedTripResources(tx, trip);
    }
    return deleted.count > 0;
  });
};

const resolvePendingVehicleAssignments = async (req, res, next) => {
  try {
    const { weekStart, routeId, routeCode, employeeId, employeeCode } =
      req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Saturday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toSaturdayUtcMidnight(weekStart);

    let route = null;
    if (routeId || routeCode) {
      route = await prisma.route.findUnique({
        where: routeId ? { id: routeId } : { routeCode },
      });
      if (!route) {
        const response = badRequestResponse("Route not found.");
        return res.status(response.status.code).json(response);
      }
    }

    let targetEmployee = null;
    if (employeeId || employeeCode) {
      targetEmployee = employeeId
        ? await prisma.employee.findUnique({ where: { id: employeeId } })
        : await prisma.employee.findFirst({
            where: { employeeCode: String(employeeCode) },
          });
      if (!targetEmployee) {
        const response = badRequestResponse(
          "Employee not found for the given employeeId/employeeCode.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    await tryAcquireWeekAreaLock(weekStartDate);

    const candidates = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: weekStartDate,
        status: "DRAFT",
        driverId: { not: null },
        vehicleId: null,
        ...(route ? { routeId: route.id } : {}),
        ...(targetEmployee ? { employeeId: targetEmployee.id } : {}),
      },
      include: { trip: true, route: true },
    });

    const summary = {
      scanned: candidates.length,
      vehiclesLinked: 0,
      stillMissingVehicle: 0,
      conflicts: 0,
      details: [],
    };

    const driverCache = new Map();
    const affectedDriverIds = [];
    const affectedRouteIds = [];

    for (const entry of candidates) {
      const before = { ...entry };
      const shiftTiming = entry.shiftTiming || entry.route?.shiftTiming;

      let driver = driverCache.get(entry.driverId);
      if (!driver) {
        driver = await prisma.driver.findUnique({
          where: { id: entry.driverId },
          include: { vehicle: true },
        });
        driverCache.set(entry.driverId, driver);
      }

      if (!driver?.vehicle || driver.vehicle.status !== "ACTIVE") {
        const vehicleType = entry.route?.routeName
          ? normalizeVehicleType(entry.route.routeName.split("-").pop())
          : "CAR";

        const vendorName = entry.vendor?.name || "MTS";

        const newVehicle = await findOrCreateVehicleForDriver(
          entry.driverId,
          vendorName,
          vehicleType,
          { driverById: driverCache, vehicle: new Map() },
        );

        if (newVehicle) {
          summary.details.push({
            weeklyScheduleId: entry.id,
            employeeId: entry.employeeId,
            driverId: entry.driverId,
            note: `Created placeholder vehicle "${newVehicle.vehicleNumber}" for driver.`,
          });
          driver = await prisma.driver.findUnique({
            where: { id: entry.driverId },
            include: { vehicle: true },
          });
          driverCache.set(entry.driverId, driver);
        } else {
          summary.stillMissingVehicle++;
          summary.details.push({
            weeklyScheduleId: entry.id,
            employeeId: entry.employeeId,
            driverId: entry.driverId,
            note: driver?.vehicle
              ? `Driver's linked vehicle is not ACTIVE (status: ${driver.vehicle.status}) - left DRAFT.`
              : "Driver still has no vehicle linked - left DRAFT.",
          });
          continue;
        }
      }

      const conflict = await findVehicleConflict(
        driver.vehicle.id,
        weekStartDate,
        shiftTiming,
        entry.tripId || undefined,
        entry.employeeId,
      );
      if (conflict) {
        summary.conflicts++;
        summary.details.push({
          weeklyScheduleId: entry.id,
          employeeId: entry.employeeId,
          driverId: entry.driverId,
          note: `Driver's vehicle overlaps route "${conflict.route?.routeCode ?? conflict.routeId}" this week - left DRAFT, please check manually.`,
        });
        continue;
      }

      const updatedSchedule = await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: { vehicleId: driver.vehicle.id, status: "ACTIVE" },
      });

      if (entry.tripId && !entry.trip?.vehicleId) {
        await prisma.trip.update({
          where: { id: entry.tripId },
          data: { vehicleId: driver.vehicle.id },
        });
      }

      await recordAssignmentHistory(
        prisma,
        "VEHICLE_LINKED_FROM_DRIVER",
        entry.id,
        before,
        updatedSchedule,
        req.user?.id,
      );

      summary.vehiclesLinked++;
      affectedDriverIds.push(entry.driverId);
      if (entry.routeId) affectedRouteIds.push(entry.routeId);

      summary.details.push({
        weeklyScheduleId: entry.id,
        employeeId: entry.employeeId,
        driverId: entry.driverId,
        vehicleId: driver.vehicle.id,
        note: "Vehicle linked from driver's current vehicle - status set to ACTIVE.",
      });
    }

    if (summary.vehiclesLinked > 0) {
      // Controller-level specific notification already covers this flow via
      // the assignment history + UI refresh; suppress rideSync's generic
      // notification to avoid duplicates.
      syncPendingRidesForWeekBestEffort(weekStartDate, {
        driverIds: [...new Set(affectedDriverIds)],
        routeIds: [...new Set(affectedRouteIds)],
        skipNotifications: true,
      }).catch(() => {});
    }

    const response = okResponse(
      summary,
      `Linked ${summary.vehiclesLinked} vehicle(s) from driver records. ${summary.stillMissingVehicle} still missing a vehicle, ${summary.conflicts} had conflicts.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const optimizeRouteAssignments = async (req, res, next) => {
  try {
    const { weekStart } = req.body;
    if (!weekStart) {
      const response = badRequestResponse("weekStart is required.");
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toSaturdayUtcMidnight(weekStart);
    const summary = await optimizeWeekAssignments(weekStartDate);

    if (summary?.optimizedRoutes?.length > 0) {
      // Bulk optimization affects many drivers/employees at once. Let
      // rideSync handle the single per-employee / per-driver notification
      // (Set-deduped) rather than spamming from the controller.
      syncPendingRidesForWeekBestEffort(weekStartDate, {
        routeIds: summary.optimizedRoutes.map((r) => r.id),
        driverIds: summary.affectedDriverIds || [],
        tripIds: summary.affectedTripIds || [],
        // skipNotifications NOT set → rideSync will notify once per
        // affected employee/driver for the whole week.
      }).catch(() => {});
    }

    const response = okResponse(
      summary,
      "Route assignments optimized for the week.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const resyncPendingRides = async (req, res, next) => {
  try {
    const { weekStart } = req.body;
    if (!weekStart) {
      const response = badRequestResponse("weekStart is required.");
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toSaturdayUtcMidnight(weekStart);
    const { jobId } = await enqueuePendingRideResync(weekStartDate);
    const response = okResponse(
      { jobId, weekStart: weekStartDate },
      "PENDING ride resync has been queued.",
    );
    return res.status(202).json(response);
  } catch (error) {
    next(error);
  }
};

const effectiveTripShift = (trip, route) =>
  trip.shiftTiming || route?.shiftTiming;

const formatShiftLabel = (arrivalDate, dropDate) => {
  if (!arrivalDate || !dropDate) return null;
  const fmt = (d) =>
    new Date(d).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  return `${fmt(arrivalDate)} - ${fmt(dropDate)}`;
};

const countTripOccupancy = async (tripId, weekStartDate, excludeEmployeeId) =>
  prisma.weeklySchedule.count({
    where: {
      tripId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
  });

const loadTripFullForAssignment = (tripId) =>
  prisma.trip.findUnique({
    where: { id: tripId },
    include: { route: true, driver: true, vehicle: true },
  });

const buildCapacityResponse = async (
  trip,
  weekStartDate,
  employeeId,
  capacity,
) => {
  const siblingTrips = await prisma.trip.findMany({
    where: {
      routeId: trip.routeId,
      status: "ACTIVE",
      id: { not: trip.id },
    },
    include: { vehicle: true },
    orderBy: { tripNumber: "asc" },
  });
  const tripsWithRoom = [];
  for (const sibling of siblingTrips) {
    const siblingOccupancy = await countTripOccupancy(
      sibling.id,
      weekStartDate,
      employeeId,
    );
    const siblingRemaining =
      (sibling.vehicle?.capacity || 0) - siblingOccupancy;
    if (siblingRemaining > 0) {
      tripsWithRoom.push({
        tripId: sibling.id,
        tripNumber: sibling.tripNumber,
        remaining: siblingRemaining,
      });
    }
  }

  const response = badRequestResponse(
    `Trip ${trip.tripNumber} on route "${trip.route.routeName}" is at capacity (${capacity}/${capacity}).`,
  );
  response.data = {
    routeId: trip.routeId,
    routeName: trip.route.routeName,
    fullTripId: trip.id,
    fullTripNumber: trip.tripNumber,
    capacity,
    tripsWithRoom,
    overflowOptions: ["ADD_TRIP_TO_ROUTE", "CREATE_NEW_ROUTE"],
  };
  return response;
};

const buildReassignConflictResponse = (existing, newTrip) => {
  const response = badRequestResponse(
    `${existing.employee?.name ?? "This employee"} is already assigned to route "${existing.route?.routeName ?? existing.routeId}" (trip ${existing.trip?.tripNumber ?? existing.tripId}) this week.`,
  );
  response.data = {
    employeeId: existing.employeeId,
    currentAssignment: {
      routeId: existing.routeId,
      routeName: existing.route?.routeName ?? null,
      routeCode: existing.route?.routeCode ?? null,
      tripId: existing.tripId,
      tripNumber: existing.trip?.tripNumber ?? null,
      driverId: existing.driverId,
    },
    requestedAssignment: {
      routeId: newTrip.routeId,
      routeName: newTrip.route?.routeName ?? null,
      tripId: newTrip.id,
      tripNumber: newTrip.tripNumber,
    },
    requiresConfirmation: true,
    confirmField: "confirmReassign",
  };
  return response;
};

const ASSIGNABLE_SCHEDULE_FIELDS = ["serviceType"];
const defaultScheduleStatus = (driverId, vehicleId) =>
  driverId && vehicleId ? "ACTIVE" : "DRAFT";

const assignEmployeeToTrip = async (req, res, next) => {
  try {
    const tripId = req.params.tripId || req.body.tripId;
    const {
      employeeId,
      weekStart,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
      offDay,
      status,
      confirmReassign,
    } = req.body;
    if (!tripId || !employeeId || !weekStart) {
      const response = badRequestResponse(
        "tripId, employeeId, and weekStart are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const trip = await loadTripFullForAssignment(tripId);
    if (!trip) {
      const response = badRequestResponse("Trip not found.");
      return res.status(response.status.code).json(response);
    }
    if (!trip.vehicle) {
      const response = badRequestResponse(
        "This trip has no vehicle assigned — cannot validate capacity.",
      );
      return res.status(response.status.code).json(response);
    }

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { serviceType: true },
    });
    const requestedOffDay = String(offDay ?? "").trim();
    const requestedVehicleEntity = req.body.vehicleEntity
      ? normalizeEntity(req.body.vehicleEntity)
      : null;
    if (req.body.vehicleEntity && !requestedVehicleEntity) {
      const response = badRequestResponse(
        "Invalid vehicleEntity — expected IBEX or VW.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toSaturdayUtcMidnight(weekStart);
    const capacity = trip.vehicle.capacity;

    const officeArrivalSource = trip.route?.officeArrivalTime ?? null;
    const dropSource = trip.route?.dropTime ?? null;
    const officeArrivalDate = officeArrivalSource
      ? toShiftTimeDate(officeArrivalSource)
      : null;
    const dropDate = dropSource ? toShiftTimeDate(dropSource) : null;
    const pickupDate = computePickupTime(officeArrivalDate);
    const shiftTiming = effectiveTripShift(trip, trip.route);

    const assignableFields = {};
    for (const field of ASSIGNABLE_SCHEDULE_FIELDS) {
      if (req.body[field] != null) assignableFields[field] = req.body[field];
    }

    try {
      const { schedule, remaining, oldTripId } = await prisma.$transaction(
        async (tx) => {
          const occupancy = await tx.weeklySchedule.count({
            where: {
              tripId,
              weekStart: weekStartDate,
              status: { not: "CANCELLED" },
              employeeId: { not: employeeId },
            },
          });
          const remainingSeats = capacity - occupancy;
          if (remainingSeats <= 0) {
            const err = new Error("TRIP_AT_CAPACITY");
            err.code = "TRIP_AT_CAPACITY";
            throw err;
          }

          const existing = await tx.weeklySchedule.findUnique({
            where: {
              employeeId_weekStart: { employeeId, weekStart: weekStartDate },
            },
            include: { employee: true, route: true, trip: true },
          });

          if (existing?.isLocked) {
            const err = new Error("SCHEDULE_LOCKED");
            err.code = "SCHEDULE_LOCKED";
            throw err;
          }

          if (
            existing &&
            existing.status !== "CANCELLED" &&
            existing.tripId &&
            existing.tripId !== tripId &&
            !confirmReassign
          ) {
            const err = new Error("REASSIGN_CONFIRM_NEEDED");
            err.code = "REASSIGN_CONFIRM_NEEDED";
            err.existing = existing;
            throw err;
          }

          const data = {
            ...assignableFields,
            weekStart: weekStartDate,
            employeeId,
            routeId: trip.routeId,
            tripId: trip.id,
            driverId: trip.driverId,
            vehicleId: trip.vehicleId,
            vehicleEntity:
              requestedVehicleEntity || trip.vehicle?.vehicleEntity || null,
            vendorId:
              req.body.vendorId ||
              existing?.vendorId ||
              trip.driver?.vendorId ||
              null,
            shiftTiming,
            monday: monday ?? existing?.monday ?? "BOTH",
            tuesday: tuesday ?? existing?.tuesday ?? "BOTH",
            wednesday: wednesday ?? existing?.wednesday ?? "BOTH",
            thursday: thursday ?? existing?.thursday ?? "BOTH",
            friday: friday ?? existing?.friday ?? "BOTH",
            saturday: saturday ?? existing?.saturday ?? "BOTH",
            sunday: sunday ?? existing?.sunday ?? "BOTH",
            officeArrivalTime: officeArrivalDate,
            dropTime: dropDate,
            pickupTime: pickupDate,
            offDay: requestedOffDay || existing?.offDay || null,
            serviceType:
              assignableFields.serviceType ||
              existing?.serviceType ||
              employee?.serviceType ||
              "PICK_AND_DROP",
            status:
              status ||
              existing?.status ||
              defaultScheduleStatus(trip.driverId, trip.vehicleId),
          };

          const savedSchedule = existing
            ? await tx.weeklySchedule.update({
                where: { id: existing.id },
                data,
              })
            : await tx.weeklySchedule.create({ data });

          return {
            schedule: savedSchedule,
            remaining: remainingSeats,
            oldTripId: existing?.tripId || null,
          };
        },
      );

      if (oldTripId && oldTripId !== trip.id) {
        await deleteTripIfOrphaned(oldTripId);
      }

      // IMPORTANT: skipNotifications = true → rideSync will NOT send its own
      // generic notification. The controller sends one specific notification
      // below, and awaits the sync first so the ride rows are committed
      // before the push goes out (no race condition).
      await syncPendingRidesForWeekBestEffort(weekStartDate, {
        driverIds: [trip.driverId].filter(Boolean),
        tripIds: [trip.id],
        routeIds: [trip.routeId].filter(Boolean),
        skipNotifications: true,
      }).catch(() => {});

      const routeLabel =
        trip.route?.routeName || trip.route?.routeCode || "a route";
      const weekLabel = weekStartDate.toISOString().slice(0, 10);

      await notifyEmployeeById(
        employeeId,
        {
          title: "Trip assignment",
          body: `You've been assigned to Trip ${trip.tripNumber} on ${routeLabel} for the week of ${weekLabel}.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_ASSIGNED",
            scheduleId: schedule.id,
            tripId: trip.id,
            routeId: trip.routeId,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error("[assignEmployeeToTrip] Failed to notify employee:", err),
      );

      if (trip.driverId) {
        await notifyDriverById(
          trip.driverId,
          {
            title: "New passenger on your trip",
            body: `An employee was added to Trip ${trip.tripNumber} on ${routeLabel} for the week of ${weekLabel}.`,
            data: {
              type: "SCHEDULE_EMPLOYEE_ASSIGNED",
              scheduleId: schedule.id,
              tripId: trip.id,
              routeId: trip.routeId,
            },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch((err) =>
          console.error("[assignEmployeeToTrip] Failed to notify driver:", err),
        );
      }

      const response = createSuccessResponse(
        { schedule, remainingSeats: remaining - 1, capacity },
        "Employee assigned to trip.",
      );
      return res.status(response.status.code).json(response);
    } catch (txError) {
      if (txError.code === "TRIP_AT_CAPACITY") {
        const response = await buildCapacityResponse(
          trip,
          weekStartDate,
          employeeId,
          capacity,
        );
        return res.status(response.status.code).json(response);
      }
      if (txError.code === "SCHEDULE_LOCKED") {
        const response = badRequestResponse(
          "This employee's schedule for this week is locked.",
        );
        return res.status(response.status.code).json(response);
      }
      if (txError.code === "REASSIGN_CONFIRM_NEEDED") {
        const response = buildReassignConflictResponse(txError.existing, trip);
        return res.status(response.status.code).json(response);
      }
      throw txError;
    }
  } catch (error) {
    next(error);
  }
};

const searchEmployeesForAssignment = async (req, res, next) => {
  try {
    const { query = "", weekStart, excludeTripId, limit } = req.query;

    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart is required so existing assignments for that week can be checked.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toSaturdayUtcMidnight(weekStart);
    const trimmedQuery = String(query || "").trim();
    const take = Math.min(25, Math.max(1, parseInt(limit, 10) || 15));

    if (!trimmedQuery) {
      const response = okResponse(
        { employees: [] },
        "Type to search employees.",
      );
      return res.status(response.status.code).json(response);
    }

    const employees = await prisma.employee.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { name: { contains: trimmedQuery, mode: "insensitive" } },
          { employeeCode: { contains: trimmedQuery, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        area: { select: { name: true } },
      },
      orderBy: { name: "asc" },
      take,
    });

    if (employees.length === 0) {
      const response = okResponse({ employees: [] }, "No matching employees.");
      return res.status(response.status.code).json(response);
    }

    const employeeIds = employees.map((e) => e.id);
    const existingSchedules = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: weekStartDate,
        employeeId: { in: employeeIds },
        status: { not: "CANCELLED" },
      },
      select: {
        employeeId: true,
        tripId: true,
        route: { select: { routeCode: true } },
      },
    });
    const scheduleByEmployee = new Map(
      existingSchedules.map((s) => [s.employeeId, s]),
    );

    const results = employees.map((e) => {
      const existing = scheduleByEmployee.get(e.id);
      return {
        id: e.id,
        name: e.name,
        employeeCode: e.employeeCode,
        area: e.area?.name || null,
        alreadyScheduledThisWeek: Boolean(existing),
        alreadyOnThisTrip: Boolean(
          existing && excludeTripId && existing.tripId === excludeTripId,
        ),
        assignedRouteCode: existing
          ? (existing.route?.routeCode ?? null)
          : null,
      };
    });

    const response = okResponse({ employees: results }, "Employees found.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const createWeeklySchedule = async (req, res, next) => {
  try {
    const {
      weekStart,
      employeeId,
      routeId,
      tripId,
      driverId,
      vehicleId,
      vendorId,
      vehicleEntity,
      serviceType,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
      offDay,
      pickupTime,
      shiftTiming,
      officeArrivalTime,
      dropTime,
      status,
    } = req.body;

    if (!employeeId || !weekStart) {
      const response = badRequestResponse(
        "employeeId and weekStart are required.",
      );
      return res.status(response.status.code).json(response);
    }

    let normalizedVehicleEntity = null;
    if (vehicleEntity) {
      normalizedVehicleEntity = normalizeEntity(vehicleEntity);
      if (!normalizedVehicleEntity) {
        const response = badRequestResponse(
          "Invalid vehicleEntity — expected IBEX or VW.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    const officeArrivalDate = officeArrivalTime
      ? toShiftTimeDate(officeArrivalTime)
      : null;
    if (officeArrivalTime && !officeArrivalDate) {
      const response = badRequestResponse(
        "Invalid officeArrivalTime — expected an ISO 8601 datetime.",
      );
      return res.status(response.status.code).json(response);
    }
    const dropDate = dropTime ? toShiftTimeDate(dropTime) : null;
    if (dropTime && !dropDate) {
      const response = badRequestResponse(
        "Invalid dropTime — expected an ISO 8601 datetime.",
      );
      return res.status(response.status.code).json(response);
    }
    const pickupDate = computePickupTime(officeArrivalDate);
    const driverVendor = driverId
      ? await prisma.driver.findUnique({
          where: { id: driverId },
          select: { vendorId: true },
        })
      : null;
    const resolvedVendorId = vendorId || driverVendor?.vendorId || null;

    const existingSchedule = await prisma.weeklySchedule.findUnique({
      where: {
        employeeId_weekStart: {
          employeeId,
          weekStart: toSaturdayUtcMidnight(weekStart),
        },
      },
    });

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { serviceType: true },
    });

    if (existingSchedule) {
      const response = badRequestResponse(
        "Schedule already exists for this employee in this week.",
      );
      return res.status(response.status.code).json(response);
    }

    const fkError = await validateWeeklyScheduleForeignKeys({
      routeId,
      tripId,
      driverId,
      vehicleId,
      vendorId: resolvedVendorId,
    });
    if (fkError) {
      const response = badRequestResponse(fkError);
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.weeklySchedule, {
      weekStart: toSaturdayUtcMidnight(weekStart),
      employeeId,
      routeId,
      tripId,
      driverId,
      vehicleId,
      vendorId: resolvedVendorId,
      vehicleEntity: normalizedVehicleEntity,
      serviceType: serviceType || employee?.serviceType || "PICK_AND_DROP",
      monday: monday || "BOTH",
      tuesday: tuesday || "BOTH",
      wednesday: wednesday || "BOTH",
      thursday: thursday || "BOTH",
      friday: friday || "BOTH",
      saturday: saturday || "BOTH",
      sunday: sunday || "BOTH",
      pickupTime: pickupDate,
      shiftTiming,
      officeArrivalTime: officeArrivalDate,
      dropTime: dropDate,
      offDay: String(offDay ?? "").trim() || null,
      status: status || defaultScheduleStatus(driverId, vehicleId),
    });

    if (routeId) {
      try {
        await optimizeWeekAssignments(toSaturdayUtcMidnight(weekStart));
      } catch (optimizeError) {
        // Best-effort
      }
    }

    // skipNotifications = true → controller sends the specific notification.
    await syncPendingRidesForWeekBestEffort(toSaturdayUtcMidnight(weekStart), {
      driverId,
      tripId,
      routeId,
      skipNotifications: true,
    }).catch(() => {});

    let routeLabel = "your weekly schedule";
    if (routeId) {
      const route = await prisma.route.findUnique({
        where: { id: routeId },
        select: { routeName: true, routeCode: true },
      });
      if (route) routeLabel = route.routeName || route.routeCode || routeLabel;
    }
    const weekLabel = toSaturdayUtcMidnight(weekStart)
      .toISOString()
      .slice(0, 10);

    await notifyEmployeeById(
      employeeId,
      {
        title: "Weekly schedule added",
        body: `A schedule was created for you on ${routeLabel} for the week of ${weekLabel}.`,
        data: { type: "SCHEDULE_EMPLOYEE_ADDED", employeeId, routeId, tripId },
        event: "schedule-updated",
      },
      { notifyAdmins: false },
    ).catch((err) =>
      console.error("[createWeeklySchedule] Failed to notify employee:", err),
    );

    if (driverId) {
      await notifyDriverById(
        driverId,
        {
          title: "New passenger on your trip",
          body: `An employee was added to your schedule on ${routeLabel} for the week of ${weekLabel}.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_ADDED",
            employeeId,
            routeId,
            tripId,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error("[createWeeklySchedule] Failed to notify driver:", err),
      );
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllWeeklySchedules = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      employeeId,
      status,
      weekStart,
      routeId,
      search,
      sortBy = "weekStart",
      sortOrder = "desc",
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNumber - 1) * pageSize;
    const take = pageSize;

    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (routeId) where.routeId = routeId;
    if (status) where.status = status;

    if (weekStart) {
      const startDate = toSaturdayUtcMidnight(weekStart);
      const nextDay = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      where.weekStart = { gte: startDate, lt: nextDay };
    }

    if (search) {
      where.OR = [
        { employee: { name: { contains: search, mode: "insensitive" } } },
        {
          employee: { employeeCode: { contains: search, mode: "insensitive" } },
        },
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        {
          vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } },
        },
      ];
    }

    const orderBy = [];
    switch (sortBy) {
      case "employeeName":
        orderBy.push({ employee: { name: sortOrder } });
        break;
      case "routeCode":
        orderBy.push({ route: { routeCode: sortOrder } });
        break;
      case "status":
        orderBy.push({ status: sortOrder });
        break;
      case "weekStart":
      default:
        orderBy.push({ weekStart: sortOrder });
        orderBy.push({ route: { routeCode: "asc" } });
        break;
    }

    const totalCount = await prisma.weeklySchedule.count({ where });

    const schedules = await prisma.weeklySchedule.findMany({
      where,
      skip,
      take,
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            contactNumber: true,
          },
        },
        route: {
          include: {
            area: true,
            subArea: true,
          },
        },
        trip: {
          include: {
            vehicle: {
              select: {
                id: true,
                vehicleNumber: true,
                type: true,
                capacity: true,
                status: true,
              },
            },
            driver: {
              select: { id: true, name: true, phone: true, status: true },
            },
          },
        },
        driver: {
          select: { id: true, name: true, phone: true, status: true },
        },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
            type: true,
            capacity: true,
            status: true,
          },
        },
        vendor: {
          select: { id: true, name: true },
        },
      },
      orderBy,
    });

    const totalPages = Math.ceil(totalCount / pageSize);
    const hasNextPage = pageNumber < totalPages;
    const hasPrevPage = pageNumber > 1;

    const response = okResponse(
      {
        data: schedules,
        pagination: {
          page: pageNumber,
          limit: pageSize,
          totalCount,
          totalPages,
          hasNextPage,
          hasPrevPage,
          nextPage: hasNextPage ? pageNumber + 1 : null,
          prevPage: hasPrevPage ? pageNumber - 1 : null,
        },
      },
      `Weekly schedules retrieved successfully. Showing page ${pageNumber} of ${totalPages || 1}.`,
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getWeeklyScheduleById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const schedule = await prisma.weeklySchedule.findUnique({ where: { id } });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await getRecordById(prisma.weeklySchedule, id, {
      employee: true,
      route: true,
      trip: { include: { vehicle: true, driver: true } },
      driver: true,
      vehicle: true,
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateWeeklySchedule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    if (updateData.weekStart)
      updateData.weekStart = toSaturdayUtcMidnight(updateData.weekStart);
    delete updateData.pickupTime;

    if ("officeArrivalTime" in updateData) {
      const parsed = updateData.officeArrivalTime
        ? toShiftTimeDate(updateData.officeArrivalTime)
        : null;
      if (updateData.officeArrivalTime && !parsed) {
        const e = badRequestResponse("Invalid officeArrivalTime.");
        return res.status(e.status.code).json(e);
      }
      updateData.officeArrivalTime = parsed;
      updateData.pickupTime = computePickupTime(parsed);
    }
    if ("dropTime" in updateData) {
      const parsed = updateData.dropTime
        ? toShiftTimeDate(updateData.dropTime)
        : null;
      if (updateData.dropTime && !parsed) {
        const e = badRequestResponse("Invalid dropTime.");
        return res.status(e.status.code).json(e);
      }
      updateData.dropTime = parsed;
    }
    if ("vehicleEntity" in updateData) {
      const normalized = updateData.vehicleEntity
        ? normalizeEntity(updateData.vehicleEntity)
        : null;
      if (updateData.vehicleEntity && !normalized) {
        const e = badRequestResponse("Invalid vehicleEntity.");
        return res.status(e.status.code).json(e);
      }
      updateData.vehicleEntity = normalized;
    }

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
      include: { employee: { select: { name: true } } },
    });
    if (!schedule) {
      const e = badRequestResponse("Weekly schedule not found.");
      return res.status(e.status.code).json(e);
    }

    if ("shiftTiming" in updateData && !String(updateData.shiftTiming).trim()) {
      delete updateData.shiftTiming;
    }
    if ("serviceType" in updateData && !String(updateData.serviceType).trim()) {
      delete updateData.serviceType;
    }
    if ("offDay" in updateData && !String(updateData.offDay).trim()) {
      delete updateData.offDay;
    }
    if ("driverId" in updateData) {
      const driver = updateData.driverId
        ? await prisma.driver.findUnique({
            where: { id: updateData.driverId },
            select: { vendorId: true, vehicle: true },
          })
        : null;
      if (!("vendorId" in updateData)) {
        updateData.vendorId = driver?.vendorId || null;
      }
      if (!("vehicleId" in updateData)) {
        updateData.vehicleId = driver?.vehicle?.id || null;
      }
      if (!("vehicleEntity" in updateData)) {
        updateData.vehicleEntity = driver?.vehicle?.vehicleEntity || null;
      }
    }

    if (
      !("shiftTiming" in updateData) &&
      ("officeArrivalTime" in updateData || "dropTime" in updateData)
    ) {
      const effectiveArrival =
        "officeArrivalTime" in updateData
          ? updateData.officeArrivalTime
          : schedule.officeArrivalTime;
      const effectiveDrop =
        "dropTime" in updateData ? updateData.dropTime : schedule.dropTime;
      if (effectiveArrival && effectiveDrop)
        updateData.shiftTiming = formatShiftLabel(
          effectiveArrival,
          effectiveDrop,
        );
    }

    const fkError = await validateWeeklyScheduleForeignKeys(updateData);
    if (fkError) {
      const e = badRequestResponse(fkError);
      return res.status(e.status.code).json(e);
    }

    const response = await updateRecord(prisma.weeklySchedule, id, updateData, {
      employee: true,
      route: true,
      trip: { include: { vehicle: true, driver: true } },
      driver: true,
      vehicle: true,
    });

    const previousTripId = schedule.tripId;
    const updatedTripId =
      "tripId" in updateData ? updateData.tripId : schedule.tripId;
    if (previousTripId && previousTripId !== updatedTripId) {
      await deleteTripIfOrphaned(previousTripId);
    }

    const touchesAssignment = [
      "routeId",
      "tripId",
      "driverId",
      "vehicleId",
    ].some((f) => f in updateData);
    if (touchesAssignment) {
      try {
        await optimizeWeekAssignments(
          updateData.weekStart || schedule.weekStart,
        );
      } catch (e) {}
    }

    // FIX: added routeIds to scope. Without it, a route-only change was not
    // resynced. Also skipNotifications: true so controller notification wins.
    await syncPendingRidesForWeekBestEffort(
      updateData.weekStart || schedule.weekStart,
      {
        driverIds: [schedule.driverId, updateData.driverId].filter(Boolean),
        tripIds: [schedule.tripId, updateData.tripId].filter(Boolean),
        routeIds: [schedule.routeId, updateData.routeId].filter(Boolean),
        skipNotifications: true,
      },
    ).catch(() => {});

    const NOTIFY_WORTHY_FIELDS = [
      "routeId",
      "tripId",
      "driverId",
      "vehicleId",
      "officeArrivalTime",
      "dropTime",
      "status",
    ];
    const notifyWorthy = NOTIFY_WORTHY_FIELDS.some((f) => f in updateData);

    if (notifyWorthy) {
      const updated = response?.data;
      const routeLabel =
        updated?.route?.routeName || updated?.route?.routeCode || "their route";
      const weekLabel = (updateData.weekStart || schedule.weekStart)
        .toISOString()
        .slice(0, 10);

      await notifyEmployeeById(
        schedule.employeeId,
        {
          title: "Schedule updated",
          body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_UPDATED",
            employeeId: schedule.employeeId,
            scheduleId: id,
            routeId: updated?.routeId ?? schedule.routeId,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch(() => {});

      const driverChanged =
        "driverId" in updateData && schedule.driverId !== updateData.driverId;

      if (driverChanged) {
        if (schedule.driverId) {
          await notifyDriverById(
            schedule.driverId,
            {
              title: "Passenger removed from your trip",
              body: `An employee's schedule on ${routeLabel} was moved off your trip.`,
              data: { type: "TRIP_DRIVER_REMOVED", scheduleId: id },
              event: "schedule-updated",
            },
            { notifyAdmins: false },
          ).catch(() => {});
        }
        if (updateData.driverId) {
          await notifyDriverById(
            updateData.driverId,
            {
              title: "New passenger on your trip",
              body: `An employee's schedule on ${routeLabel} was moved onto your trip.`,
              data: { type: "TRIP_DRIVER_ASSIGNED", scheduleId: id },
              event: "schedule-updated",
            },
            { notifyAdmins: false },
          ).catch(() => {});
        }
      } else if (schedule.driverId) {
        await notifyDriverById(
          schedule.driverId,
          {
            title: "Passenger schedule updated",
            body: `An employee's schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
            data: { type: "SCHEDULE_EMPLOYEE_UPDATED", scheduleId: id },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch(() => {});
      }
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteWeeklySchedule = async (req, res, next) => {
  try {
    const { id } = req.params;

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, name: true } },
        route: { select: { routeName: true, routeCode: true } },
      },
    });

    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    await deleteScheduleAndOrphanedRides(schedule);

    // skipNotifications: true → controller notification below wins.
    await syncPendingRidesForWeekBestEffort(schedule.weekStart, {
      driverId: schedule.driverId,
      tripId: schedule.tripId,
      routeId: schedule.routeId,
      skipNotifications: true,
    }).catch(() => {});

    const routeLabel =
      schedule.route?.routeName || schedule.route?.routeCode || "their route";
    const weekLabel = schedule.weekStart.toISOString().slice(0, 10);

    // await notifyEmployeeById(
    //   schedule.employeeId,
    //   {
    //     title: "Removed from schedule",
    //     body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was removed.`,
    //     data: {
    //       type: "SCHEDULE_EMPLOYEE_REMOVED",
    //       employeeId: schedule.employeeId,
    //       routeId: schedule.routeId,
    //     },
    //     event: "schedule-updated",
    //   },
    //   { notifyAdmins: false },
    // ).catch((err) =>
    //   console.error("[deleteWeeklySchedule] Failed to notify employee:", err),
    // );

    // if (schedule.driverId) {
    //   await notifyDriverById(
    //     schedule.driverId,
    //     {
    //       title: "Passenger removed from your trip",
    //       body: `${schedule.employee?.name || "An employee"} was removed from your trip on ${routeLabel} for the week of ${weekLabel}.`,
    //       data: {
    //         type: "SCHEDULE_EMPLOYEE_REMOVED",
    //         employeeId: schedule.employeeId,
    //         routeId: schedule.routeId,
    //       },
    //       event: "schedule-updated",
    //     },
    //     { notifyAdmins: false },
    //   ).catch((err) =>
    //     console.error("[deleteWeeklySchedule] Failed to notify driver:", err),
    //   );
    // }

    const response = okResponse(
      { id },
      "Weekly schedule and associated rides deleted successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateSingleEmployeeSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    delete updateData.id;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.employeeId;
    delete updateData.pickupTime;

    if (updateData.weekStart) {
      updateData.weekStart = toSaturdayUtcMidnight(updateData.weekStart);
    }

    if ("officeArrivalTime" in updateData) {
      const parsed = updateData.officeArrivalTime
        ? toShiftTimeDate(updateData.officeArrivalTime)
        : null;
      if (updateData.officeArrivalTime && !parsed) {
        const errorResponse = badRequestResponse(
          "Invalid officeArrivalTime — expected an ISO 8601 datetime.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.officeArrivalTime = parsed;
      updateData.pickupTime = computePickupTime(parsed);
    }

    if ("dropTime" in updateData) {
      const parsed = updateData.dropTime
        ? toShiftTimeDate(updateData.dropTime)
        : null;
      if (updateData.dropTime && !parsed) {
        const errorResponse = badRequestResponse(
          "Invalid dropTime — expected an ISO 8601 datetime.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.dropTime = parsed;
    }

    if ("vehicleEntity" in updateData) {
      const normalized = updateData.vehicleEntity
        ? normalizeEntity(updateData.vehicleEntity)
        : null;
      if (updateData.vehicleEntity && !normalized) {
        const errorResponse = badRequestResponse(
          "Invalid vehicleEntity — expected IBEX or VW.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.vehicleEntity = normalized;
    }

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
      include: {
        route: { include: { area: true } },
        trip: { include: { vehicle: true, weeklySchedules: true } },
      },
    });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if ("shiftTiming" in updateData && !String(updateData.shiftTiming).trim()) {
      delete updateData.shiftTiming;
    }
    if ("serviceType" in updateData && !String(updateData.serviceType).trim()) {
      delete updateData.serviceType;
    }
    if ("offDay" in updateData && !String(updateData.offDay).trim()) {
      delete updateData.offDay;
    }
    if ("driverId" in updateData) {
      const driver = updateData.driverId
        ? await prisma.driver.findUnique({
            where: { id: updateData.driverId },
            select: { vendorId: true, vehicle: true },
          })
        : null;
      if (!("vendorId" in updateData)) {
        updateData.vendorId = driver?.vendorId || null;
      }
      if (!("vehicleId" in updateData)) {
        updateData.vehicleId = driver?.vehicle?.id || null;
      }
      if (!("vehicleEntity" in updateData)) {
        updateData.vehicleEntity = driver?.vehicle?.vehicleEntity || null;
      }
    }

    if (
      !("shiftTiming" in updateData) &&
      ("officeArrivalTime" in updateData || "dropTime" in updateData)
    ) {
      const effectiveArrival =
        "officeArrivalTime" in updateData
          ? updateData.officeArrivalTime
          : schedule.officeArrivalTime;
      const effectiveDrop =
        "dropTime" in updateData ? updateData.dropTime : schedule.dropTime;

      if (effectiveArrival && effectiveDrop) {
        updateData.shiftTiming = formatShiftLabel(
          effectiveArrival,
          effectiveDrop,
        );
      }
    }

    const fkError = await validateWeeklyScheduleForeignKeys(updateData);
    if (fkError) {
      const errorResponse = badRequestResponse(fkError);
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updated = await prisma.weeklySchedule.update({
      where: { id },
      data: updateData,
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
        route: true,
        trip: {
          include: { vehicle: true, driver: true },
        },
        driver: true,
        vehicle: true,
        vendor: true,
      },
    });

    const previousTripId = schedule.tripId;
    const updatedTripId =
      "tripId" in updateData ? updateData.tripId : schedule.tripId;
    if (previousTripId && previousTripId !== updatedTripId) {
      await deleteTripIfOrphaned(previousTripId);
    }

    // -------------------------------------------------------------------------
    // rideSync — ONLY when pattern OR assignment OR status changed.
    //
    // Timing-only updates (officeArrivalTime / dropTime / shiftTiming /
    // pickupTime) do NOT trigger rideSync here — timing changes are handled
    // by the separate reassignMismatchedShiftEmployees flow, which the
    // admin calls explicitly.
    // -------------------------------------------------------------------------
    const PATTERN_FIELDS = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];
    const ASSIGNMENT_FIELDS = ["routeId", "tripId", "driverId", "vehicleId"];
    const TIMING_FIELDS = [
      "officeArrivalTime",
      "dropTime",
      "shiftTiming",
      "pickupTime",
    ];

    const patternChanged = PATTERN_FIELDS.some((f) => f in updateData);
    const assignmentChanged = ASSIGNMENT_FIELDS.some((f) => f in updateData);
    const statusChanged = "status" in updateData;

    const shouldResyncRides =
      patternChanged || assignmentChanged || statusChanged;

    if (shouldResyncRides) {
      await syncPendingRidesForWeekBestEffort(
        updateData.weekStart || schedule.weekStart,
        {
          driverIds: [schedule.driverId, updateData.driverId].filter(Boolean),
          tripIds: [schedule.tripId, updateData.tripId].filter(Boolean),
          routeIds: [schedule.routeId, updateData.routeId].filter(Boolean),
          skipNotifications: true,
        },
      ).catch(() => {});
    } else if (TIMING_FIELDS.some((f) => f in updateData)) {
      // Timing-only change — rides are NOT resynced here.
      // reassignMismatchedShiftEmployees handles timing mismatches.
      console.log(
        "[updateSingleEmployeeSchedule] timing-only update — skipping rideSync (handled by reassign flow)",
      );
    }

    const NOTIFY_WORTHY_FIELDS = [
      "routeId",
      "tripId",
      "driverId",
      "vehicleId",
      "officeArrivalTime",
      "dropTime",
      "status",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];
    const notifyWorthy = NOTIFY_WORTHY_FIELDS.some((f) => f in updateData);

    if (notifyWorthy) {
      const routeLabel =
        updated.route?.routeName || updated.route?.routeCode || "their route";
      const weekLabel = (updateData.weekStart || schedule.weekStart)
        .toISOString()
        .slice(0, 10);

      await notifyEmployeeById(
        schedule.employeeId,
        {
          title: "Schedule updated",
          body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_UPDATED",
            employeeId: schedule.employeeId,
            scheduleId: id,
            routeId: updated.routeId,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error(
          "[updateSingleEmployeeSchedule] Failed to notify employee:",
          err,
        ),
      );

      const driverChanged =
        "driverId" in updateData && schedule.driverId !== updateData.driverId;

      if (driverChanged) {
        if (schedule.driverId) {
          await notifyDriverById(
            schedule.driverId,
            {
              title: "Passenger removed from your trip",
              body: `An employee's schedule on ${routeLabel} was moved off your trip.`,
              data: { type: "TRIP_DRIVER_REMOVED", scheduleId: id },
              event: "schedule-updated",
            },
            { notifyAdmins: false },
          ).catch((err) =>
            console.error(
              "[updateSingleEmployeeSchedule] Failed to notify previous driver:",
              err,
            ),
          );
        }
        if (updateData.driverId) {
          await notifyDriverById(
            updateData.driverId,
            {
              title: "New passenger on your trip",
              body: `An employee's schedule on ${routeLabel} was moved onto your trip.`,
              data: { type: "TRIP_DRIVER_ASSIGNED", scheduleId: id },
              event: "schedule-updated",
            },
            { notifyAdmins: false },
          ).catch((err) =>
            console.error(
              "[updateSingleEmployeeSchedule] Failed to notify new driver:",
              err,
            ),
          );
        }
      } else if (schedule.driverId) {
        await notifyDriverById(
          schedule.driverId,
          {
            title: "Passenger schedule updated",
            body: `An employee's schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
            data: { type: "SCHEDULE_EMPLOYEE_UPDATED", scheduleId: id },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch((err) =>
          console.error(
            "[updateSingleEmployeeSchedule] Failed to notify driver:",
            err,
          ),
        );
      }
    }

    const response = okResponse(
      updated,
      "Employee schedule updated successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteSingleEmployeeSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, name: true } },
        route: { select: { routeName: true, routeCode: true } },
      },
    });

    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { weekStartDate, employeeId } =
      await deleteScheduleAndOrphanedRides(schedule);

    // rideSync always on delete — orphan rides cancel karo.
    // skipNotifications: true → rideSync's own notification suppressed;
    // controller sends one specific notification below.
    await syncPendingRidesForWeekBestEffort(schedule.weekStart, {
      driverId: schedule.driverId,
      tripId: schedule.tripId,
      routeId: schedule.routeId,
      skipNotifications: true,
    }).catch(() => {});

    const routeLabel =
      schedule.route?.routeName || schedule.route?.routeCode || "their route";
    const weekLabel = weekStartDate.toISOString().slice(0, 10);

    // Notify ONLY the affected employee
    await notifyEmployeeById(
      employeeId,
      {
        title: "Removed from schedule",
        body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was removed.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_REMOVED",
          employeeId,
          routeId: schedule.routeId,
        },
        event: "schedule-updated",
      },
      { notifyAdmins: false },
    ).catch((err) =>
      console.error(
        "[deleteSingleEmployeeSchedule] Failed to notify employee:",
        err,
      ),
    );

    // Notify ONLY the affected driver (if any)
    if (schedule.driverId) {
      await notifyDriverById(
        schedule.driverId,
        {
          title: "Passenger removed from your trip",
          body: `${schedule.employee?.name || "An employee"} was removed from your trip on ${routeLabel} for the week of ${weekLabel}.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_REMOVED",
            employeeId,
            routeId: schedule.routeId,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error(
          "[deleteSingleEmployeeSchedule] Failed to notify driver:",
          err,
        ),
      );
    }

    const response = okResponse(
      {
        weekStart: weekStartDate.toISOString().slice(0, 10),
        employeeId: employeeId,
        message: `Schedule and rides for employee in week ${weekStartDate.toISOString().slice(0, 10)} deleted.`,
      },
      "Employee schedule and associated rides deleted successfully.",
    );
    console.log("response.data", response.data);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateTripDriver = async (req, res, next) => {
  try {
    const { tripId } = req.params;
    const { driverId, weekStart } = req.body;

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        vehicle: true,
        driver: true,
        route: {
          include: {
            area: true,
          },
        },
        weeklySchedules: {
          where: {
            status: { not: "CANCELLED" },
          },
          include: {
            employee: true,
          },
        },
      },
    });

    if (!trip) {
      const errorResponse = badRequestResponse("Trip not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const safeDriverId = driverId || null;
    let newVehicleId = trip.vehicleId;
    let driverData = null;
    let conflictingTrip = null;

    if (safeDriverId) {
      const driver = await prisma.driver.findUnique({
        where: { id: safeDriverId },
        include: {
          vehicle: true,
          trips: {
            where: {
              status: "ACTIVE",
            },
            include: {
              route: true,
              weeklySchedules: {
                where: {
                  status: { not: "CANCELLED" },
                },
              },
            },
          },
        },
      });

      if (!driver) {
        const errorResponse = badRequestResponse("Driver not found.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      driverData = driver;

      if (!driver.vehicle) {
        const errorResponse = badRequestResponse(
          `Driver ${driver.name} does not have a vehicle assigned. Please assign a vehicle to this driver first.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      console.log(
        `[updateTripDriver] Assigning driver ${driver.name} (status: ${driver.status}) to trip. Status doesn't prevent assignment.`,
      );

      newVehicleId = driver.vehicle.id;

      console.log(
        "[updateTripDriver] Driver:",
        driver.name,
        "Driver's Vehicle:",
        driver.vehicle.vehicleNumber,
        "Vehicle ID:",
        driver.vehicle.id,
      );

      conflictingTrip = await prisma.trip.findFirst({
        where: {
          driverId: safeDriverId,
          shiftTiming: trip.shiftTiming,
          status: defaultScheduleStatus(safeDriverId, newVehicleId),
          routeId: trip.routeId,
          id: { not: tripId },
          weeklySchedules: {
            some: {
              status: { not: "CANCELLED" },
            },
          },
        },
        include: {
          vehicle: true,
          driver: true,
          route: true,
          weeklySchedules: {
            where: {
              status: { not: "CANCELLED" },
            },
            include: {
              employee: true,
            },
          },
        },
      });

      if (conflictingTrip) {
        console.log(
          "[updateTripDriver] Driver has conflicting trip at same shift on SAME ROUTE:",
          conflictingTrip.id,
          "- Will merge employees",
        );

        const vehicleCapacity = driver.vehicle.capacity || 6;
        const currentEmployees = conflictingTrip.weeklySchedules.length;
        const employeesToMove = trip.weeklySchedules.length;
        const totalEmployees = currentEmployees + employeesToMove;

        if (totalEmployees > vehicleCapacity) {
          const errorResponse = badRequestResponse(
            `Cannot merge trips. Driver ${driver.name}'s trip on route ${conflictingTrip.route?.code || "N/A"} has ${currentEmployees} employees ` +
              `and this trip on route ${trip.route?.code || "N/A"} has ${employeesToMove} employees. Total (${totalEmployees}) exceeds ` +
              `vehicle capacity (${vehicleCapacity} seats). Please reduce employees or assign a larger vehicle.`,
          );
          return res.status(errorResponse.status.code).json(errorResponse);
        }

        const result = await prisma.$transaction(async (tx) => {
          await tx.weeklySchedule.updateMany({
            where: {
              tripId: tripId,
              status: { not: "CANCELLED" },
            },
            data: {
              tripId: conflictingTrip.id,
              routeId: conflictingTrip.routeId,
              driverId: safeDriverId,
              vehicleId: driver.vehicle.id,
              shiftTiming: conflictingTrip.shiftTiming,
            },
          });

          await tx.ride.deleteMany({
            where: {
              tripId: tripId,
              status: "PENDING",
            },
          });

          await tx.trip.delete({
            where: { id: tripId },
          });

          return { employeesMoved: employeesToMove };
        });

        await prisma.$transaction(
          (tx) =>
            finalizeOrphanedTripResources(tx, {
              driverId: trip.driverId,
              vehicleId: trip.vehicleId,
              routeId: trip.routeId,
            }),
          { timeout: 30000 }, // <-- exactly 30000
        );

        if (weekStart) {
          await syncPendingRidesForWeekBestEffort(
            toSaturdayUtcMidnight(weekStart),
            {
              driverIds: [trip.driverId, safeDriverId].filter(Boolean),
              tripIds: [tripId, conflictingTrip.id],
              vehicleIds: [trip.vehicleId, driver.vehicle.id].filter(Boolean),
              skipNotifications: true,
            },
          ).catch(() => {});
        }

        const mergedRouteLabel =
          conflictingTrip.route?.routeName ||
          conflictingTrip.route?.routeCode ||
          "the merged route";

        for (const sched of trip.weeklySchedules) {
          if (!sched.employeeId) continue;
          await notifyEmployeeById(
            sched.employeeId,
            {
              title: "Trip driver changed",
              body: `Your trip was merged onto ${mergedRouteLabel} with driver ${driver.name}.`,
              data: {
                type: "SCHEDULE_TRIP_MERGED",
                employeeId: sched.employeeId,
                tripId: conflictingTrip.id,
                routeId: conflictingTrip.routeId,
              },
              event: "schedule-updated",
            },
            { notifyAdmins: false },
          ).catch((err) =>
            console.error(
              "[updateTripDriver] Failed to notify moved employee:",
              err,
            ),
          );
        }

        if (trip.driverId && trip.driverId !== safeDriverId) {
          await notifyDriverById(
            trip.driverId,
            {
              title: "Trip merged",
              body: `Your trip on ${trip.route?.routeName || "your route"} was merged into another driver's trip and no longer needs you.`,
              data: { type: "TRIP_DRIVER_REMOVED", tripId },
              event: "schedule-updated",
            },
            { notifyAdmins: false },
          ).catch((err) =>
            console.error(
              "[updateTripDriver] Failed to notify previous driver:",
              err,
            ),
          );
        }

        await notifyDriverById(
          safeDriverId,
          {
            title: "Employees added to your trip",
            body: `${result.employeesMoved} employee(s) were merged into your trip on ${mergedRouteLabel}.`,
            data: {
              type: "TRIP_DRIVER_ASSIGNED",
              tripId: conflictingTrip.id,
              routeId: conflictingTrip.routeId,
            },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch((err) =>
          console.error("[updateTripDriver] Failed to notify new driver:", err),
        );

        const response = okResponse(
          {
            action: "MERGED_TRIPS",
            driver: driver.name,
            driverStatus: driver.status,
            vehicle: driver.vehicle.vehicleNumber,
            targetTripId: conflictingTrip.id,
            deletedTripId: tripId,
            employeesMoved: result.employeesMoved,
            totalEmployeesInTarget: totalEmployees,
            vehicleCapacity: vehicleCapacity,
            seatsRemaining: vehicleCapacity - totalEmployees,
            routeCode: conflictingTrip.route?.code || "N/A",
            message: `Employees merged into driver ${driver.name}'s existing trip on the same route. Empty trip deleted.`,
          },
          `Trip merged into existing trip on route ${conflictingTrip.route?.code || "N/A"}. ${result.employeesMoved} employee(s) moved to ${driver.name}'s trip with vehicle ${driver.vehicle.vehicleNumber}.`,
        );
        return res.status(response.status.code).json(response);
      }

      const otherTripsDifferentRoutes = driver.trips.filter(
        (t) =>
          t.id !== tripId &&
          t.shiftTiming === trip.shiftTiming &&
          t.routeId !== trip.routeId &&
          t.status === "ACTIVE",
      );

      if (otherTripsDifferentRoutes.length > 0) {
        console.log(
          `[updateTripDriver] Driver has ${otherTripsDifferentRoutes.length} other trip(s) at same shift but on DIFFERENT routes. ` +
            `These will remain separate trips. Routes: ${otherTripsDifferentRoutes.map((t) => t.route?.code || "N/A").join(", ")}`,
        );
      }

      const employeeCount = trip.weeklySchedules.length;
      const vehicleCapacity = driver.vehicle.capacity || 6;

      if (employeeCount > vehicleCapacity) {
        const errorResponse = badRequestResponse(
          `Trip has ${employeeCount} employees but driver's vehicle (${driver.vehicle.vehicleNumber}) has only ${vehicleCapacity} seats. ` +
            `Please assign a driver with a larger vehicle or reduce employees.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      if (driver.vehicle.status !== "ACTIVE") {
        const errorResponse = badRequestResponse(
          `Driver's vehicle ${driver.vehicle.vehicleNumber} is currently ${driver.vehicle.status}. Only ACTIVE vehicles can be used.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      console.log(
        "[updateTripDriver] Old vehicle:",
        trip.vehicle?.vehicleNumber,
        "→ New vehicle:",
        driver.vehicle.vehicleNumber,
      );
    }

    if (!safeDriverId) {
      if (trip.weeklySchedules.length > 0) {
        const errorResponse = badRequestResponse(
          `Cannot remove driver from trip with ${trip.weeklySchedules.length} employees. ` +
            `Please reassign employees first or assign a new driver.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const [updatedTrip, updatedSchedules, auditLog] = await prisma.$transaction(
      async (tx) => {
        const tripResult = await tx.trip.update({
          where: { id: tripId },
          data: {
            driverId: safeDriverId,
            vehicleId: newVehicleId,
          },
          include: {
            vehicle: true,
            driver: {
              include: {
                vehicle: true,
              },
            },
            route: true,
          },
        });

        const schedulesResult = await tx.weeklySchedule.updateMany({
          where: {
            tripId,
            status: { not: "CANCELLED" },
          },
          data: {
            driverId: safeDriverId,
            vehicleId: newVehicleId,
          },
        });

        const auditResult = await tx.auditLog.create({
          data: {
            userId: req.user?.id || null,
            action: "TRIP_DRIVER_UPDATE",
            model: "Trip",
            recordId: tripId,
            before: {
              driverId: trip.driverId,
              driverName: trip.driver?.name || null,
              vehicleId: trip.vehicleId,
              vehicleNumber: trip.vehicle?.vehicleNumber || null,
            },
            after: {
              driverId: safeDriverId,
              driverName: tripResult.driver?.name || null,
              vehicleId: newVehicleId,
              vehicleNumber: tripResult.vehicle?.vehicleNumber || null,
            },
            ipAddress: req.ip || req.connection.remoteAddress || null,
          },
        });

        return [tripResult, schedulesResult, auditResult];
      },
    );

    if (weekStart) {
      await syncPendingRidesForWeekBestEffort(
        toSaturdayUtcMidnight(weekStart),
        {
          driverIds: [trip.driverId, safeDriverId].filter(Boolean),
          tripIds: [tripId],
          vehicleIds: [trip.vehicleId, newVehicleId].filter(Boolean),
          routeIds: [trip.routeId, updatedTrip.routeId].filter(Boolean),
          skipNotifications: true,
        },
      ).catch(() => {});
    }

    if (trip.driverId !== safeDriverId) {
      const tripRouteLabel =
        updatedTrip.route?.routeName || trip.route?.routeName || "a route";

      if (trip.driverId) {
        await notifyDriverById(
          trip.driverId,
          {
            title: "Removed from trip",
            body: `You've been unassigned from your trip on ${tripRouteLabel}.`,
            data: { type: "TRIP_DRIVER_REMOVED", tripId },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch((err) =>
          console.error(
            "[updateTripDriver] Failed to notify previous driver:",
            err,
          ),
        );
      }

      if (safeDriverId) {
        await notifyDriverById(
          safeDriverId,
          {
            title: "New trip assigned",
            body: `You've been assigned to a trip on ${tripRouteLabel} with ${trip.weeklySchedules.length} employee(s).`,
            data: { type: "TRIP_DRIVER_ASSIGNED", tripId },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch((err) =>
          console.error("[updateTripDriver] Failed to notify new driver:", err),
        );
      }

      for (const sched of trip.weeklySchedules) {
        if (!sched.employeeId) continue;
        await notifyEmployeeById(
          sched.employeeId,
          {
            title: "Trip driver changed",
            body: `Your driver on ${tripRouteLabel} has changed to ${updatedTrip.driver?.name || "a new driver"}.`,
            data: { type: "SCHEDULE_TRIP_DRIVER_CHANGED", tripId },
            event: "schedule-updated",
          },
          { notifyAdmins: false },
        ).catch((err) =>
          console.error(
            "[updateTripDriver] Failed to notify affected employee:",
            err,
          ),
        );
      }
    }

    const response = okResponse(
      {
        action: "UPDATED_TRIP",
        trip: updatedTrip,
        driver: updatedTrip.driver,
        vehicle: updatedTrip.vehicle,
        previousVehicle: trip.vehicle?.vehicleNumber || "none",
        previousDriver: trip.driver?.name || "none",
        employeeCount: trip.weeklySchedules.length,
        vehicleCapacity: updatedTrip.vehicle?.capacity || 0,
        seatsRemaining: updatedTrip.vehicle
          ? (updatedTrip.vehicle.capacity || 0) - trip.weeklySchedules.length
          : 0,
        vehicleChanged: trip.vehicleId !== newVehicleId,
        driverChanged: trip.driverId !== safeDriverId,
        updatedSchedules: updatedSchedules.count || 0,
        message: `Driver and vehicle updated successfully. Driver can be assigned to multiple trips.`,
      },
      `Trip updated: Driver ${updatedTrip.driver?.name || "none"} with vehicle ${updatedTrip.vehicle?.vehicleNumber || "none"}.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.error("[updateTripDriver] Error:", error);
    next(error);
  }
};

const findExistingTripWithSeats = async ({
  areaId,
  shiftTiming,
  weekStart,
  excludeTripId,
}) => {
  if (!areaId || !shiftTiming) return null;

  const trips = await prisma.trip.findMany({
    where: {
      shiftTiming: shiftTiming,
      status: "ACTIVE",
      id: excludeTripId ? { not: excludeTripId } : undefined,
      route: {
        areaId: areaId,
      },
    },
    include: {
      weeklySchedules: {
        where: {
          status: { not: "CANCELLED" },
        },
      },
      route: true,
      driver: {
        include: {
          vehicle: true,
        },
      },
      vehicle: true,
    },
  });

  for (const trip of trips) {
    const vehicle = trip.vehicle || trip.driver?.vehicle;

    if (!vehicle) {
      console.log("[findExistingTrip] No vehicle found for trip:", trip.id);
      continue;
    }

    const maxSeats = vehicle.capacity || 6;
    const currentEmployees = trip.weeklySchedules.length;
    const availableSeats = maxSeats - currentEmployees;

    if (availableSeats > 0) {
      return {
        trip,
        route: trip.route,
        availableSeats,
        currentEmployees,
        maxSeats,
        vehicleNumber: vehicle.vehicleNumber,
        vehicleType: vehicle.type,
      };
    }
  }

  return null;
};

const mergeTrips = async (req, res, next) => {
  try {
    const { sourceTripId, targetTripId, weekStart } = req.body;

    if (!sourceTripId || !targetTripId) {
      const errorResponse = badRequestResponse(
        "Both sourceTripId and targetTripId are required.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (sourceTripId === targetTripId) {
      const errorResponse = badRequestResponse(
        "Cannot merge a trip with itself.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const [sourceTrip, targetTrip] = await Promise.all([
      prisma.trip.findUnique({
        where: { id: sourceTripId },
        include: {
          route: true,
          vehicle: true,
          driver: {
            include: {
              vehicle: true,
            },
          },
          weeklySchedules: {
            where: {
              status: { not: "CANCELLED" },
            },
            include: {
              employee: true,
            },
          },
        },
      }),
      prisma.trip.findUnique({
        where: { id: targetTripId },
        include: {
          route: true,
          vehicle: true,
          driver: {
            include: {
              vehicle: true,
            },
          },
          weeklySchedules: {
            where: {
              status: { not: "CANCELLED" },
            },
            include: {
              employee: true,
            },
          },
        },
      }),
    ]);

    if (!sourceTrip) {
      const errorResponse = badRequestResponse("Source trip not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (!targetTrip) {
      const errorResponse = badRequestResponse("Target trip not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (sourceTrip.shiftTiming !== targetTrip.shiftTiming) {
      const errorResponse = badRequestResponse(
        `Cannot merge trips with different shift timings. Source: ${sourceTrip.shiftTiming}, Target: ${targetTrip.shiftTiming}`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const isSameRoute = sourceTrip.routeId === targetTrip.routeId;
    const routeInfo = isSameRoute
      ? `same route (${sourceTrip.route?.code || "N/A"})`
      : `different routes (${sourceTrip.route?.code || "N/A"} → ${targetTrip.route?.code || "N/A"})`;

    console.log(`[mergeTrips] Merging trips on ${routeInfo}`);

    const targetDriverId = targetTrip.driverId;
    const targetVehicleId = targetTrip.vehicleId;
    const targetRouteId = targetTrip.routeId;
    const targetShiftTiming = targetTrip.shiftTiming;

    if (!targetDriverId || !targetVehicleId) {
      const errorResponse = badRequestResponse(
        "Target trip must have a driver and vehicle assigned before merging.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const targetDriver = await prisma.driver.findUnique({
      where: { id: targetDriverId },
      include: {
        vehicle: true,
      },
    });

    if (!targetDriver || !targetDriver.vehicle) {
      const errorResponse = badRequestResponse(
        "Target trip's driver or vehicle not found.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const vehicleCapacity = targetDriver.vehicle.capacity || 6;
    const sourceEmployeeCount = sourceTrip.weeklySchedules.length;
    const targetEmployeeCount = targetTrip.weeklySchedules.length;
    const totalEmployees = sourceEmployeeCount + targetEmployeeCount;

    if (totalEmployees > vehicleCapacity) {
      const errorResponse = badRequestResponse(
        `Cannot merge trips. Target trip has ${targetEmployeeCount} employees ` +
          `and source trip has ${sourceEmployeeCount} employees. Total (${totalEmployees}) exceeds ` +
          `vehicle capacity (${vehicleCapacity} seats). Please reduce employees or assign a larger vehicle.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (targetDriver.vehicle.status !== "ACTIVE") {
      const errorResponse = badRequestResponse(
        `Target driver's vehicle (${targetDriver.vehicle.vehicleNumber}) is currently ${targetDriver.vehicle.status}. Only ACTIVE vehicles can be used.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (!isSameRoute) {
      const existingTripsAtSameShift = await prisma.trip.findMany({
        where: {
          driverId: targetDriverId,
          shiftTiming: targetShiftTiming,
          status: "ACTIVE",
          id: { notIn: [sourceTripId, targetTripId] },
          weeklySchedules: {
            some: {
              status: { not: "CANCELLED" },
            },
          },
        },
      });

      if (existingTripsAtSameShift.length > 0) {
        console.log(
          `[mergeTrips] Warning: Driver already has ${existingTripsAtSameShift.length} other trip(s) at same shift.`,
        );
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const movedSchedules = await tx.weeklySchedule.updateMany({
        where: {
          tripId: sourceTripId,
          status: { not: "CANCELLED" },
        },
        data: {
          tripId: targetTripId,
          routeId: targetRouteId,
          driverId: targetDriverId,
          vehicleId: targetVehicleId,
          shiftTiming: targetShiftTiming,
        },
      });

      await tx.ride.deleteMany({
        where: {
          tripId: sourceTripId,
          status: "PENDING",
        },
      });

      await tx.trip.delete({
        where: { id: sourceTripId },
      });

      await tx.auditLog.create({
        data: {
          userId: req.user?.id || null,
          action: "TRIP_MERGE",
          model: "Trip",
          recordId: targetTripId,
          before: {
            sourceTripId: sourceTripId,
            sourceTripRoute: sourceTrip.route?.code || null,
            sourceTripEmployees: sourceEmployeeCount,
            targetTripId: targetTripId,
            targetTripRoute: targetTrip.route?.code || null,
            targetTripEmployees: targetEmployeeCount,
          },
          after: {
            mergedTripId: targetTripId,
            totalEmployees: totalEmployees,
            driverId: targetDriverId,
            driverName: targetDriver.name,
            vehicleId: targetVehicleId,
            vehicleNumber: targetDriver.vehicle.vehicleNumber,
            routeId: targetRouteId,
            routeCode: targetTrip.route?.code || null,
            isSameRoute: isSameRoute,
          },
          ipAddress: req.ip || req.connection.remoteAddress || null,
        },
      });

      return {
        employeesMoved: movedSchedules.count || 0,
        totalEmployees: totalEmployees,
      };
    });

    await prisma.$transaction(
      (tx) =>
        finalizeOrphanedTripResources(tx, {
          driverId: sourceTrip.driverId,
          vehicleId: sourceTrip.vehicleId,
          routeId: sourceTrip.routeId,
        }),
      { timeout: 30000 }, // <-- exactly 30000
    );

    if (weekStart) {
      await syncPendingRidesForWeekBestEffort(
        toSaturdayUtcMidnight(weekStart),
        {
          driverIds: [targetDriverId],
          tripIds: [targetTripId],
          vehicleIds: [targetVehicleId],
          routeIds: [targetRouteId],
          skipNotifications: true,
        },
      ).catch(() => {});
    }

    const mergedRouteLabel =
      targetTrip.route?.routeName ||
      targetTrip.route?.routeCode ||
      "the merged route";

    for (const sched of sourceTrip.weeklySchedules) {
      if (!sched.employeeId) continue;
      await notifyEmployeeById(
        sched.employeeId,
        {
          title: "Trip driver changed",
          body: `Your trip was merged onto ${mergedRouteLabel} with driver ${targetDriver.name}.`,
          data: {
            type: "SCHEDULE_TRIP_MERGED",
            employeeId: sched.employeeId,
            tripId: targetTripId,
            routeId: targetRouteId,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error("[mergeTrips] Failed to notify moved employee:", err),
      );
    }

    if (sourceTrip.driverId && sourceTrip.driverId !== targetDriverId) {
      await notifyDriverById(
        sourceTrip.driverId,
        {
          title: "Trip merged",
          body: `Your trip on ${sourceTrip.route?.routeName || "your route"} was merged into another driver's trip and no longer needs you.`,
          data: { type: "TRIP_DRIVER_REMOVED", tripId: sourceTripId },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error("[mergeTrips] Failed to notify previous driver:", err),
      );
    }

    await notifyDriverById(
      targetDriverId,
      {
        title: "Employees added to your trip",
        body: `${sourceEmployeeCount} employee(s) were merged into your trip on ${mergedRouteLabel}.`,
        data: {
          type: "TRIP_DRIVER_ASSIGNED",
          tripId: targetTripId,
          routeId: targetRouteId,
        },
        event: "schedule-updated",
      },
      { notifyAdmins: false },
    ).catch((err) =>
      console.error("[mergeTrips] Failed to notify new driver:", err),
    );

    const response = okResponse(
      {
        action: "TRIP_MERGED",
        sourceTripId: sourceTripId,
        targetTripId: targetTripId,
        sourceTripRoute: sourceTrip.route?.code || "N/A",
        targetTripRoute: targetTrip.route?.code || "N/A",
        isSameRoute: isSameRoute,
        employeesMoved: result.employeesMoved,
        totalEmployees: result.totalEmployees,
        vehicleCapacity: vehicleCapacity,
        seatsRemaining: vehicleCapacity - totalEmployees,
        driver: {
          id: targetDriver.id,
          name: targetDriver.name,
        },
        vehicle: {
          id: targetDriver.vehicle.id,
          number: targetDriver.vehicle.vehicleNumber,
          capacity: vehicleCapacity,
        },
        targetTrip: {
          id: targetTrip.id,
          shiftTiming: targetShiftTiming,
          route: targetTrip.route?.code || "N/A",
        },
        message: `Successfully merged ${sourceEmployeeCount} employee(s) from ${sourceTrip.route?.code || "N/A"} into ${targetTrip.route?.code || "N/A"}. Total employees: ${totalEmployees}/${vehicleCapacity} seats.`,
      },
      `Trip merge completed: ${sourceTrip.route?.code || "N/A"} (${sourceEmployeeCount} employees) → ${targetTrip.route?.code || "N/A"} (${targetEmployeeCount} employees). Total: ${totalEmployees}/${vehicleCapacity} seats.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.error("[mergeTrips] Error:", error);
    next(error);
  }
};

const reassignMismatchedShiftEmployees = async (req, res, next) => {
  try {
    const { routeCode, weekStart, employeeIds } = req.body;
    if (
      !routeCode ||
      !weekStart ||
      !employeeIds ||
      !Array.isArray(employeeIds) ||
      employeeIds.length === 0
    ) {
      const response = badRequestResponse(
        "routeCode, weekStart, and non-empty employeeIds are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toSaturdayUtcMidnight(weekStart);

    const route = await prisma.route.findUnique({
      where: { routeCode },
      include: { area: true },
    });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const employees = await prisma.employee.findMany({
      where: { id: { in: employeeIds } },
    });
    const foundIds = new Set(employees.map((e) => e.id));
    const missingIds = employeeIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      const response = badRequestResponse(
        `Employee IDs not found: ${missingIds.join(", ")}`,
      );
      return res.status(response.status.code).json(response);
    }

    const schedules = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: weekStartDate,
        status: { not: "CANCELLED" },
        employeeId: { in: employeeIds },
      },
      include: {
        employee: true,
        driver: { include: { vehicle: true } },
        vehicle: true,
        trip: {
          include: {
            weeklySchedules: true,
            rides: true,
            driver: { include: { vehicle: true } },
            vehicle: true,
          },
        },
      },
    });
    const scheduleByEmployee = new Map();
    schedules.forEach((s) => scheduleByEmployee.set(s.employeeId, s));

    const routeShiftNorm = normalizeShift(route.shiftTiming);
    const routePickupNorm = normalizeTime(
      computePickupTime(route.officeArrivalTime),
    );
    const routeArrivalNorm = normalizeTime(route.officeArrivalTime);
    const routeDropNorm = normalizeTime(route.dropTime);

    const workItems = [];
    for (const emp of employees) {
      const existing = scheduleByEmployee.get(emp.id);
      const effectiveShift =
        existing?.shiftTiming || emp.shiftTiming || route.shiftTiming;
      const effectiveArrival =
        existing?.officeArrivalTime || route.officeArrivalTime;
      const effectiveDrop = existing?.dropTime || route.dropTime;
      const effectivePickup = computePickupTime(effectiveArrival);

      const empShiftNorm = normalizeShift(effectiveShift);
      const empPickupNorm = normalizeTime(effectivePickup);
      const empArrivalNorm = normalizeTime(effectiveArrival);
      const empDropNorm = normalizeTime(effectiveDrop);

      const shiftMismatch = effectiveShift && empShiftNorm !== routeShiftNorm;
      const pickupMismatch =
        empPickupNorm && routePickupNorm && empPickupNorm !== routePickupNorm;
      const arrivalMismatch =
        empArrivalNorm &&
        routeArrivalNorm &&
        empArrivalNorm !== routeArrivalNorm;
      const dropMismatch =
        empDropNorm && routeDropNorm && empDropNorm !== routeDropNorm;

      const isMismatch =
        !existing ||
        shiftMismatch ||
        pickupMismatch ||
        arrivalMismatch ||
        dropMismatch;

      if (isMismatch) {
        workItems.push({
          employee: emp,
          existing,
          newShiftTiming: effectiveShift,
          newPickupTime: effectivePickup,
          newOfficeArrivalTime: effectiveArrival,
          newDropTime: effectiveDrop,
        });
      }
    }

    if (workItems.length === 0) {
      const response = okResponse(
        { updated: 0, created: 0, details: [] },
        "No mismatched employees found.",
      );
      return res.status(response.status.code).json(response);
    }

    const groups = new Map();
    workItems.forEach((w) => {
      const key = [
        normalizeShift(w.newShiftTiming) || "",
        normalizeTime(w.newPickupTime) || "",
        normalizeTime(w.newOfficeArrivalTime) || "",
        normalizeTime(w.newDropTime) || "",
      ].join("|");
      if (!groups.has(key))
        groups.set(key, {
          shiftTiming: w.newShiftTiming,
          pickupTime: w.newPickupTime,
          officeArrivalTime: w.newOfficeArrivalTime,
          dropTime: w.newDropTime,
          items: [],
        });
      groups.get(key).items.push(w);
    });

    const areaRecord = route.area || null;
    const results = {
      updated: 0,
      created: 0,
      routesCreated: 0,
      legsOpened: 0,
      tripsDeleted: 0,
      ridesDeleted: 0,
      driversFreed: 0,
      vehiclesFreed: 0,
      details: [],
      deletedTrips: [],
    };

    const movedScheduleIds = new Set();
    const affectedTripIds = new Set();
    const affectedRouteIds = new Set([route.id]);
    const affectedDriverIds = new Set();
    const oldTripIds = new Set();

    for (const group of groups.values()) {
      const {
        shiftTiming: newShiftTiming,
        pickupTime: newPickupTime,
        officeArrivalTime: newOfficeArrivalTime,
        dropTime: newDropTime,
        items,
      } = group;

      for (const item of items) {
        const { employee: emp, existing } = item;
        if (existing?.tripId) oldTripIds.add(existing.tripId);

        const existingTripResult = await findExistingTripWithSeats({
          areaId: areaRecord?.id,
          shiftTiming: newShiftTiming,
          weekStart: weekStartDate,
          excludeTripId: existing?.tripId || null,
        });

        let targetRouteId;
        let targetTripId;
        let targetDriverId = null;
        let targetVehicleId = null;
        let targetVehicleEntity = null;
        let action;
        let detailExtra = {};

        if (existingTripResult) {
          targetRouteId = existingTripResult.route.id;
          targetTripId = existingTripResult.trip.id;
          targetDriverId = existingTripResult.trip.driverId || null;
          targetVehicleId = existingTripResult.trip.vehicleId || null;
          targetVehicleEntity =
            existingTripResult.trip.vehicle?.vehicleEntity || null;
          action = existing
            ? "MOVED_TO_EXISTING_TRIP"
            : "CREATED_SCHEDULE_ON_EXISTING_TRIP";
          detailExtra = {
            newRouteCode: existingTripResult.route.routeCode,
            newTripNumber: existingTripResult.trip.tripNumber,
            vehicleNumber: existingTripResult.vehicleNumber,
            vehicleType: existingTripResult.vehicleType,
            maxSeats: existingTripResult.maxSeats,
            seatsRemaining: existingTripResult.availableSeats - 1,
          };
        } else {
          const routeResult = await findOrCreateRouteAndTrip(
            areaRecord,
            undefined,
            newShiftTiming,
            undefined,
            undefined,
            undefined,
            weekStartDate,
            emp.id,
            undefined,
            {
              trustProposedDriver: true,
              disableMultiTrip: false,
              allowCreate: true,
            },
            null,
            emp.officeLocation || null,
            null,
            emp.subAreaId || undefined,
            emp.serviceType || undefined,
            newPickupTime || undefined,
            newOfficeArrivalTime || undefined,
            newDropTime || undefined,
          );
          if (routeResult.created) results.routesCreated++;
          if (routeResult.newTrip) results.legsOpened++;
          targetRouteId = routeResult.route.id;
          targetTripId = routeResult.trip.id;
          targetDriverId = routeResult.trip.driverId || null;
          targetVehicleId = routeResult.trip.vehicleId || null;
          targetVehicleEntity = routeResult.trip.vehicle?.vehicleEntity || null;
          action = existing ? "CREATED_NEW_TRIP" : "CREATED_NEW_SCHEDULE";
          detailExtra = {
            newRouteCode: routeResult.route.routeCode,
            newTripNumber: routeResult.trip.tripNumber,
          };
        }

        if (targetDriverId) {
          const targetDriver = await prisma.driver.findUnique({
            where: { id: targetDriverId },
            include: { vehicle: true },
          });
          targetVehicleId = targetDriver?.vehicle?.id || targetVehicleId;
          targetVehicleEntity =
            targetDriver?.vehicle?.vehicleEntity || targetVehicleEntity;
        }

        if (targetTripId && targetDriverId) {
          await prisma.trip.update({
            where: { id: targetTripId },
            data: {
              driverId: targetDriverId,
              vehicleId: targetVehicleId,
            },
          });
        }

        const normalizedVehicleEntity =
          normalizeEntity(targetVehicleEntity) ||
          normalizeEntity(existing?.vehicleEntity) ||
          null;

        const scheduleData = {
          employeeId: emp.id,
          weekStart: weekStartDate,
          routeId: targetRouteId,
          tripId: targetTripId,
          driverId: targetDriverId,
          vehicleId: targetVehicleId,
          vehicleEntity: normalizedVehicleEntity || null,
          vendorId:
            (targetDriverId
              ? (
                  await prisma.driver.findUnique({
                    where: { id: targetDriverId },
                    select: { vendorId: true },
                  })
                )?.vendorId
              : null) ||
            existing?.vendorId ||
            null,
          shiftTiming: newShiftTiming,
          pickupTime: newPickupTime ? new Date(newPickupTime) : null,
          officeArrivalTime: newOfficeArrivalTime
            ? new Date(newOfficeArrivalTime)
            : null,
          dropTime: newDropTime ? new Date(newDropTime) : null,
          offDay: existing?.offDay ?? null,
          serviceType: emp.serviceType || route.serviceType || "PICK_AND_DROP",
          status: defaultScheduleStatus(targetDriverId, targetVehicleId),
        };

        let savedSchedule;
        if (existing) {
          savedSchedule = await prisma.weeklySchedule.update({
            where: { id: existing.id },
            data: scheduleData,
          });
          results.updated++;
        } else {
          savedSchedule = await prisma.weeklySchedule.create({
            data: scheduleData,
          });
          results.created++;
        }

        movedScheduleIds.add(savedSchedule.id);
        affectedTripIds.add(targetTripId);
        affectedRouteIds.add(targetRouteId);
        if (targetDriverId) affectedDriverIds.add(targetDriverId);
        if (existing?.routeId) affectedRouteIds.add(existing.routeId);
        if (existing?.driverId) affectedDriverIds.add(existing.driverId);

        results.details.push({
          scheduleId: savedSchedule.id,
          employeeId: emp.id,
          action,
          newShiftTiming,
          newRouteId: targetRouteId,
          newTripId: targetTripId,
          ...detailExtra,
        });
      }
    }

    for (const tripId of oldTripIds) {
      const orphaned = await deleteTripIfOrphaned(tripId);
      if (orphaned) {
        results.tripsDeleted++;
      }
    }

    if (results.updated > 0 || results.created > 0) {
      // Bulk operation. Let rideSync send one notification per affected
      // employee/driver (Set-deduped). Controller does not notify here.
      await syncPendingRidesForWeekBestEffort(weekStartDate, {
        tripIds: Array.from(affectedTripIds),
        driverIds: Array.from(affectedDriverIds).filter(Boolean),
      });
    }

    const response = okResponse(
      results,
      `Reassigned ${results.updated} updated, ${results.created} created. ${results.tripsDeleted} empty trip(s) deleted.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getCurrentWeekSchedules = async (req, res, next) => {
  try {
    const startOfWeek = saturdayOfCurrentWeek();

    const schedules = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: {
          gte: startOfWeek,
          lt: new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
        status: "ACTIVE",
      },
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
        route: true,
        trip: { include: { vehicle: true, driver: true } },
        driver: true,
        vehicle: true,
      },
    });

    const response = okResponse(
      schedules,
      "Current week schedules retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeScheduleRange = async (req, res, next) => {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;

    const where = { employeeId };

    if (startDate && endDate) {
      where.weekStart = {
        gte: toDateOnly(startDate),
        lte: toDateOnly(endDate),
      };
    }

    const schedules = await prisma.weeklySchedule.findMany({
      where,
      include: {
        route: true,
        trip: { include: { vehicle: true, driver: true } },
        driver: true,
        vehicle: true,
      },
      orderBy: { weekStart: "desc" },
    });

    const response = okResponse(
      schedules,
      "Employee schedule range retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getGroupedSchedules = async (req, res, next) => {
  try {
    const {
      weeks = 1,
      search,
      routeId,
      page = 1,
      limit = 10,
      sortBy = "routeCode",
      sortOrder = "asc",
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNumber - 1) * pageSize;
    const take = pageSize;

    const where = {};
    if (routeId) where.routeId = routeId;
    if (search) {
      where.OR = [
        { employee: { name: { contains: search, mode: "insensitive" } } },
        {
          employee: { employeeCode: { contains: search, mode: "insensitive" } },
        },
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        {
          vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } },
        },
      ];
    }

    const distinctWeeks = await prisma.weeklySchedule.findMany({
      where,
      distinct: ["weekStart"],
      orderBy: { weekStart: "desc" },
      take: parseInt(weeks),
      select: { weekStart: true },
    });
    const weekStarts = distinctWeeks.map((w) => w.weekStart);

    const schedules = await prisma.weeklySchedule.findMany({
      where: { ...where, weekStart: { in: weekStarts } },
      include: {
        employee: { select: { id: true, name: true, employeeCode: true } },
        route: {
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            area: true,
            shiftTiming: true,
          },
        },
        trip: {
          select: {
            id: true,
            tripNumber: true,
            driver: true,
            vehicle: {
              select: { id: true, vehicleNumber: true, capacity: true },
            },
          },
        },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
      orderBy: [
        { weekStart: "desc" },
        { employee: { name: "asc" } },
        { id: "asc" },
      ],
    });

    const routeMap = new Map();

    for (const s of schedules) {
      const routeKey = s.route?.id ?? "unassigned";
      if (!routeMap.has(routeKey)) {
        routeMap.set(routeKey, {
          code: s.route?.routeCode ?? "—",
          name: s.route?.routeName ?? "Unassigned Route",
          area: s.route?.area ?? "",
          shift: s.route?.shiftTiming ?? s.shiftTiming ?? "",
          service: s.serviceType,
          driverBadge: s.driver?.name ?? "—",
          vehicleBadge: s.vehicle?.vehicleNumber ?? "—",
          tripMap: new Map(),
          empIds: new Set(),
          weekMap: new Map(),
        });
      }
      const routeEntry = routeMap.get(routeKey);
      routeEntry.empIds.add(s.employeeId);

      if (s.tripId) {
        if (!routeEntry.tripMap.has(s.tripId)) {
          routeEntry.tripMap.set(s.tripId, { empIds: new Set() });
        }
        routeEntry.tripMap.get(s.tripId).empIds.add(s.employeeId);
      }

      const weekKey = formatDateOnly(s.weekStart);
      if (!routeEntry.weekMap.has(weekKey)) {
        routeEntry.weekMap.set(weekKey, { weekOf: weekKey, rows: [] });
      }

      routeEntry.weekMap.get(weekKey).rows.push({
        id: s.id,
        employeeId: s.employeeId,
        empId: s.employee?.employeeCode ?? s.employeeId,
        name: s.employee?.name ?? "Unknown",
        area: s.route?.area ?? "",
        shift: s.shiftTiming ?? "",
        service: s.serviceType,
        pick: toIsoOrNull(s.pickupTime) ?? "-",
        arrival: toIsoOrNull(s.officeArrivalTime) ?? "-",
        drop: toIsoOrNull(s.dropTime) ?? "-",
        driver: s.driver?.name ?? "-",
        vehicle: s.vehicle?.vehicleNumber ?? "-",
        tripNumber: s.trip?.tripNumber ?? null,
        pattern: DAY_KEYS.map((day) => s[day] ?? "OFF"),
        status: (s.status ?? "ACTIVE").toLowerCase(),
      });
    }

    for (const routeEntry of routeMap.values()) {
      for (const weekEntry of routeEntry.weekMap.values()) {
        weekEntry.rows.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    const routeIdsForTrips = Array.from(routeMap.keys()).filter(
      (k) => k !== "unassigned",
    );
    const tripsByRoute = routeIdsForTrips.length
      ? await prisma.trip.findMany({
          where: { routeId: { in: routeIdsForTrips }, status: "ACTIVE" },
          include: {
            vehicle: {
              select: { id: true, vehicleNumber: true, capacity: true },
            },
            driver: { select: { id: true, name: true } },
          },
          orderBy: { tripNumber: "asc" },
        })
      : [];
    for (const t of tripsByRoute) {
      const routeEntry = routeMap.get(t.routeId);
      if (!routeEntry) continue;
      const existingRiders = routeEntry.tripMap.get(t.id)?.empIds ?? new Set();
      routeEntry.tripMap.set(t.id, {
        id: t.id,
        tripNumber: t.tripNumber,
        capacity: t.vehicle?.capacity ?? null,
        driverId: t.driverId ?? null,
        driverName: t.driver?.name ?? null,
        vehicleNumber: t.vehicle?.vehicleNumber ?? null,
        empIds: existingRiders,
      });
    }

    let routes = Array.from(routeMap.values())
      .map((r) => {
        const trips = Array.from(r.tripMap.values())
          .filter((t) => t.tripNumber != null)
          .sort((a, b) => a.tripNumber - b.tripNumber)
          .map((t) => ({
            id: t.id,
            tripNumber: t.tripNumber,
            capacity: t.capacity,
            driver: t.driverName ?? "—",
            driverId: t.driverId ?? null,
            vehicle: t.vehicleNumber ?? "—",
            assignedEmployees: t.empIds.size,
            remainingSeats:
              t.capacity != null
                ? Math.max(t.capacity - t.empIds.size, 0)
                : null,
          }));

        const firstTrip = Array.from(r.tripMap.values())
          .filter((t) => t.tripNumber != null)
          .sort((a, b) => a.tripNumber - b.tripNumber)[0];

        return {
          code: r.code,
          name: r.name,
          area: r.area,
          shift: r.shift,
          service: r.service,
          driverBadge:
            r.driverBadge !== "—"
              ? r.driverBadge
              : (firstTrip?.driverName ?? "—"),
          vehicleBadge:
            r.vehicleBadge !== "—"
              ? r.vehicleBadge
              : (firstTrip?.vehicleNumber ?? "—"),
          empCount: r.empIds.size,
          multiTrip: trips.length > 1,
          trips,
          weeks: Array.from(r.weekMap.values()).sort((a, b) =>
            b.weekOf.localeCompare(a.weekOf),
          ),
        };
      })
      .sort((a, b) => {
        if (a.code === "—") return 1;
        if (b.code === "—") return -1;

        switch (sortBy) {
          case "empCount":
            return sortOrder === "asc"
              ? a.empCount - b.empCount
              : b.empCount - a.empCount;
          case "area":
            return sortOrder === "asc"
              ? a.area.localeCompare(b.area)
              : b.area.localeCompare(a.area);
          case "shift":
            return sortOrder === "asc"
              ? a.shift.localeCompare(b.shift)
              : b.shift.localeCompare(a.shift);
          case "routeCode":
          default:
            return sortOrder === "asc"
              ? a.code.localeCompare(b.code, undefined, {
                  numeric: true,
                  sensitivity: "base",
                })
              : b.code.localeCompare(a.code, undefined, {
                  numeric: true,
                  sensitivity: "base",
                });
        }
      });

    const totalRoutes = routes.length;
    const totalPages = Math.ceil(totalRoutes / pageSize);
    const hasNextPage = pageNumber < totalPages;
    const hasPrevPage = pageNumber > 1;

    routes = routes.slice(skip, skip + take);

    const response = okResponse(
      {
        data: routes,
        pagination: {
          page: pageNumber,
          limit: pageSize,
          totalCount: totalRoutes,
          totalPages,
          hasNextPage,
          hasPrevPage,
          nextPage: hasNextPage ? pageNumber + 1 : null,
          prevPage: hasPrevPage ? pageNumber - 1 : null,
        },
      },
      `Grouped weekly schedules retrieved successfully. Showing page ${pageNumber} of ${totalPages || 1} (${totalRoutes} routes total).`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getScheduleStats = async (req, res, next) => {
  try {
    const totalEntries = await prisma.weeklySchedule.count();

    const [activeRoutesResult, weeksOnFileResult, employeesResult] =
      await Promise.all([
        prisma.$queryRaw`SELECT COUNT(DISTINCT "routeId") as count FROM "WeeklySchedule" WHERE "status" = 'ACTIVE'`,
        prisma.$queryRaw`SELECT COUNT(DISTINCT "weekStart") as count FROM "WeeklySchedule"`,
        prisma.$queryRaw`SELECT COUNT(DISTINCT "employeeId") as count FROM "WeeklySchedule"`,
      ]);

    const activeRoutes = Number(activeRoutesResult[0]?.count ?? 0);
    const weeksOnFile = Number(weeksOnFileResult[0]?.count ?? 0);
    const employees = Number(employeesResult[0]?.count ?? 0);

    const response = okResponse(
      {
        totalEntries,
        activeRoutes,
        weeksOnFile,
        employees,
      },
      "Schedule stats retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getScheduleTableStats = async (req, res, next) => {
  try {
    const weekStartDate = req.query.weekStart
      ? toSaturdayUtcMidnight(req.query.weekStart)
      : saturdayOfCurrentWeek();

    const [
      activeEmployees,
      areasCount,
      availableDrivers,
      activeVehicles,
      scheduledThisWeek,
    ] = await Promise.all([
      prisma.employee.count({ where: { status: "ACTIVE" } }),
      prisma.area.count(),
      prisma.driver.count({ where: { status: "AVAILABLE" } }),
      prisma.vehicle.count({ where: { status: "ACTIVE" } }),
      prisma.weeklySchedule.count({
        where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
      }),
    ]);

    const response = okResponse(
      {
        activeEmployees,
        areas: areasCount,
        availableDrivers,
        activeVehicles,
        scheduledThisWeek,
        weekStart: weekStartDate.toISOString().slice(0, 10),
      },
      "Schedule table stats retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getScheduleTableGroupedByArea = async (req, res, next) => {
  try {
    const { search, areaId } = req.query;
    const weekStartDate = req.query.weekStart
      ? toSaturdayUtcMidnight(req.query.weekStart)
      : saturdayOfCurrentWeek();

    const where = { status: "ACTIVE" };
    if (areaId) where.areaId = areaId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { employeeCode: { contains: search, mode: "insensitive" } },
        { area: { name: { contains: search, mode: "insensitive" } } },
        { department: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const employees = await prisma.employee.findMany({
      where,
      include: {
        area: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        weeklySchedules: {
          where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
          take: 1,
          include: {
            route: { select: { id: true, routeName: true, routeCode: true } },
            trip: { select: { id: true, tripNumber: true } },
            driver: { select: { id: true, name: true, phone: true } },
            vehicle: { select: { id: true, vehicleNumber: true, type: true } },
          },
        },
      },
      orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
    });

    const groupMap = new Map();

    for (const emp of employees) {
      const schedule = emp.weeklySchedules[0] || null;

      const groupKey = schedule
        ? schedule.driverId
          ? `driver:${schedule.driverId}:${schedule.vehicleId ?? "novehicle"}:${schedule.shiftTiming ?? ""}`
          : schedule.tripId
            ? `trip:${schedule.tripId}`
            : `nodriver:${schedule.id}`
        : `area:${emp.area?.id ?? "unassigned"}`;

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          areaId: emp.area?.id ?? null,
          area: emp.area?.name ?? "Unassigned",
          route: schedule?.route
            ? {
                id: schedule.route.id,
                name: schedule.route.routeName,
                code: schedule.route.routeCode,
              }
            : null,
          tripNumber: schedule?.trip?.tripNumber ?? null,
          driver: schedule?.driver
            ? {
                id: schedule.driver.id,
                name: schedule.driver.name,
                phone: schedule.driver.phone,
              }
            : null,
          vehicle: schedule?.vehicle
            ? {
                id: schedule.vehicle.id,
                number: schedule.vehicle.vehicleNumber,
                type: schedule.vehicle.type,
              }
            : null,
          shift: schedule?.shiftTiming ?? null,
          areas: new Set(),
          rows: [],
        });
      }

      const group = groupMap.get(groupKey);
      group.areas.add(emp.area?.name ?? "Unassigned");

      group.rows.push({
        id: schedule?.id ?? emp.id,
        empId: emp.employeeCode,
        name: emp.name,
        department: emp.department?.name ?? "-",
        location: emp.officeLocation ?? "-",
        entity: emp.entity ?? "-",
        contact: emp.contactNumber ?? "-",
        area: emp.area?.name ?? "Unassigned",
        scheduled: Boolean(schedule),
        scheduleStatus: schedule?.status ?? null,
        service: schedule?.serviceType ?? emp.serviceType,
        shift: schedule?.shiftTiming ?? null,
        pickupTime: toIsoOrNull(schedule?.pickupTime),
        dropTime: toIsoOrNull(schedule?.dropTime),
        offDay: schedule?.offDay ?? null,
        route: schedule?.route
          ? {
              id: schedule.route.id,
              name: schedule.route.routeName,
              code: schedule.route.routeCode,
            }
          : null,
        tripNumber: schedule?.trip?.tripNumber ?? null,
        driver: schedule?.driver
          ? {
              id: schedule.driver.id,
              name: schedule.driver.name,
              phone: schedule.driver.phone,
            }
          : null,
        vehicle: schedule?.vehicle
          ? {
              id: schedule.vehicle.id,
              number: schedule.vehicle.vehicleNumber,
              type: schedule.vehicle.type,
            }
          : null,
        pattern: schedule ? DAY_KEYS.map((day) => schedule[day]) : null,
      });
    }

    const groups = Array.from(groupMap.values()).map((g) => ({
      ...g,
      areas: Array.from(g.areas),
      employeeCount: g.rows.length,
      scheduledCount: g.rows.filter((r) => r.scheduled).length,
    }));

    const response = okResponse(
      { weekStart: weekStartDate.toISOString().slice(0, 10), groups },
      "Schedule table grouped by area retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getDriverOptions = async (req, res, next) => {
  try {
    const drivers = await prisma.driver.findMany({
      where: {
        vehicle: {
          isNot: null,
        },
      },
      select: {
        id: true,
        name: true,
        status: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    const response = okResponse(
      drivers,
      "Available driver options retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getBulkUploadStatus = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const job = await getBulkUploadJobStatus(jobId);
    if (!job) {
      const response = badRequestResponse("Unknown or expired upload job id.");
      return res.status(response.status.code).json(response);
    }

    const percent = job.totalRows
      ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100))
      : job.status === "completed"
        ? 100
        : 0;

    const response = okResponse(
      {
        jobId,
        status: job.status,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
        batchSize: job.batchSize,
        totalBatches: job.totalBatches,
        batchesCompleted: job.batchesCompleted,
        percent,
        result: job.status === "completed" ? job.result : null,
        error: job.status === "failed" ? job.error : null,
      },
      "Bulk upload job status.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const validateBulkUploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field.",
      );
      return res.status(response.status.code).json(response);
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (parseError) {
      const response = badRequestResponse(
        "Couldn't read that file as an .xlsx/.xls workbook.",
      );
      return res.status(response.status.code).json(response);
    }

    const sheetsReport = [];
    let anyValidRows = false;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      });

      const headerRowIndex = rows.findIndex((r) =>
        r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
      );

      if (headerRowIndex === -1) {
        sheetsReport.push({
          sheet: sheetName,
          headerFound: false,
          validRows: 0,
          warnings: ["No 'Employee ID' header found"],
        });
        continue;
      }

      const colIndex = {};
      rows[headerRowIndex].forEach((cell, i) => {
        const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
        if (key) colIndex[key] = i;
      });

      const get = (raw, key) =>
        colIndex[key] !== undefined
          ? String(raw[colIndex[key]] ?? "").trim()
          : "";

      const dataRows = rows.slice(headerRowIndex + 1);
      let validRows = 0;
      for (const raw of dataRows) {
        const employeeCode = get(raw, "employeeCode");
        if (employeeCode && /^\d+$/.test(employeeCode)) validRows++;
      }
      if (validRows > 0) anyValidRows = true;

      const mappedFields = Object.entries(colIndex)
        .filter(([key]) => key !== "employeeCode")
        .map(([key]) => key);

      const warnings = [];
      if (validRows === 0) warnings.push("No valid data rows found");
      if (!colIndex.name) warnings.push("Missing 'User Name' column");
      if (!colIndex.shiftTiming)
        warnings.push("Missing 'Shift Timings' column");

      sheetsReport.push({
        sheet: sheetName,
        headerFound: true,
        validRows,
        mappedFields,
        warnings,
      });
    }

    const result = {
      canProceed: anyValidRows,
      sheets: sheetsReport,
    };

    const response = okResponse(result, "Workbook format checked.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateSchedule = async (req, res, next) => {
  try {
    console.log("[updateSchedule] received updateSchedule request", {
      hasFile: Boolean(req.file),
      weekStart: req.body?.weekStart,
      fileSize: req.file?.buffer?.length || 0,
    });

    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field.",
      );
      return res.status(response.status.code).json(response);
    }

    const { weekStart } = req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Saturday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toSaturdayUtcMidnight(weekStart);

    const tempFilePath = path.join(
      os.tmpdir(),
      `update-schedule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`,
    );
    await fs.writeFile(tempFilePath, req.file.buffer);

    let jobResult;
    try {
      jobResult = await enqueueUpdateSchedule(
        tempFilePath,
        weekStartDate,
        DEFAULT_BATCH_SIZE,
      );
    } catch (enqueueError) {
      console.error("[updateSchedule] enqueue failed", {
        error: enqueueError?.message,
      });
      await fs.unlink(tempFilePath).catch(() => {});
      throw enqueueError;
    }

    if (jobResult.conflict) {
      await fs.unlink(tempFilePath).catch(() => {});
      const response = {
        status: { code: 409, status: false },
        message: `A schedule update for the week of ${weekStart} is already running.`,
        data: { existingJobId: jobResult.existingJobId },
      };
      return res.status(response.status.code).json(response);
    }

    const response = okResponse(
      {
        action: "UPDATE_SCHEDULE",
        weekStart: weekStartDate.toISOString().slice(0, 10),
        matchedEmployees: 0,
        changedEmployees: 0,
        processedEmployees: 0,
        jobId: jobResult.jobId,
        status: "queued",
        message: "Queued matched employee schedule comparison and update scan.",
      },
      "Matched employees are being checked in the background queue.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.error("[updateSchedule] Error:", error);
    next(error);
  }
};

const bulkUploadWeeklySchedule = async (req, res, next) => {
  try {
    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field.",
      );
      return res.status(response.status.code).json(response);
    }

    const { weekStart, batchSize: batchSizeRaw } = req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Saturday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toSaturdayUtcMidnight(weekStart);

    let batchSize = DEFAULT_BATCH_SIZE;
    if (batchSizeRaw !== undefined && batchSizeRaw !== "") {
      const parsed = parseInt(batchSizeRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const response = badRequestResponse(
          `batchSize must be a positive whole number (between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}).`,
        );
        return res.status(response.status.code).json(response);
      }
      batchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, parsed));
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (parseError) {
      const response = badRequestResponse(
        "Couldn't read that file as an .xlsx/.xls workbook.",
      );
      return res.status(response.status.code).json(response);
    }

    let totalRows = 0;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      });
      const headerRowIndex = rows.findIndex((r) =>
        r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
      );
      if (headerRowIndex === -1) continue;
      totalRows += rows.slice(headerRowIndex + 1).filter((r) => {
        const first = String(r[0] ?? "").trim();
        return first.length > 0;
      }).length;
    }

    const tempFilePath = path.join(
      os.tmpdir(),
      `bulk-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`,
    );
    await fs.writeFile(tempFilePath, req.file.buffer);

    let jobResult;
    try {
      jobResult = await enqueueBulkUpload(
        tempFilePath,
        weekStartDate,
        batchSize,
      );
    } catch (enqueueError) {
      await fs.unlink(tempFilePath).catch(() => {});
      throw enqueueError;
    }
    if (jobResult.conflict) {
      await fs.unlink(tempFilePath).catch(() => {});
      const response = {
        status: { code: 409, status: false },
        message: `A bulk upload for the week of ${weekStart} is already running.`,
        data: { existingJobId: jobResult.existingJobId },
      };
      return res.status(response.status.code).json(response);
    }
    const jobId = jobResult.jobId;

    console.log(`[weeklySchedule][job ${jobId}] queued for processing.`);

    const response = okResponse(
      {
        jobId,
        totalRows,
        batchSize,
        totalBatches: totalRows ? Math.ceil(totalRows / batchSize) : 0,
      },
      "Bulk upload started with capacity-aware assignment. Poll bulk-upload-status/:jobId for progress.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteAllWeeklySchedules = async (req, res, next) => {
  try {
    const { weekStart, confirm } = req.body;

    if (!weekStart) {
      const errorResponse = badRequestResponse(
        "weekStart is required. Please provide the week starting date.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (confirm !== true) {
      const errorResponse = badRequestResponse(
        "Please confirm this action by setting confirm: true",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const parsedWeekStart = new Date(weekStart);
    if (isNaN(parsedWeekStart.getTime())) {
      const errorResponse = badRequestResponse(
        "Invalid weekStart date format. Please use YYYY-MM-DD.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    const weekStartDate = toSaturdayUtcMidnight(parsedWeekStart);

    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekEndDate.getDate() + 7);

    const schedulesToDelete = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: {
          gte: weekStartDate,
          lt: weekEndDate,
        },
        status: { not: "CANCELLED" },
      },
      select: {
        id: true,
        employeeId: true,
        routeId: true,
        tripId: true,
        driverId: true,
        route: {
          select: {
            routeCode: true,
          },
        },
      },
    });

    if (schedulesToDelete.length === 0) {
      const response = okResponse(
        {
          deleted: 0,
          message: `No schedules found for week ${weekStart}`,
        },
        "No schedules found to delete.",
      );
      return res.status(response.status.code).json(response);
    }

    const tripIds = [
      ...new Set(schedulesToDelete.map((s) => s.tripId).filter(Boolean)),
    ];

    const routeIds = [
      ...new Set(schedulesToDelete.map((s) => s.routeId).filter(Boolean)),
    ];

    const employeeIds = schedulesToDelete.map((s) => s.employeeId);

    const scheduleIds = schedulesToDelete.map((s) => s.id);

    const stats = {
      totalSchedules: schedulesToDelete.length,
      tripsAffected: tripIds.length,
      routesAffected: routeIds.length,
      employeeCount: schedulesToDelete.length,
    };

    const result = await prisma.$transaction(
      async (tx) => {
        const ridesToDelete = await tx.ride.findMany({
          where: {
            OR: [
              { tripId: { in: tripIds } },
              {
                passengers: {
                  some: {
                    employeeId: { in: employeeIds },
                  },
                },
              },
            ],
          },
          select: {
            id: true,
          },
        });

        const rideIds = ridesToDelete.map((r) => r.id);

        if (rideIds.length > 0) {
          await tx.ridePassenger.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        if (rideIds.length > 0) {
          await tx.attendance.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        if (rideIds.length > 0) {
          await tx.complaint.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        const ridesDeleted = await tx.ride.deleteMany({
          where: {
            id: { in: rideIds },
          },
        });

        const schedulesDeleted = await tx.weeklySchedule.deleteMany({
          where: {
            weekStart: {
              gte: weekStartDate,
              lt: weekEndDate,
            },
            status: { not: "CANCELLED" },
          },
        });

        const tripsWithNoSchedules = await tx.trip.findMany({
          where: {
            id: {
              in: tripIds,
            },
            weeklySchedules: {
              none: {},
            },
          },
          select: {
            id: true,
            tripNumber: true,
            driverId: true,
            vehicleId: true,
            driver: {
              select: {
                name: true,
              },
            },
            vehicle: {
              select: {
                vehicleNumber: true,
              },
            },
            route: {
              select: {
                routeCode: true,
              },
            },
          },
        });

        const tripsDeleted = await tx.trip.deleteMany({
          where: {
            id: {
              in: tripsWithNoSchedules.map((t) => t.id),
            },
          },
        });

        const routesWithNoSchedules = await tx.route.findMany({
          where: {
            id: {
              in: routeIds,
            },
            weeklySchedules: {
              none: {},
            },
          },
          select: {
            id: true,
            routeCode: true,
            routeName: true,
            area: {
              select: {
                name: true,
              },
            },
          },
        });

        const routesDeleted = await tx.route.deleteMany({
          where: {
            id: {
              in: routesWithNoSchedules.map((r) => r.id),
            },
          },
        });

        const routeNames = [
          ...new Set(
            schedulesToDelete.map((s) => s.route?.routeCode).filter(Boolean),
          ),
        ];

        await tx.auditLog.create({
          data: {
            userId: req.user?.id || null,
            action: "BULK_DELETE_ALL_WEEKLY_SCHEDULES",
            model: "WeeklySchedule",
            recordId: `week-${weekStart}`,
            before: {
              weekStart: weekStart,
              schedulesCount: stats.totalSchedules,
              tripIds: tripIds,
              routeIds: routeIds,
              employeeIds: employeeIds,
              scheduleIds: scheduleIds,
              routeNames: routeNames,
            },
            after: {
              deleted: {
                schedules: schedulesDeleted.count,
                trips: tripsDeleted.count,
                routes: routesDeleted.count,
                rides: ridesDeleted.count,
              },
            },
            ipAddress: req.ip || req.connection.remoteAddress || null,
          },
        });

        return {
          schedulesDeleted: schedulesDeleted.count,
          tripsDeleted: tripsDeleted.count,
          routesDeleted: routesDeleted.count,
          ridesDeleted: ridesDeleted.count,
          deletedTripResources: tripsWithNoSchedules.map((t) => ({
            driverId: t.driverId,
            vehicleId: t.vehicleId,
          })),
          tripsWithNoSchedules: tripsWithNoSchedules.map((t) => ({
            id: t.id,
            tripNumber: t.tripNumber,
            driver: t.driver?.name || "Unassigned",
            vehicle: t.vehicle?.vehicleNumber || "Unassigned",
            route: t.route?.routeCode || "Unknown",
          })),
          routesWithNoSchedules: routesWithNoSchedules.map((r) => ({
            id: r.id,
            code: r.routeCode,
            name: r.routeName,
            area: r.area?.name || "Unknown",
          })),
          routesAffected: routeNames,
        };
      },
      {
        timeout: 30000,
      },
    );

    await finalizeBulkDeletedTripResources(result.deletedTripResources);

    const affectedDriverIdsSet = new Set(
      schedulesToDelete.map((s) => s.driverId).filter(Boolean),
    );
    const weekLabelForNotify = weekStartDate.toISOString().slice(0, 10);

    for (const s of schedulesToDelete) {
      if (!s.employeeId) continue;
      await notifyEmployeeById(
        s.employeeId,
        {
          title: "Schedule removed",
          body: `Your schedule for the week of ${weekLabelForNotify} was removed.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_REMOVED",
            employeeId: s.employeeId,
            weekStart: weekLabelForNotify,
          },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error(
          "[deleteAllWeeklySchedules] Failed to notify employee:",
          err,
        ),
      );
    }

    for (const driverId of affectedDriverIdsSet) {
      await notifyDriverById(
        driverId,
        {
          title: "Trips removed",
          body: `Your trip(s) for the week of ${weekLabelForNotify} were removed in a bulk schedule deletion.`,
          data: { type: "TRIP_DRIVER_REMOVED", weekStart: weekLabelForNotify },
          event: "schedule-updated",
        },
        { notifyAdmins: false },
      ).catch((err) =>
        console.error(
          "[deleteAllWeeklySchedules] Failed to notify driver:",
          err,
        ),
      );
    }

    const response = okResponse(
      {
        action: "BULK_DELETE_ALL_COMPLETED",
        weekStart: weekStart,
        stats: {
          ...stats,
          schedulesDeleted: result.schedulesDeleted,
          tripsDeleted: result.tripsDeleted,
          routesDeleted: result.routesDeleted,
          ridesDeleted: result.ridesDeleted,
          routesAffected: result.routesAffected,
        },
        deletedTrips: result.tripsWithNoSchedules,
        deletedRoutes: result.routesWithNoSchedules,
        message: `✅ Successfully deleted ALL schedules for week ${weekStart}: 
          ${result.schedulesDeleted} schedule(s), 
          ${result.tripsDeleted} trip(s), 
          ${result.routesDeleted} route(s), 
          ${result.ridesDeleted} ride(s)
          from ${result.routesAffected.length} route(s).`,
      },
      `Bulk delete completed for week ${weekStart}`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.error("[deleteAllWeeklySchedules] Error:", error);
    next(error);
  }
};

module.exports = {
  getDriverOptions,
  updateTripDriver,
  createWeeklySchedule,
  getAllWeeklySchedules,
  getWeeklyScheduleById,
  updateWeeklySchedule,
  deleteWeeklySchedule,
  getCurrentWeekSchedules,
  getEmployeeScheduleRange,
  getGroupedSchedules,
  getScheduleStats,
  getScheduleTableStats,
  getScheduleTableGroupedByArea,
  updateSchedule,
  bulkUploadWeeklySchedule,
  validateBulkUploadFile,
  getBulkUploadStatus,
  reassignMismatchedShiftEmployees,
  optimizeRouteAssignments,
  resyncPendingRides,
  assignEmployeeToTrip,
  searchEmployeesForAssignment,
  updateSingleEmployeeSchedule,
  deleteSingleEmployeeSchedule,
  resolvePendingVehicleAssignments,
  mergeTrips,
  deleteAllWeeklySchedules,
};
