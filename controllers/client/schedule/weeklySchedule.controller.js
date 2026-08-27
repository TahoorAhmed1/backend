const XLSX = require("xlsx");
const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
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
  DAY_KEYS,
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
const {
  bulkUploadJobs,
  createBulkUploadJob,
  updateBulkUploadJob,
  processBulkUploadJob,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} = require("../../../services/bulkUpload.service");

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
      summary.details.push({
        weeklyScheduleId: entry.id,
        employeeId: entry.employeeId,
        driverId: entry.driverId,
        vehicleId: driver.vehicle.id,
        note: "Vehicle linked from driver's current vehicle - status set to ACTIVE.",
      });
    }

    if (summary.vehiclesLinked > 0) {
      await syncPendingRidesForWeekBestEffort(weekStartDate);
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
    const summary = await optimizeWeekAssignments(toDateOnly(weekStart));
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
    const results = await syncPendingRidesForWeek(toDateOnly(weekStart));
    const created = results.filter((r) => r.rideId && !r.skipped).length;
    const cancelled = results.filter((r) => r.cancelled).length;
    const skipped = results.filter((r) => r.skipped).length;
    const response = okResponse(
      { results, created, cancelled, skipped },
      `Synced PENDING rides for the week: ${created} created/refreshed, ${cancelled} cancelled, ${skipped} skipped.`,
    );
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

    await syncPendingRidesForWeekBestEffort(toDateOnly(weekStart));

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

    // Parse pagination parameters
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNumber - 1) * pageSize;
    const take = pageSize;

    // Build where clause
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

    // Build orderBy clause
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

    // Get total count for pagination
    const totalCount = await prisma.weeklySchedule.count({ where });

    // Get paginated records
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

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasNextPage = pageNumber < totalPages;
    const hasPrevPage = pageNumber > 1;

    // Build response
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

    const schedule = await prisma.weeklySchedule.findUnique({ where: { id } });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
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

    await syncPendingRidesForWeekBestEffort(
      updateData.weekStart || schedule.weekStart,
    );

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
    });

    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.weeklySchedule, id);

    await syncPendingRidesForWeekBestEffort(schedule.weekStart);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateSingleEmployeeSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    // Remove fields that shouldn't be updated directly
    delete updateData.id;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.employeeId; // Prevent changing employee

    // Handle weekStart if provided
    if (updateData.weekStart) {
      updateData.weekStart = toDateOnly(updateData.weekStart);
    }

    // Parse time fields
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

    // Check if schedule exists
    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
    });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Update ONLY this schedule - no side effects
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

    // ✅ NO syncPendingRidesForWeekBestEffort()
    // ✅ NO optimizeWeekAssignments()
    // ✅ ONLY this employee's schedule is updated

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

    // Check if schedule exists
    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
    });

    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const weekStartDate = schedule.weekStart;
    const employeeId = schedule.employeeId;
    const weekEnd = new Date(weekStartDate);
    weekEnd.setDate(weekEnd.getDate() + 7);

    // ✅ Delete ONLY Rides and RidePassenger for this employee in this week
    await prisma.$transaction(async (tx) => {
      // 1. Delete RidePassenger entries
      await tx.ridePassenger.deleteMany({
        where: {
          employeeId: employeeId,
          ride: {
            rideDate: {
              gte: weekStartDate,
              lt: weekEnd,
            },
          },
        },
      });

      // 2. Delete Ride entries (only if no passengers left)
      await tx.ride.deleteMany({
        where: {
          rideDate: {
            gte: weekStartDate,
            lt: weekEnd,
          },
          passengers: {
            none: {},
          },
        },
      });

      // 3. Delete the WeeklySchedule
      await tx.weeklySchedule.delete({
        where: { id },
      });
    });

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

    // ✅ Step 1: Get the trip with its details
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

    // ✅ Step 2: If assigning a driver, validate and get their vehicle
    if (safeDriverId) {
      // Get the driver with their vehicle
      const driver = await prisma.driver.findUnique({
        where: { id: safeDriverId },
        include: {
          vehicle: true,
          // Get all active trips for this driver to check for conflicts
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

      // ✅ Check if driver has a vehicle
      if (!driver.vehicle) {
        const errorResponse = badRequestResponse(
          `Driver ${driver.name} does not have a vehicle assigned. Please assign a vehicle to this driver first.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      // ✅ REMOVED: Driver status check - allow assigning drivers regardless of status
      // A driver can be ON_RIDE for their current trip but still be assigned to future trips
      console.log(
        `[updateTripDriver] Assigning driver ${driver.name} (status: ${driver.status}) to trip. Status doesn't prevent assignment.`,
      );

      // ✅ Set new vehicle to driver's vehicle ID
      newVehicleId = driver.vehicle.id;

      console.log(
        "[updateTripDriver] Driver:",
        driver.name,
        "Driver's Vehicle:",
        driver.vehicle.vehicleNumber,
        "Vehicle ID:",
        driver.vehicle.id,
      );

      // ✅ Check for conflicting trips ONLY at the same shift timing
      // A driver can have multiple trips for different shifts/days
      conflictingTrip = await prisma.trip.findFirst({
        where: {
          driverId: safeDriverId,
          shiftTiming: trip.shiftTiming,
          status: "ACTIVE",
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

      // ✅ If driver has conflicting trip at same shift, MERGE employees into that trip
      if (conflictingTrip) {
        console.log(
          "[updateTripDriver] Driver has conflicting trip at same shift:",
          conflictingTrip.id,
          "- Will merge employees",
        );

        // Check if driver's trip has available seats
        const vehicleCapacity = driver.vehicle.capacity || 6;
        const currentEmployees = conflictingTrip.weeklySchedules.length;
        const employeesToMove = trip.weeklySchedules.length;
        const totalEmployees = currentEmployees + employeesToMove;

        if (totalEmployees > vehicleCapacity) {
          const errorResponse = badRequestResponse(
            `Cannot merge trips. Driver ${driver.name}'s trip has ${currentEmployees} employees ` +
              `and this trip has ${employeesToMove} employees. Total (${totalEmployees}) exceeds ` +
              `vehicle capacity (${vehicleCapacity} seats). Please reduce employees or assign a larger vehicle.`,
          );
          return res.status(errorResponse.status.code).json(errorResponse);
        }

        // ✅ Use a transaction for all the merge operations
        const result = await prisma.$transaction(async (tx) => {
          // MOVE all employees from current trip to driver's existing trip
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

          // Delete the old trip (now empty)
          await tx.ride.deleteMany({
            where: { tripId: tripId },
          });

          await tx.trip.delete({
            where: { id: tripId },
          });

          return { employeesMoved: employeesToMove };
        });

        // ✅ Sync rides
        if (weekStart) {
          await syncPendingRidesForWeekBestEffort(toDateOnly(weekStart));
        }

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
            message: `Employees merged into driver ${driver.name}'s existing trip at same shift. Empty trip deleted.`,
          },
          `Trip merged into existing trip. ${result.employeesMoved} employee(s) moved to ${driver.name}'s trip with vehicle ${driver.vehicle.vehicleNumber}.`,
        );
        return res.status(response.status.code).json(response);
      }

      // ✅ Check vehicle capacity vs employees (only if no conflicting trip)
      const employeeCount = trip.weeklySchedules.length;
      const vehicleCapacity = driver.vehicle.capacity || 6;

      if (employeeCount > vehicleCapacity) {
        const errorResponse = badRequestResponse(
          `Trip has ${employeeCount} employees but driver's vehicle (${driver.vehicle.vehicleNumber}) has only ${vehicleCapacity} seats. ` +
            `Please assign a driver with a larger vehicle or reduce employees.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      // ✅ Check if vehicle is available
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

    // ✅ Step 3: If removing driver (driverId = null), validate
    if (!safeDriverId) {
      if (trip.weeklySchedules.length > 0) {
        const errorResponse = badRequestResponse(
          `Cannot remove driver from trip with ${trip.weeklySchedules.length} employees. ` +
            `Please reassign employees first or assign a new driver.`,
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    // ✅ Step 4: Perform the update using a single transaction
    const [updatedTrip, updatedSchedules, auditLog] = await prisma.$transaction(
      async (tx) => {
        // Update trip
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

        // Update all associated weekly schedules
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

        // Create audit log within the same transaction
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

    // ✅ Sync rides for the week (outside transaction)
    if (weekStart) {
      await syncPendingRidesForWeekBestEffort(toDateOnly(weekStart));
    }

    // ✅ Return response with details
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

  // ✅ Find trips with matching shift and area (via route)
  const trips = await prisma.trip.findMany({
    where: {
      shiftTiming: shiftTiming,
      status: "ACTIVE",
      id: excludeTripId ? { not: excludeTripId } : undefined,
      // ✅ Join with route to filter by areaId
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

  // Check each trip for available seats
  for (const trip of trips) {
    // ✅ Get vehicle capacity from driver's vehicle or trip's vehicle
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

    // Get the route
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

    // ✅ Use schedule IDs
    const whereClause = {
      routeId: route.id,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      id: { in: employeeIds },
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

    // Filter to ONLY mismatched employees
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

    // ✅ Track old trips that need to be checked for deletion
    const oldTripIds = new Set();
    mismatched.forEach((s) => {
      if (s.tripId) {
        oldTripIds.add(s.tripId);
      }
    });

    // Group by shift timing
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

    // ✅ Track which employees were moved to new trips
    const movedEmployeeIds = new Set();

    // Process each mismatched employee
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

        // ✅ Get the vehicle capacity for this employee's current trip
        let maxSeats = 6; // default fallback
        const currentTrip = entry.trip;
        if (currentTrip) {
          const vehicle = currentTrip.vehicle || currentTrip.driver?.vehicle;
          if (vehicle && vehicle.capacity) {
            maxSeats = vehicle.capacity;
          }
        }

        // ✅ FIRST: Try to find existing trip with same shift and available seats
        const existingTripResult = await findExistingTripWithSeats({
          areaId: areaRecord?.id,
          shiftTiming: shiftTiming,
          weekStart: weekStartDate,
          excludeTripId: entry.tripId,
        });

        let routeResult;
        let movedToExisting = false;

        if (existingTripResult) {
          // ✅ Found existing trip with available seats - move employee there
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

          // Update the schedule to the existing trip
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
          // ✅ No existing trip found - create new one
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
            null,
            null,
            null,
          );

          if (routeResult.created) results.routesCreated++;
          if (routeResult.newTrip) results.legsOpened++;

          // Get vehicle capacity for the new trip
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

          // Update the schedule to the new trip
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
      }
    }

    // ✅ STEP 2: Check old trips for deletion
    console.log("[reassign] Checking old trips for deletion:", oldTripIds.size);

    for (const tripId of oldTripIds) {
      // Get the trip with its schedules
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

      // Count remaining active schedules (excluding moved ones)
      const remainingSchedules = trip.weeklySchedules.filter(
        (s) => !movedEmployeeIds.has(s.id),
      );

      console.log(
        "[reassign] Trip:",
        tripId,
        "remaining schedules:",
        remainingSchedules.length,
      );

      // ✅ If no remaining employees, delete the trip
      if (remainingSchedules.length === 0) {
        console.log("[reassign] Deleting empty trip:", tripId);

        // Get vehicle info before deletion for the response
        const vehicle = trip.vehicle || trip.driver?.vehicle;
        const vehicleInfo = vehicle
          ? {
              id: vehicle.id,
              number: vehicle.vehicleNumber,
              type: vehicle.type,
              capacity: vehicle.capacity,
            }
          : null;

        // Delete all rides for this trip
        const rideCount = await prisma.ride.deleteMany({
          where: { tripId: tripId },
        });

        // Delete the trip
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

        // ✅ Free up driver
        if (trip.driverId) {
          await prisma.driver.update({
            where: { id: trip.driverId },
            data: { status: "AVAILABLE" },
          });
          results.driversFreed++;
        }

        // ✅ Free up vehicle
        if (trip.vehicleId) {
          await prisma.vehicle.update({
            where: { id: trip.vehicleId },
            data: { status: "ACTIVE" },
          });
          results.vehiclesFreed++;
        }

        // ✅ Clean up the route if it has no active trips
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

    // Auto resync using existing function
    if (results.updated > 0) {
      console.log(`[reassign] Triggering ride sync for week ${weekStartDate}`);
      await syncPendingRidesForWeekBestEffort(weekStartDate);
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

    // Parse pagination parameters
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

    // ✅ Added `{ id: "asc" }` as a deterministic tiebreaker so row order
    // never depends on incidental DB return order when weekStart + name tie.
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

    // ✅ Sort rows within each week deterministically too — otherwise the
    // employee row order inside a route/week can also shuffle on refetch.
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
      // ✅ Explicit, stable ordering of the routes array by routeCode
      // (numeric-aware, so "R2" sorts before "R10"). Unassigned always last.
      .sort((a, b) => {
        if (a.code === "—") return 1;
        if (b.code === "—") return -1;
        
        // Dynamic sorting based on sortBy parameter
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

    // ✅ Calculate total routes before pagination
    const totalRoutes = routes.length;
    const totalPages = Math.ceil(totalRoutes / pageSize);
    const hasNextPage = pageNumber < totalPages;
    const hasPrevPage = pageNumber > 1;

    // ✅ Apply pagination to routes array
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
        pattern: schedule ? DAY_FIELD_KEYS.map((day) => schedule[day]) : null,
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
    const job = bulkUploadJobs.get(jobId);
    if (!job) {
      const response = badRequestResponse("Unknown or expired upload job id.");
      return res.status(response.status.code).json(response);
    }

    const percent = job.totalRows
      ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100))
      : job.status === "done"
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
        result: job.status === "done" ? job.result : job.partialResult,
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

    const jobResult = createBulkUploadJob(totalRows, batchSize, weekStartDate);
    if (jobResult.conflict) {
      const response = {
        status: { code: 409, status: false },
        message: `A bulk upload for the week of ${weekStart} is already running.`,
        data: { existingJobId: jobResult.existingJobId },
      };
      return res.status(response.status.code).json(response);
    }
    const jobId = jobResult.jobId;

    console.log(
      `[weeklySchedule][job ${jobId}] launching background processing...`,
    );
    processBulkUploadJob(jobId, workbook, weekStartDate, batchSize)
      .then((results) => {
        console.log(`[weeklySchedule][job ${jobId}] resolved OK.`);
        updateBulkUploadJob(jobId, { status: "done", result: results });
      })
      .catch((error) => {
        console.error(
          `[weeklySchedule][job ${jobId}] FAILED (uncaught at top level): ${error.message}\n${error.stack}`,
        );
        updateBulkUploadJob(jobId, {
          status: "failed",
          error: error.message || "Bulk upload failed unexpectedly.",
        });
      });

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
  bulkUploadWeeklySchedule,
  validateBulkUploadFile,
  getBulkUploadStatus,
  reassignMismatchedShiftEmployees,
  optimizeRouteAssignments,
  resyncPendingRides,
  updateSingleEmployeeSchedule,
  deleteSingleEmployeeSchedule,
  // resolvePendingVehicleAssignments is defined above but, same as in your
  // original file, was never wired into module.exports (so no route reaches
  // it). Add it here if that was unintentional.
};
