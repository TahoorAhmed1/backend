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
  syncPendingRidesForWeek,
  syncPendingRidesForWeekBestEffort,
} = require("../../../lib/rideplaing");

const {
  toDateOnly,
  formatDateOnly,
  mondayOfCurrentWeek,
  toShiftTimeDate,
  toIsoOrNull,
  computePickupTime,
  parseSheetTimeToDate,
  DAY_KEYS,
} = require("../../../utils/dateTimeHelpers");
const {
  normalizeEntity,
  normalizeVehicleType,
  HEADER_ALIASES,
  scheduleDataChanged,
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
const { processBulkUploadJob } = require("../../../services/bulkUpload.service");
const {
  notifyEmployeeById,
  notifyDriverById,
} = require("../../../services/notification.service");

const FK_CHECKS = [
  { field: "routeId", model: "route", label: "Route" },
  { field: "tripId", model: "trip", label: "Trip" },
  { field: "driverId", model: "driver", label: "Driver" },
  { field: "vehicleId", model: "vehicle", label: "Vehicle" },
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

const resolvePendingVehicleAssignments = async (req, res, next) => {
  try {
    const { weekStart, routeId, routeCode, employeeId, employeeCode } =
      req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Monday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toDateOnly(weekStart);

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
      syncPendingRidesForWeekBestEffort(weekStartDate, {
        driverIds: [...new Set(affectedDriverIds)],
        routeIds: [...new Set(affectedRouteIds)],
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
    const weekStartDate = toDateOnly(weekStart);
    const summary = await optimizeWeekAssignments(weekStartDate);

    if (summary?.optimizedRoutes?.length > 0) {
      syncPendingRidesForWeekBestEffort(weekStartDate, {
        routeIds: summary.optimizedRoutes.map((r) => r.id),
        driverIds: summary.affectedDriverIds || [],
        tripIds: summary.affectedTripIds || [],
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
    const weekStartDate = toDateOnly(weekStart);
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

// ---------- Manual employee -> trip assignment (moved from route_controller) ----------
// Writes a WeeklySchedule row directly (like the rest of this file), so unlike
// the old route_controller version, this always triggers
// syncPendingRidesForWeekBestEffort afterward so the PENDING ride/passenger
// records pick up the newly-assigned employee right away instead of waiting
// for a separate resync.

const effectiveTripShift = (trip, route) =>
  trip.shiftTiming || route?.shiftTiming;

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

// Employee already has a different ACTIVE trip assignment this week.
// Surfaced so the caller can show the operator what they're about to move
// the employee off of, and ask for explicit confirmation (confirmReassign:
// true) before we overwrite it — see assignEmployeeToTrip.
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

// Only these fields are ever caller-controlled. Everything else on the
// WeeklySchedule row (routeId/tripId/driverId/vehicleId/shiftTiming/
// officeArrivalTime/dropTime/pickupTime) is always derived from the trip
// itself below — never spread in from req.body — so this endpoint can't be
// used to plant a schedule row with a shift/timing that doesn't match the
// trip's actual driver/vehicle, and can't be used to inject arbitrary
// columns via extra body fields.
const ASSIGNABLE_SCHEDULE_FIELDS = ["serviceType"];

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

    const weekStartDate = toDateOnly(weekStart);
    const capacity = trip.vehicle.capacity;

    // Timing and shift always come from the trip/route — never from the
    // request body — so an employee's schedule (and any ride generated from
    // it, see rideplaing.js:syncPendingRidesForWeek which reads pickupTime /
    // officeArrivalTime / dropTime off the schedule row itself) can never
    // drift out of sync with the driver/vehicle they're actually riding
    // with. Only the per-day on/off pattern is caller-supplied.
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
      const { schedule, remaining } = await prisma.$transaction(async (tx) => {
        // Re-check occupancy and existing-row state inside the transaction
        // so two concurrent "Add Employee" requests for the same trip can't
        // both pass the capacity check and overbook the vehicle.
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

        // Employee already has an active schedule on a *different* trip this
        // week (almost always a different route). Without this check the
        // update below would silently move them off that trip and onto the
        // new one — same DB row, so no duplicate is ever created, but the
        // original driver/route is left thinking the passenger is still
        // riding with them. Require an explicit confirmReassign flag so the
        // caller can warn the operator first.
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
          shiftTiming,
          // Explicit per-employee working days, overridable per assignment.
          // Falls back to the existing row's own days when re-assigning,
          // else Mon-Fri/OFF.
          monday: monday ?? existing?.monday ?? "BOTH",
          tuesday: tuesday ?? existing?.tuesday ?? "BOTH",
          wednesday: wednesday ?? existing?.wednesday ?? "BOTH",
          thursday: thursday ?? existing?.thursday ?? "BOTH",
          friday: friday ?? existing?.friday ?? "BOTH",
          saturday: saturday ?? existing?.saturday ?? "OFF",
          sunday: sunday ?? existing?.sunday ?? "OFF",
          officeArrivalTime: officeArrivalDate,
          dropTime: dropDate,
          pickupTime: pickupDate,
          serviceType:
            assignableFields.serviceType ||
            existing?.serviceType ||
            "PICK_AND_DROP",
          status: status || existing?.status || "ACTIVE",
        };

        const savedSchedule = existing
          ? await tx.weeklySchedule.update({ where: { id: existing.id }, data })
          : await tx.weeklySchedule.create({ data });

        return { schedule: savedSchedule, remaining: remainingSeats };
      });

      syncPendingRidesForWeekBestEffort(weekStartDate, {
        driverIds: [trip.driverId].filter(Boolean),
        tripIds: [trip.id],
        routeIds: [trip.routeId].filter(Boolean),
      }).catch(() => {});

      // ---- Notify the employee and the trip's driver ----
      // event: "schedule-updated" (not the default "notification-created")
      // so driverStore/employeeStore also refetch today's rides/dashboard/
      // weekly schedule data, not just the notification bell.
      const routeLabel =
        trip.route?.routeName || trip.route?.routeCode || "a route";
      const weekLabel = weekStartDate.toISOString().slice(0, 10);

      notifyEmployeeById(employeeId, {
        title: "Trip assignment",
        body: `You've been assigned to Trip ${trip.tripNumber} on ${routeLabel} for the week of ${weekLabel}.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_ASSIGNED",
          scheduleId: schedule.id,
          tripId: trip.id,
          routeId: trip.routeId,
        },
        event: "schedule-updated",
      }).catch((err) =>
        console.error(
          "[assignEmployeeToTrip] Failed to notify employee:",
          err,
        ),
      );

      if (trip.driverId) {
        notifyDriverById(trip.driverId, {
          title: "New passenger on your trip",
          body: `An employee was added to Trip ${trip.tripNumber} on ${routeLabel} for the week of ${weekLabel}.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_ASSIGNED",
            scheduleId: schedule.id,
            tripId: trip.id,
            routeId: trip.routeId,
          },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[assignEmployeeToTrip] Failed to notify driver:",
            err,
          ),
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

// ---------- Employee search for the "Add Employee" trip picker ----------
// Deliberately returns only the minimal fields the picker UI needs
// (id, name, employeeCode, area) plus a same-week scheduling flag — never
// the employee's full record — so this endpoint can't be used to page
// through unrelated employee data (salary, contact info, etc.) via the
// weekly-schedule surface.

const searchEmployeesForAssignment = async (req, res, next) => {
  try {
    const { query = "", weekStart, excludeTripId, limit } = req.query;

    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart is required so existing assignments for that week can be checked.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toDateOnly(weekStart);
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
      vehicleEntity,
      serviceType,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
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

    const existingSchedule = await prisma.weeklySchedule.findUnique({
      where: {
        employeeId_weekStart: {
          employeeId,
          weekStart: toDateOnly(weekStart),
        },
      },
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
    });
    if (fkError) {
      const response = badRequestResponse(fkError);
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.weeklySchedule, {
      weekStart: toDateOnly(weekStart),
      employeeId,
      routeId,
      tripId,
      driverId,
      vehicleId,
      vehicleEntity: normalizedVehicleEntity,
      serviceType: serviceType || "PICK_AND_DROP",
      monday: monday || "BOTH",
      tuesday: tuesday || "BOTH",
      wednesday: wednesday || "BOTH",
      thursday: thursday || "BOTH",
      friday: friday || "BOTH",
      saturday: saturday || "OFF",
      sunday: sunday || "OFF",
      pickupTime: pickupDate,
      shiftTiming,
      officeArrivalTime: officeArrivalDate,
      dropTime: dropDate,
      status: status || "ACTIVE",
    });

    if (routeId) {
      try {
        await optimizeWeekAssignments(toDateOnly(weekStart));
      } catch (optimizeError) {
        // Best-effort
      }
    }

    syncPendingRidesForWeekBestEffort(toDateOnly(weekStart), {
      driverId,
      tripId,
      routeId,
    }).catch(() => {});

    // ---- Notify the employee ----
    let routeLabel = "your weekly schedule";
    if (routeId) {
      const route = await prisma.route.findUnique({
        where: { id: routeId },
        select: { routeName: true, routeCode: true },
      });
      if (route) routeLabel = route.routeName || route.routeCode || routeLabel;
    }
    const weekLabel = toDateOnly(weekStart).toISOString().slice(0, 10);

    notifyEmployeeById(employeeId, {
      title: "Weekly schedule added",
      body: `A schedule was created for you on ${routeLabel} for the week of ${weekLabel}.`,
      data: { type: "SCHEDULE_EMPLOYEE_ADDED", employeeId, routeId, tripId },
      event: "schedule-updated",
    }).catch((err) =>
      console.error("[createWeeklySchedule] Failed to notify employee:", err),
    );

    if (driverId) {
      notifyDriverById(driverId, {
        title: "New passenger on your trip",
        body: `An employee was added to your schedule on ${routeLabel} for the week of ${weekLabel}.`,
        data: { type: "SCHEDULE_EMPLOYEE_ADDED", employeeId, routeId, tripId },
        event: "schedule-updated",
      }).catch((err) =>
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
      const startDate = toDateOnly(weekStart);
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

    if (updateData.weekStart) {
      updateData.weekStart = toDateOnly(updateData.weekStart);
    }

    delete updateData.pickupTime;

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
      include: { employee: { select: { name: true } } },
    });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const fkError = await validateWeeklyScheduleForeignKeys(updateData);
    if (fkError) {
      const errorResponse = badRequestResponse(fkError);
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await updateRecord(prisma.weeklySchedule, id, updateData, {
      employee: true,
      route: true,
      trip: { include: { vehicle: true, driver: true } },
      driver: true,
      vehicle: true,
    });

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
      } catch (optimizeError) {
        // Best-effort
      }
    }

    syncPendingRidesForWeekBestEffort(
      updateData.weekStart || schedule.weekStart,
      {
        driverIds: [schedule.driverId, updateData.driverId].filter(Boolean),
        tripIds: [schedule.tripId, updateData.tripId].filter(Boolean),
        routeIds: [schedule.routeId, updateData.routeId].filter(Boolean),
      },
    ).catch(() => {});

    // ---- Notify the employee and old/new driver ----
    // This endpoint previously sent no notifications at all — an admin
    // could change an employee's route/trip/driver/pickup time here and
    // neither the employee nor the driver would find out until they
    // happened to refresh. Notify whenever a field that actually affects
    // the ride (not just serviceType) changes.
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
        updated?.route?.routeName ||
        updated?.route?.routeCode ||
        "their route";
      const weekLabel = (updateData.weekStart || schedule.weekStart)
        .toISOString()
        .slice(0, 10);

      notifyEmployeeById(schedule.employeeId, {
        title: "Schedule updated",
        body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_UPDATED",
          employeeId: schedule.employeeId,
          scheduleId: id,
          routeId: updated?.routeId ?? schedule.routeId,
        },
        event: "schedule-updated",
      }).catch((err) =>
        console.error("[updateWeeklySchedule] Failed to notify employee:", err),
      );

      const driverChanged =
        "driverId" in updateData && schedule.driverId !== updateData.driverId;

      if (driverChanged) {
        if (schedule.driverId) {
          notifyDriverById(schedule.driverId, {
            title: "Passenger removed from your trip",
            body: `An employee's schedule on ${routeLabel} was moved off your trip.`,
            data: { type: "TRIP_DRIVER_REMOVED", scheduleId: id },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[updateWeeklySchedule] Failed to notify previous driver:",
              err,
            ),
          );
        }
        if (updateData.driverId) {
          notifyDriverById(updateData.driverId, {
            title: "New passenger on your trip",
            body: `An employee's schedule on ${routeLabel} was moved onto your trip.`,
            data: { type: "TRIP_DRIVER_ASSIGNED", scheduleId: id },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[updateWeeklySchedule] Failed to notify new driver:",
              err,
            ),
          );
        }
      } else if (schedule.driverId) {
        // Driver unchanged but something else about this passenger's
        // trip (timing, route/trip, vehicle) changed — still relevant
        // to the driver currently carrying them.
        notifyDriverById(schedule.driverId, {
          title: "Passenger schedule updated",
          body: `An employee's schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
          data: { type: "SCHEDULE_EMPLOYEE_UPDATED", scheduleId: id },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateWeeklySchedule] Failed to notify driver:",
            err,
          ),
        );
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

    syncPendingRidesForWeekBestEffort(schedule.weekStart, {
      driverId: schedule.driverId,
      tripId: schedule.tripId,
      routeId: schedule.routeId,
    }).catch(() => {});

    // ---- Notify the employee ----
    const routeLabel =
      schedule.route?.routeName || schedule.route?.routeCode || "their route";
    const weekLabel = schedule.weekStart.toISOString().slice(0, 10);

    notifyEmployeeById(schedule.employeeId, {
      title: "Removed from schedule",
      body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was removed.`,
      data: {
        type: "SCHEDULE_EMPLOYEE_REMOVED",
        employeeId: schedule.employeeId,
        routeId: schedule.routeId,
      },
      event: "schedule-updated",
    }).catch((err) =>
      console.error("[deleteWeeklySchedule] Failed to notify employee:", err),
    );

    if (schedule.driverId) {
      notifyDriverById(schedule.driverId, {
        title: "Passenger removed from your trip",
        body: `${schedule.employee?.name || "An employee"} was removed from your trip on ${routeLabel} for the week of ${weekLabel}.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_REMOVED",
          employeeId: schedule.employeeId,
          routeId: schedule.routeId,
        },
        event: "schedule-updated",
      }).catch((err) =>
        console.error("[deleteWeeklySchedule] Failed to notify driver:", err),
      );
    }


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
      updateData.weekStart = toDateOnly(updateData.weekStart);
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
    });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
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

    // ---- Notify the employee and old/new driver ----
    // This endpoint previously sent no notifications at all.
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
      const routeLabel =
        updated.route?.routeName || updated.route?.routeCode || "their route";
      const weekLabel = (updateData.weekStart || schedule.weekStart)
        .toISOString()
        .slice(0, 10);

      notifyEmployeeById(schedule.employeeId, {
        title: "Schedule updated",
        body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_UPDATED",
          employeeId: schedule.employeeId,
          scheduleId: id,
          routeId: updated.routeId,
        },
        event: "schedule-updated",
      }).catch((err) =>
        console.error(
          "[updateSingleEmployeeSchedule] Failed to notify employee:",
          err,
        ),
      );

      const driverChanged =
        "driverId" in updateData && schedule.driverId !== updateData.driverId;

      if (driverChanged) {
        if (schedule.driverId) {
          notifyDriverById(schedule.driverId, {
            title: "Passenger removed from your trip",
            body: `An employee's schedule on ${routeLabel} was moved off your trip.`,
            data: { type: "TRIP_DRIVER_REMOVED", scheduleId: id },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[updateSingleEmployeeSchedule] Failed to notify previous driver:",
              err,
            ),
          );
        }
        if (updateData.driverId) {
          notifyDriverById(updateData.driverId, {
            title: "New passenger on your trip",
            body: `An employee's schedule on ${routeLabel} was moved onto your trip.`,
            data: { type: "TRIP_DRIVER_ASSIGNED", scheduleId: id },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[updateSingleEmployeeSchedule] Failed to notify new driver:",
              err,
            ),
          );
        }
      } else if (schedule.driverId) {
        notifyDriverById(schedule.driverId, {
          title: "Passenger schedule updated",
          body: `An employee's schedule on ${routeLabel} for the week of ${weekLabel} was updated.`,
          data: { type: "SCHEDULE_EMPLOYEE_UPDATED", scheduleId: id },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateSingleEmployeeSchedule] Failed to notify driver:",
            err,
          ),
        );
      }

    }

    const response = okResponse(
      updated,
      "Employee schedule updated successfully. No rides were resynced.",
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

    // ---- Notify the employee ----
    const routeLabel =
      schedule.route?.routeName || schedule.route?.routeCode || "their route";
    const weekLabel = weekStartDate.toISOString().slice(0, 10);

    notifyEmployeeById(employeeId, {
      title: "Removed from schedule",
      body: `Your schedule on ${routeLabel} for the week of ${weekLabel} was removed.`,
      data: {
        type: "SCHEDULE_EMPLOYEE_REMOVED",
        employeeId,
        routeId: schedule.routeId,
      },
      event: "schedule-updated",
    }).catch((err) =>
      console.error(
        "[deleteSingleEmployeeSchedule] Failed to notify employee:",
        err,
      ),
    );

    if (schedule.driverId) {
      notifyDriverById(schedule.driverId, {
        title: "Passenger removed from your trip",
        body: `${schedule.employee?.name || "An employee"} was removed from your trip on ${routeLabel} for the week of ${weekLabel}.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_REMOVED",
          employeeId,
          routeId: schedule.routeId,
        },
        event: "schedule-updated",
      }).catch((err) =>
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

      // ✅ ONLY look for conflicting trips on the SAME ROUTE
      // Different routes = different trips, even if shift timing is the same
      conflictingTrip = await prisma.trip.findFirst({
        where: {
          driverId: safeDriverId,
          shiftTiming: trip.shiftTiming,
          status: "ACTIVE",
          routeId: trip.routeId, // ✅ SAME ROUTE ONLY
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
        // ✅ We found a trip on the SAME ROUTE with the same shift
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

        if (weekStart) {
          syncPendingRidesForWeekBestEffort(toDateOnly(weekStart), {
            driverIds: [trip.driverId, safeDriverId].filter(Boolean),
            tripIds: [tripId, conflictingTrip.id],
            vehicleIds: [trip.vehicleId, driver.vehicle.id].filter(Boolean),
          }).catch(() => {});
        }

        // ---- Notify moved employees, old driver, and new driver ----
        const mergedRouteLabel =
          conflictingTrip.route?.routeName ||
          conflictingTrip.route?.routeCode ||
          "the merged route";

        trip.weeklySchedules.forEach((sched) => {
          if (!sched.employeeId) return;
          notifyEmployeeById(sched.employeeId, {
            title: "Trip driver changed",
            body: `Your trip was merged onto ${mergedRouteLabel} with driver ${driver.name}.`,
            data: {
              type: "SCHEDULE_TRIP_MERGED",
              employeeId: sched.employeeId,
              tripId: conflictingTrip.id,
              routeId: conflictingTrip.routeId,
            },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[updateTripDriver] Failed to notify moved employee:",
              err,
            ),
          );
        });

        if (trip.driverId && trip.driverId !== safeDriverId) {
          notifyDriverById(trip.driverId, {
            title: "Trip merged",
            body: `Your trip on ${trip.route?.routeName || "your route"} was merged into another driver's trip and no longer needs you.`,
            data: { type: "TRIP_DRIVER_REMOVED", tripId },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[updateTripDriver] Failed to notify previous driver:",
              err,
            ),
          );
        }

        notifyDriverById(safeDriverId, {
          title: "Employees added to your trip",
          body: `${result.employeesMoved} employee(s) were merged into your trip on ${mergedRouteLabel}.`,
          data: {
            type: "TRIP_DRIVER_ASSIGNED",
            tripId: conflictingTrip.id,
            routeId: conflictingTrip.routeId,
          },
          event: "schedule-updated",
        }).catch((err) =>
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

      // ✅ Check if driver has trips on DIFFERENT routes at the same shift
      const otherTripsDifferentRoutes = driver.trips.filter(
        (t) =>
          t.id !== tripId &&
          t.shiftTiming === trip.shiftTiming &&
          t.routeId !== trip.routeId && // Different route
          t.status === "ACTIVE",
      );

      if (otherTripsDifferentRoutes.length > 0) {
        // ✅ This is fine! Driver can have separate trips on different routes
        // with the same shift timing (e.g., Route A and Route B are different areas)
        console.log(
          `[updateTripDriver] Driver has ${otherTripsDifferentRoutes.length} other trip(s) at same shift but on DIFFERENT routes. ` +
            `These will remain separate trips. Routes: ${otherTripsDifferentRoutes.map((t) => t.route?.code || "N/A").join(", ")}`,
        );
        // ✅ No blocking - just log it
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
      syncPendingRidesForWeekBestEffort(toDateOnly(weekStart), {
        driverIds: [trip.driverId, safeDriverId].filter(Boolean),
        tripIds: [tripId],
        vehicleIds: [trip.vehicleId, newVehicleId].filter(Boolean),
        routeIds: [trip.routeId, updatedTrip.routeId].filter(Boolean),
      }).catch(() => {});
    }

    // ---- Notify old/new driver and affected employees ----
    if (trip.driverId !== safeDriverId) {
      const tripRouteLabel =
        updatedTrip.route?.routeName || trip.route?.routeName || "a route";

      if (trip.driverId) {
        notifyDriverById(trip.driverId, {
          title: "Removed from trip",
          body: `You've been unassigned from your trip on ${tripRouteLabel}.`,
          data: { type: "TRIP_DRIVER_REMOVED", tripId },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateTripDriver] Failed to notify previous driver:",
            err,
          ),
        );
      }

      if (safeDriverId) {
        notifyDriverById(safeDriverId, {
          title: "New trip assigned",
          body: `You've been assigned to a trip on ${tripRouteLabel} with ${trip.weeklySchedules.length} employee(s).`,
          data: { type: "TRIP_DRIVER_ASSIGNED", tripId },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateTripDriver] Failed to notify new driver:",
            err,
          ),
        );
      }

      trip.weeklySchedules.forEach((sched) => {
        if (!sched.employeeId) return;
        notifyEmployeeById(sched.employeeId, {
          title: "Trip driver changed",
          body: `Your driver on ${tripRouteLabel} has changed to ${updatedTrip.driver?.name || "a new driver"}.`,
          data: { type: "SCHEDULE_TRIP_DRIVER_CHANGED", tripId },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateTripDriver] Failed to notify affected employee:",
            err,
          ),
        );
      });

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

// API: POST /api/trips/merge
// Body: { sourceTripId: string, targetTripId: string, weekStart?: string }
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

    // Fetch both trips with their data
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

    // Check if trips have the same shift timing
    if (sourceTrip.shiftTiming !== targetTrip.shiftTiming) {
      const errorResponse = badRequestResponse(
        `Cannot merge trips with different shift timings. Source: ${sourceTrip.shiftTiming}, Target: ${targetTrip.shiftTiming}`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check if trips are on the same route or different routes
    const isSameRoute = sourceTrip.routeId === targetTrip.routeId;
    const routeInfo = isSameRoute
      ? `same route (${sourceTrip.route?.code || "N/A"})`
      : `different routes (${sourceTrip.route?.code || "N/A"} → ${targetTrip.route?.code || "N/A"})`;

    console.log(`[mergeTrips] Merging trips on ${routeInfo}`);

    // Determine which trip's driver/vehicle to use (target trip takes precedence)
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

    // Get target driver with vehicle details for capacity check
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

    // Check capacity
    if (totalEmployees > vehicleCapacity) {
      const errorResponse = badRequestResponse(
        `Cannot merge trips. Target trip has ${targetEmployeeCount} employees ` +
          `and source trip has ${sourceEmployeeCount} employees. Total (${totalEmployees}) exceeds ` +
          `vehicle capacity (${vehicleCapacity} seats). Please reduce employees or assign a larger vehicle.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check if target driver's vehicle is active
    if (targetDriver.vehicle.status !== "ACTIVE") {
      const errorResponse = badRequestResponse(
        `Target driver's vehicle (${targetDriver.vehicle.vehicleNumber}) is currently ${targetDriver.vehicle.status}. Only ACTIVE vehicles can be used.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // If routes are different, check if target driver has any other trips at same shift
    // that might conflict
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
        // This is a warning but we'll allow it
      }
    }

    // Perform the merge in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Move all employees from source trip to target trip
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

      // 2. Delete all pending rides for source trip
      await tx.ride.deleteMany({
        where: {
          tripId: sourceTripId,
          status: "PENDING",
        },
      });

      // 3. Delete the source trip
      await tx.trip.delete({
        where: { id: sourceTripId },
      });

      // 4. Create audit log
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

    // 5. Sync pending rides for the week if weekStart provided
    if (weekStart) {
      syncPendingRidesForWeekBestEffort(toDateOnly(weekStart), {
        driverIds: [targetDriverId],
        tripIds: [targetTripId],
        vehicleIds: [targetVehicleId],
        routeIds: [targetRouteId],
      }).catch(() => {});
    }

    // ---- Notify moved employees, old driver, and new driver ----
    // This endpoint previously sent no notifications at all.
    const mergedRouteLabel =
      targetTrip.route?.routeName || targetTrip.route?.routeCode || "the merged route";

    sourceTrip.weeklySchedules.forEach((sched) => {
      if (!sched.employeeId) return;
      notifyEmployeeById(sched.employeeId, {
        title: "Trip driver changed",
        body: `Your trip was merged onto ${mergedRouteLabel} with driver ${targetDriver.name}.`,
        data: {
          type: "SCHEDULE_TRIP_MERGED",
          employeeId: sched.employeeId,
          tripId: targetTripId,
          routeId: targetRouteId,
        },
        event: "schedule-updated",
      }).catch((err) =>
        console.error("[mergeTrips] Failed to notify moved employee:", err),
      );
    });

    if (sourceTrip.driverId && sourceTrip.driverId !== targetDriverId) {
      notifyDriverById(sourceTrip.driverId, {
        title: "Trip merged",
        body: `Your trip on ${sourceTrip.route?.routeName || "your route"} was merged into another driver's trip and no longer needs you.`,
        data: { type: "TRIP_DRIVER_REMOVED", tripId: sourceTripId },
        event: "schedule-updated",
      }).catch((err) =>
        console.error(
          "[mergeTrips] Failed to notify previous driver:",
          err,
        ),
      );
    }

    notifyDriverById(targetDriverId, {
      title: "Employees added to your trip",
      body: `${sourceEmployeeCount} employee(s) were merged into your trip on ${mergedRouteLabel}.`,
      data: {
        type: "TRIP_DRIVER_ASSIGNED",
        tripId: targetTripId,
        routeId: targetRouteId,
      },
      event: "schedule-updated",
    }).catch((err) =>
      console.error("[mergeTrips] Failed to notify new driver:", err),
    );


    // 6. Prepare response
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

    console.log("[reassign] Request received:", {
      routeCode,
      weekStart,
      employeeIds,
      employeeIdsCount: employeeIds?.length || 0,
    });

    if (
      !routeCode ||
      !weekStart ||
      !employeeIds ||
      !Array.isArray(employeeIds)
    ) {
      const response = badRequestResponse(
        "routeCode, weekStart, and employeeIds are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toDateOnly(weekStart);

    const route = await prisma.route.findUnique({
      where: { routeCode },
      include: { area: true },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    console.log("[reassign] Route found:", {
      id: route.id,
      code: route.routeCode,
      shiftTiming: route.shiftTiming,
    });

    const whereClause = {
      routeId: route.id,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      employeeIds: { in: employeeIds },
    };

    console.log(
      "[reassign] Where clause:",
      JSON.stringify(whereClause, null, 2),
    );

    const schedules = await prisma.weeklySchedule.findMany({
      where: whereClause,
      include: {
        employee: true,
        driver: {
          include: {
            vehicle: true,
          },
        },
        vehicle: true,
        trip: {
          include: {
            weeklySchedules: true,
            rides: true,
            driver: {
              include: {
                vehicle: true,
              },
            },
            vehicle: true,
          },
        },
      },
    });

    console.log("[reassign] Found schedules:", schedules.length);

    const routeShiftNorm = normalizeShift(route.shiftTiming);
    console.log("[reassign] Route shift norm:", routeShiftNorm);

    const mismatched = schedules.filter((s) => {
      const shiftNorm = normalizeShift(s.shiftTiming);
      const isMismatch = s.shiftTiming && shiftNorm !== routeShiftNorm;
      console.log(
        "[reassign] Schedule:",
        s.id,
        "shift:",
        s.shiftTiming,
        "norm:",
        shiftNorm,
        "mismatch:",
        isMismatch,
      );
      return isMismatch;
    });

    console.log("[reassign] Mismatched schedules:", mismatched.length);

    if (!mismatched.length) {
      const response = okResponse(
        { updated: 0, details: [] },
        "No mismatched employees found.",
      );
      return res.status(response.status.code).json(response);
    }

    const oldTripIds = new Set();
    mismatched.forEach((s) => {
      if (s.tripId) {
        oldTripIds.add(s.tripId);
      }
    });

    const groups = new Map();
    mismatched.forEach((s) => {
      const key = normalizeShift(s.shiftTiming);
      if (!groups.has(key)) {
        groups.set(key, { shiftTiming: s.shiftTiming, entries: [] });
      }
      groups.get(key).entries.push(s);
    });

    console.log("[reassign] Groups:", groups.size);

    const areaRecord = route.area || null;
    const results = {
      updated: 0,
      routesCreated: 0,
      legsOpened: 0,
      tripsDeleted: 0,
      ridesDeleted: 0,
      driversFreed: 0,
      vehiclesFreed: 0,
      details: [],
      deletedTrips: [],
    };

    const movedEmployeeIds = new Set();
    const affectedTripIds = new Set();
    const affectedRouteIds = new Set([route.id]);
    const affectedDriverIds = new Set();

    for (const { shiftTiming, entries } of groups.values()) {
      console.log(
        "[reassign] Processing group shift:",
        shiftTiming,
        "entries:",
        entries.length,
      );

      for (const entry of entries) {
        console.log(
          "[reassign] Processing employee:",
          entry.employeeId,
          "schedule:",
          entry.id,
        );

        let maxSeats = 6;
        const currentTrip = entry.trip;
        if (currentTrip) {
          const vehicle = currentTrip.vehicle || currentTrip.driver?.vehicle;
          if (vehicle && vehicle.capacity) {
            maxSeats = vehicle.capacity;
          }
        }

        const existingTripResult = await findExistingTripWithSeats({
          areaId: areaRecord?.id,
          shiftTiming: shiftTiming,
          weekStart: weekStartDate,
          excludeTripId: entry.tripId,
        });

        let routeResult;
        let movedToExisting = false;

        if (existingTripResult) {
          console.log(
            "[reassign] Found existing trip with seats:",
            existingTripResult.trip.id,
          );
          console.log(
            "[reassign] Vehicle:",
            existingTripResult.vehicleNumber,
            "Capacity:",
            existingTripResult.maxSeats,
            "Available:",
            existingTripResult.availableSeats,
          );

          await prisma.weeklySchedule.update({
            where: { id: entry.id },
            data: {
              routeId: existingTripResult.route.id,
              tripId: existingTripResult.trip.id,
              driverId: existingTripResult.trip.driverId || entry.driverId,
              vehicleId: existingTripResult.trip.vehicleId || entry.vehicleId,
              shiftTiming: shiftTiming,
              status: "ACTIVE",
            },
          });

          movedToExisting = true;
          results.updated++;
          movedEmployeeIds.add(entry.id);
          affectedTripIds.add(existingTripResult.trip.id);
          affectedRouteIds.add(existingTripResult.route.id);
          if (existingTripResult.trip.driverId)
            affectedDriverIds.add(existingTripResult.trip.driverId);

          results.details.push({
            scheduleId: entry.id,
            employeeId: entry.employeeId,
            shiftTiming,
            action: "MOVED_TO_EXISTING_TRIP",
            newRouteId: existingTripResult.route.id,
            newRouteCode: existingTripResult.route.routeCode,
            newTripId: existingTripResult.trip.id,
            newTripNumber: existingTripResult.trip.tripNumber,
            vehicleNumber: existingTripResult.vehicleNumber,
            vehicleType: existingTripResult.vehicleType,
            maxSeats: existingTripResult.maxSeats,
            currentEmployees: existingTripResult.currentEmployees,
            seatsRemaining: existingTripResult.availableSeats - 1,
          });
        } else {
          routeResult = await findOrCreateRouteAndTrip(
            areaRecord,
            undefined,
            shiftTiming,
            undefined,
            entry.driverId || undefined,
            entry.vehicleId || undefined,
            weekStartDate,
            entry.employeeId,
            undefined,
            {
              trustProposedDriver: true,
              disableMultiTrip: false,
              allowCreate: true,
            },
            null, // vendorName — not tracked at this call site
            entry.employee?.officeLocation || null, // location
            entry.vehicleEntity || null,
            // These aren't fresh sheet input — this is a reassignment, so
            // the employee already has their own schedule data (that's the
            // whole point: they're being moved to a route that matches
            // their real shift). Carry it over instead of leaving a
            // newly-created route with null timing/subArea/serviceType.
            entry.employee?.subAreaId || undefined,
            entry.serviceType || undefined,
            entry.pickupTime || undefined,
            entry.officeArrivalTime || undefined,
            entry.dropTime || undefined,
          );

          if (routeResult.created) results.routesCreated++;
          if (routeResult.newTrip) results.legsOpened++;

          let newVehicleCapacity = maxSeats;
          if (routeResult.trip) {
            const newTrip = await prisma.trip.findUnique({
              where: { id: routeResult.trip.id },
              include: {
                driver: { include: { vehicle: true } },
                vehicle: true,
              },
            });
            const vehicle = newTrip?.vehicle || newTrip?.driver?.vehicle;
            if (vehicle && vehicle.capacity) {
              newVehicleCapacity = vehicle.capacity;
            }
          }

          await prisma.weeklySchedule.update({
            where: { id: entry.id },
            data: {
              routeId: routeResult.route.id,
              tripId: routeResult.trip.id,
              driverId: routeResult.trip.driverId || entry.driverId,
              vehicleId: routeResult.trip.vehicleId || entry.vehicleId,
              shiftTiming: shiftTiming,
              status: "ACTIVE",
            },
          });

          results.updated++;
          movedEmployeeIds.add(entry.id);
          affectedTripIds.add(routeResult.trip.id);
          affectedRouteIds.add(routeResult.route.id);
          if (routeResult.trip.driverId)
            affectedDriverIds.add(routeResult.trip.driverId);

          results.details.push({
            scheduleId: entry.id,
            employeeId: entry.employeeId,
            shiftTiming,
            action: "CREATED_NEW_TRIP",
            newRouteId: routeResult.route.id,
            newRouteCode: routeResult.route.routeCode,
            newTripId: routeResult.trip.id,
            newTripNumber: routeResult.trip.tripNumber,
            vehicleCapacity: newVehicleCapacity,
            seatsUsed: 1,
            seatsRemaining: newVehicleCapacity - 1,
          });
        }

        if (entry.tripId) {
          affectedTripIds.add(entry.tripId);
        }
        if (entry.driverId) {
          affectedDriverIds.add(entry.driverId);
        }
        if (entry.routeId) {
          affectedRouteIds.add(entry.routeId);
        }
      }
    }

    console.log("[reassign] Checking old trips for deletion:", oldTripIds.size);

    for (const tripId of oldTripIds) {
      const trip = await prisma.trip.findUnique({
        where: { id: tripId },
        include: {
          weeklySchedules: {
            where: {
              status: { not: "CANCELLED" },
              id: { notIn: Array.from(movedEmployeeIds) },
            },
          },
          rides: true,
          driver: {
            include: {
              vehicle: true,
            },
          },
          vehicle: true,
        },
      });

      if (!trip) continue;

      const remainingSchedules = trip.weeklySchedules.filter(
        (s) => !movedEmployeeIds.has(s.id),
      );

      console.log(
        "[reassign] Trip:",
        tripId,
        "remaining schedules:",
        remainingSchedules.length,
      );

      if (remainingSchedules.length === 0) {
        console.log("[reassign] Deleting empty trip:", tripId);

        const vehicle = trip.vehicle || trip.driver?.vehicle;
        const vehicleInfo = vehicle
          ? {
              id: vehicle.id,
              number: vehicle.vehicleNumber,
              type: vehicle.type,
              capacity: vehicle.capacity,
            }
          : null;

        const rideCount = await prisma.ride.deleteMany({
          where: { tripId: tripId },
        });

        await prisma.trip.delete({
          where: { id: tripId },
        });

        results.tripsDeleted++;
        results.ridesDeleted += rideCount.count;
        results.deletedTrips.push({
          tripId: tripId,
          tripNumber: trip.tripNumber,
          driverId: trip.driverId,
          driverName: trip.driver?.name || "Unknown",
          vehicleId: trip.vehicleId,
          vehicleNumber: vehicleInfo?.number || "Unknown",
          vehicleCapacity: vehicleInfo?.capacity || 0,
          shiftTiming: trip.shiftTiming,
          employeesMoved: movedEmployeeIds.size,
        });

        if (trip.driverId) {
          await prisma.driver.update({
            where: { id: trip.driverId },
            data: { status: "AVAILABLE" },
          });
          results.driversFreed++;
        }

        if (trip.vehicleId) {
          await prisma.vehicle.update({
            where: { id: trip.vehicleId },
            data: { status: "ACTIVE" },
          });
          results.vehiclesFreed++;
        }

        const remainingTrips = await prisma.trip.count({
          where: {
            routeId: trip.routeId,
            status: "ACTIVE",
          },
        });

        if (remainingTrips === 0) {
          const routeToClean = await prisma.route.findUnique({
            where: { id: trip.routeId },
          });

          if (routeToClean && routeToClean.areaId) {
            const routeTrips = await prisma.trip.findMany({
              where: {
                routeId: trip.routeId,
                status: "ACTIVE",
              },
            });

            if (routeTrips.length === 0) {
              await prisma.route.delete({
                where: { id: trip.routeId },
              });
              console.log("[reassign] Deleted empty route:", trip.routeId);
            }
          }
        }
      }
    }

    if (results.updated > 0) {
      console.log(`[reassign] Triggering ride sync for week ${weekStartDate}`);
      await syncPendingRidesForWeekBestEffort(weekStartDate, {
        routeIds: Array.from(affectedRouteIds),
        tripIds: Array.from(affectedTripIds),
        driverIds: Array.from(affectedDriverIds).filter(Boolean),
      });

      // ---- Notify moved employees and affected drivers ----
      // This endpoint previously sent no notifications at all, despite
      // moving employees to a different route/trip/driver in bulk.
      mismatched.forEach((entry) => {
        if (!entry.employeeId) return;
        notifyEmployeeById(entry.employeeId, {
          title: "Schedule reassigned",
          body: `Your schedule on ${route.routeName || route.routeCode} was reassigned to match your shift timing.`,
          data: {
            type: "SCHEDULE_EMPLOYEE_UPDATED",
            employeeId: entry.employeeId,
            scheduleId: entry.id,
          },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[reassign] Failed to notify reassigned employee:",
            err,
          ),
        );
      });

      Array.from(affectedDriverIds)
        .filter(Boolean)
        .forEach((driverId) => {
          notifyDriverById(driverId, {
            title: "Trip employees changed",
            body: `Your trip's passenger list changed after a shift-timing reassignment on route ${route.routeName || route.routeCode}.`,
            data: { type: "TRIP_DRIVER_ASSIGNED", routeId: route.id },
            event: "schedule-updated",
          }).catch((err) =>
            console.error(
              "[reassign] Failed to notify affected driver:",
              err,
            ),
          );
        });

    }

    console.log("[reassign] Results:", results);

    const response = okResponse(
      results,
      `Reassigned ${results.updated} employee(s). ${results.tripsDeleted} empty trip(s) deleted. ${results.driversFreed} driver(s) freed. ${results.vehiclesFreed} vehicle(s) freed.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.error("[reassign] Error:", error);
    next(error);
  }
};

const getCurrentWeekSchedules = async (req, res, next) => {
  try {
    const startOfWeek = mondayOfCurrentWeek();

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
      ? toDateOnly(req.query.weekStart)
      : mondayOfCurrentWeek();

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
      ? toDateOnly(req.query.weekStart)
      : mondayOfCurrentWeek();

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
        status: job.status, // "processing" | "completed" | "failed"
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
        "weekStart (the Monday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toDateOnly(weekStart);

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
        "weekStart (the Monday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toDateOnly(weekStart);

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

    // req.file only has a buffer (memory storage) - persist it to disk so
    // we can hand the queue job a small file path instead of the file
    // itself. The worker reads it back and deletes it when done.
    const tempFilePath = path.join(
      os.tmpdir(),
      `bulk-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`,
    );
    await fs.writeFile(tempFilePath, req.file.buffer);

    let jobResult;
    try {
      jobResult = await enqueueBulkUpload(tempFilePath, weekStartDate, batchSize);
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

    // Validate required fields
    if (!weekStart) {
      const errorResponse = badRequestResponse(
        "weekStart is required. Please provide the week starting date.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Security: Require confirmation
    if (confirm !== true) {
      const errorResponse = badRequestResponse(
        "Please confirm this action by setting confirm: true",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Parse the week start date
    const weekStartDate = new Date(weekStart);
    if (isNaN(weekStartDate.getTime())) {
      const errorResponse = badRequestResponse(
        "Invalid weekStart date format. Please use YYYY-MM-DD.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Calculate week end date (7 days later)
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekEndDate.getDate() + 7);

    // Get ALL schedules for this week
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
        driverId: true, // needed to notify affected drivers below
        route: {
          select: {
            routeCode: true, // ✅ Fixed: use routeCode instead of code
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

    // Get all trip IDs from the schedules
    const tripIds = [
      ...new Set(schedulesToDelete.map((s) => s.tripId).filter(Boolean)),
    ];

    // Get all route IDs from the schedules
    const routeIds = [
      ...new Set(schedulesToDelete.map((s) => s.routeId).filter(Boolean)),
    ];

    // Get all employee IDs from the schedules
    const employeeIds = schedulesToDelete.map((s) => s.employeeId);

    // Get all schedule IDs
    const scheduleIds = schedulesToDelete.map((s) => s.id);

    // Count statistics
    const stats = {
      totalSchedules: schedulesToDelete.length,
      tripsAffected: tripIds.length,
      routesAffected: routeIds.length,
      employeeCount: schedulesToDelete.length,
    };

    // Start transaction with increased timeout
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Get all rides that are associated with these trips (via tripId)
        //    and also get rides for these employees (via ride passengers)
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

        // 2. Delete ride passengers for these rides
        if (rideIds.length > 0) {
          await tx.ridePassenger.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        // 3. Delete attendances for these rides
        if (rideIds.length > 0) {
          await tx.attendance.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        // 4. Delete complaints for these rides
        if (rideIds.length > 0) {
          await tx.complaint.deleteMany({
            where: {
              rideId: { in: rideIds },
            },
          });
        }

        // 5. Delete the rides
        const ridesDeleted = await tx.ride.deleteMany({
          where: {
            id: { in: rideIds },
          },
        });

        // 6. Delete all weekly schedules
        const schedulesDeleted = await tx.weeklySchedule.deleteMany({
          where: {
            weekStart: {
              gte: weekStartDate,
              lt: weekEndDate,
            },
            status: { not: "CANCELLED" },
          },
        });

        // 7. Delete trips that no longer have any schedules
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
                routeCode: true, // ✅ Fixed: use routeCode instead of code
              },
            },
          },
        });

        // Delete trips with no schedules
        const tripsDeleted = await tx.trip.deleteMany({
          where: {
            id: {
              in: tripsWithNoSchedules.map((t) => t.id),
            },
          },
        });

        // 8. Find routes that no longer have any schedules
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
            routeCode: true, // ✅ Fixed: use routeCode
            routeName: true, // ✅ Fixed: use routeName
            area: {
              select: {
                name: true,
              },
            },
          },
        });

        // 9. Delete routes with no schedules
        const routesDeleted = await tx.route.deleteMany({
          where: {
            id: {
              in: routesWithNoSchedules.map((r) => r.id),
            },
          },
        });

        // 10. Audit log
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
          tripsWithNoSchedules: tripsWithNoSchedules.map((t) => ({
            id: t.id,
            tripNumber: t.tripNumber,
            driver: t.driver?.name || "Unassigned",
            vehicle: t.vehicle?.vehicleNumber || "Unassigned",
            route: t.route?.routeCode || "Unknown", // ✅ Fixed: use routeCode
          })),
          routesWithNoSchedules: routesWithNoSchedules.map((r) => ({
            id: r.id,
            code: r.routeCode, // ✅ Fixed: use routeCode
            name: r.routeName, // ✅ Fixed: use routeName
            area: r.area?.name || "Unknown",
          })),
          routesAffected: routeNames,
        };
      },
      {
        timeout: 30000, // Increase transaction timeout to 30 seconds
      },
    );

    // Response
    // ---- Notify all affected employees and their drivers ----
    // This is a destructive bulk action — employees whose schedule (and
    // therefore ride) just vanished need to know.
    const affectedDriverIdsSet = new Set(
      schedulesToDelete.map((s) => s.driverId).filter(Boolean),
    );
    const weekLabelForNotify = weekStartDate.toISOString().slice(0, 10);

    schedulesToDelete.forEach((s) => {
      if (!s.employeeId) return;
      notifyEmployeeById(s.employeeId, {
        title: "Schedule removed",
        body: `Your schedule for the week of ${weekLabelForNotify} was removed.`,
        data: {
          type: "SCHEDULE_EMPLOYEE_REMOVED",
          employeeId: s.employeeId,
          weekStart: weekLabelForNotify,
        },
        event: "schedule-updated",
      }).catch((err) =>
        console.error(
          "[deleteAllWeeklySchedules] Failed to notify employee:",
          err,
        ),
      );
    });

    affectedDriverIdsSet.forEach((driverId) => {
      notifyDriverById(driverId, {
        title: "Trips removed",
        body: `Your trip(s) for the week of ${weekLabelForNotify} were removed in a bulk schedule deletion.`,
        data: { type: "TRIP_DRIVER_REMOVED", weekStart: weekLabelForNotify },
        event: "schedule-updated",
      }).catch((err) =>
        console.error(
          "[deleteAllWeeklySchedules] Failed to notify driver:",
          err,
        ),
      );
    });


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