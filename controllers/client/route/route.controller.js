const { prisma } = require("../../../lib/prisma");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");
const { shiftTimesOverlap } = require("../../../utils/shiftTime");
const {
  syncPendingRidesForWeekBestEffort,
} = require("../../../lib/rideplaing");
const {
  notifyDriverById,
  notifyEmployeeById,
} = require("../../../services/notification.service");

// ---------- helpers ----------

const toDateOnly = (d) => {
  const date = new Date(d);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

const currentWeekMonday = () => {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
};

const shapeTripOccupancy = (trip) => {
  const capacity = trip.vehicle?.capacity || 0;
  const assigned = trip.weeklySchedules?.length || 0;
  return {
    capacity,
    assignedEmployees: assigned,
    remainingSeats: Math.max(capacity - assigned, 0),
  };
};

const cleanString = (v) =>
  v === undefined || v === null ? "" : String(v).trim();

const effectiveTripShift = (trip, route) =>
  trip.shiftTiming || route?.shiftTiming;

const findStandingConflict = async ({
  driverId,
  vehicleId,
  shiftTiming,
  excludeTripId,
}) => {
  if (!driverId && !vehicleId) return null;

  const candidates = await prisma.trip.findMany({
    where: {
      status: "ACTIVE",
      ...(excludeTripId ? { id: { not: excludeTripId } } : {}),
      OR: [
        ...(driverId ? [{ driverId }] : []),
        ...(vehicleId ? [{ vehicleId }] : []),
      ],
    },
    include: { route: true, driver: true, vehicle: true },
  });

  for (const candidate of candidates) {
    if (
      shiftTimesOverlap(
        effectiveTripShift(candidate, candidate.route),
        shiftTiming,
      )
    ) {
      return candidate;
    }
  }
  return null;
};

const syncRouteFromTrips = async (routeId) => {
  const trips = await prisma.trip.findMany({
    where: { routeId, status: "ACTIVE" },
    include: { vehicle: true },
    orderBy: { tripNumber: "asc" },
  });

  const maxCapacity = trips.reduce(
    (sum, t) => sum + (t.vehicle?.capacity || 0),
    0,
  );

  return prisma.route.update({
    where: { id: routeId },
    data: {
      maxCapacity: maxCapacity || 0,
      driverId: trips[0]?.driverId ?? null,
    },
  });
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

const loadTripFull = (tripId) =>
  prisma.trip.findUnique({
    where: { id: tripId },
    include: { route: true, driver: true, vehicle: true },
  });

const normalizeRoutePayload = async (payload = {}) => {
  const normalized = { ...payload };

  const areaVal = cleanString(payload.area);
  if (areaVal && !payload.areaId) {
    const area = await prisma.area.findFirst({
      where: { name: { equals: areaVal, mode: "insensitive" } },
    });
    if (area) normalized.areaId = area.id;
  }

  const subAreaVal = cleanString(payload.subArea);
  if (subAreaVal && !payload.subAreaId) {
    const subArea = await prisma.subArea.findFirst({
      where: {
        name: { equals: subAreaVal, mode: "insensitive" },
        ...(normalized.areaId ? { areaId: normalized.areaId } : {}),
      },
    });
    if (subArea) normalized.subAreaId = subArea.id;
  }

  const locationVal = cleanString(payload.location || payload.officeLocation);
  if (locationVal) normalized.officeLocation = locationVal;

  const shiftVal = cleanString(payload.shiftTime || payload.shiftTiming);
  if (shiftVal) normalized.shiftTiming = shiftVal;

  delete normalized.area;
  delete normalized.subArea;
  delete normalized.block;
  delete normalized.location;
  delete normalized.shiftTime;
  delete normalized.capacity;
  delete normalized.maxCapacity;
  delete normalized.driverId;
  delete normalized.driver;
  delete normalized.assignedDriver;
  delete normalized.vehicle;
  delete normalized.assignedVehicle;
  delete normalized.notes;
  delete normalized.trips;

  return normalized;
};

// ---------- Route creation ----------

const createRoute = async (req, res, next) => {
  try {
    const {
      routeCode,
      routeName,
      areaId,
      subAreaId,
      officeLocation,
      serviceType,
      shiftTiming,
      pickupStartTime,
      dropTime,
      driverId,
    } = req.body;

    if (!routeName || !routeName.trim()) {
      const response = badRequestResponse("Route name is required.");
      return res.status(response.status.code).json(response);
    }

    if (!driverId) {
      const response = badRequestResponse("Driver is required.");
      return res.status(response.status.code).json(response);
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { vehicle: true },
    });
    if (!driver) {
      const response = badRequestResponse("Driver not found.");
      return res.status(response.status.code).json(response);
    }
    if (!driver.vehicle) {
      const response = badRequestResponse(
        "This driver has no vehicle assigned yet — assign a vehicle to the driver before creating a route with them.",
      );
      return res.status(response.status.code).json(response);
    }
    if (driver.vehicle.status !== "ACTIVE") {
      const response = badRequestResponse(
        `This driver's vehicle (${driver.vehicle.vehicleNumber}) is not ACTIVE (status: ${driver.vehicle.status}).`,
      );
      return res.status(response.status.code).json(response);
    }

    const conflict = await findStandingConflict({
      driverId,
      vehicleId: driver.vehicle.id,
      shiftTiming,
    });
    if (conflict) {
      const response = badRequestResponse(
        `Driver/vehicle is already assigned to route "${conflict.route.routeName}" (Trip ${conflict.tripNumber}) during an overlapping shift.`,
      );
      return res.status(response.status.code).json(response);
    }

    if (routeCode) {
      const existingRoute = await prisma.route.findUnique({
        where: { routeCode },
      });
      if (existingRoute) {
        const response = badRequestResponse(
          "Route with this code already exists.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    const code =
      routeCode ||
      `${routeName}`
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") + `-${Date.now().toString(36).toUpperCase()}`;

    const result = await prisma.$transaction(async (tx) => {
      const route = await tx.route.create({
        data: {
          routeCode: code,
          routeName: routeName.trim(),
          areaId: areaId || undefined,
          subAreaId: subAreaId || undefined,
          officeLocation: officeLocation || undefined,
          serviceType: serviceType || "PICK_AND_DROP",
          shiftTiming: shiftTiming || undefined,
          pickupStartTime: pickupStartTime ? new Date(pickupStartTime) : undefined,
          dropTime: dropTime ? new Date(dropTime) : undefined,
          driverId,
          maxCapacity: driver.vehicle.capacity,
        },
      });

      const trip = await tx.trip.create({
        data: {
          routeId: route.id,
          tripNumber: 1,
          driverId,
          vehicleId: driver.vehicle.id,
          shiftTiming: shiftTiming || undefined,
        },
        include: { driver: true, vehicle: true },
      });

      return { route, trip };
    });

    // ---- Notify the assigned driver ----
    notifyDriverById(driverId, {
      title: "New route assigned",
      body: `You've been assigned to route "${result.route.routeName}"${shiftTiming ? ` (${shiftTiming} shift)` : ""}.`,
      data: {
        type: "ROUTE_DRIVER_ASSIGNED",
        routeId: result.route.id,
        tripId: result.trip.id,
      },
      event: "schedule-updated",
    }).catch((err) =>
      console.error("[createRoute] Failed to notify driver:", err),
    );


    const response = createSuccessResponse(
      {
        route: result.route,
        trip: result.trip,
        capacity: driver.vehicle.capacity,
      },
      "Route created and driver/vehicle assigned.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ---------- Overflow: additional trip on the same route ----------

const addTripToRoute = async (req, res, next) => {
  try {
    const routeId = req.params.routeId || req.body.routeId;
    const { driverId, shiftTiming } = req.body;
    if (!routeId || !driverId) {
      const response = badRequestResponse("routeId and driverId are required.");
      return res.status(response.status.code).json(response);
    }

    const route = await prisma.route.findUnique({ where: { id: routeId } });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { vehicle: true },
    });
    if (!driver) {
      const response = badRequestResponse("Driver not found.");
      return res.status(response.status.code).json(response);
    }
    if (!driver.vehicle) {
      const response = badRequestResponse(
        "This driver has no vehicle assigned yet.",
      );
      return res.status(response.status.code).json(response);
    }

    const effectiveShift = shiftTiming || route.shiftTiming;
    const conflict = await findStandingConflict({
      driverId,
      vehicleId: driver.vehicle.id,
      shiftTiming: effectiveShift,
    });
    if (conflict) {
      const response = badRequestResponse(
        `Driver/vehicle is already assigned to route "${conflict.route.routeName}" (Trip ${conflict.tripNumber}) during an overlapping shift.`,
      );
      return res.status(response.status.code).json(response);
    }

    const lastTrip = await prisma.trip.findFirst({
      where: { routeId },
      orderBy: { tripNumber: "desc" },
    });
    const tripNumber = (lastTrip?.tripNumber || 0) + 1;

    const trip = await prisma.trip.create({
      data: {
        routeId,
        tripNumber,
        driverId,
        vehicleId: driver.vehicle.id,
        shiftTiming: shiftTiming || undefined,
      },
      include: { driver: true, vehicle: true },
    });

    await syncRouteFromTrips(routeId);

    // ---- Notify the assigned driver ----
    notifyDriverById(driverId, {
      title: "New trip assigned",
      body: `You've been assigned to Trip ${tripNumber} on route "${route.routeName}"${effectiveShift ? ` (${effectiveShift} shift)` : ""}.`,
      data: { type: "TRIP_DRIVER_ASSIGNED", tripId: trip.id, routeId },
      event: "schedule-updated",
    }).catch((err) =>
      console.error("[addTripToRoute] Failed to notify driver:", err),
    );


    const response = createSuccessResponse(
      { trip, capacity: driver.vehicle.capacity },
      `Trip ${tripNumber} opened on route "${route.routeName}" for overflow.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ---------- Driver/vehicle changes on an existing trip ----------

const updateTripAssignment = async (req, res, next) => {
  try {
    const { tripId } = req.params;
    const { driverId, vehicleId } = req.body;

    if (!driverId && !vehicleId) {
      const response = badRequestResponse(
        "Provide driverId and/or vehicleId to update.",
      );
      return res.status(response.status.code).json(response);
    }

    const trip = await loadTripFull(tripId);
    if (!trip) {
      const response = badRequestResponse("Trip not found.");
      return res.status(response.status.code).json(response);
    }

    let nextDriverId = driverId !== undefined ? driverId : trip.driverId;
    let nextVehicleId = vehicleId !== undefined ? vehicleId : trip.vehicleId;

    if (driverId !== undefined && vehicleId === undefined) {
      const newDriver = await prisma.driver.findUnique({
        where: { id: driverId },
        include: { vehicle: true },
      });
      if (!newDriver) {
        const response = badRequestResponse("Driver not found.");
        return res.status(response.status.code).json(response);
      }
      if (!newDriver.vehicle) {
        const response = badRequestResponse(
          "This driver has no vehicle assigned yet.",
        );
        return res.status(response.status.code).json(response);
      }
      nextVehicleId = newDriver.vehicle.id;
    }

    const effectiveShift = effectiveTripShift(trip, trip.route);
    const conflict = await findStandingConflict({
      driverId: nextDriverId,
      vehicleId: nextVehicleId,
      shiftTiming: effectiveShift,
      excludeTripId: trip.id,
    });
    if (conflict) {
      const response = badRequestResponse(
        `Driver/vehicle is already assigned to route "${conflict.route.routeName}" (Trip ${conflict.tripNumber}) during an overlapping shift.`,
      );
      return res.status(response.status.code).json(response);
    }

    const updatedTrip = await prisma.$transaction(async (tx) => {
      const updated = await tx.trip.update({
        where: { id: trip.id },
        data: {
          driverId: nextDriverId || null,
          vehicleId: nextVehicleId || null,
        },
        include: { driver: true, vehicle: true },
      });

      await tx.weeklySchedule.updateMany({
        where: { tripId: trip.id, status: { not: "CANCELLED" } },
        data: {
          driverId: nextDriverId || null,
          vehicleId: nextVehicleId || null,
        },
      });

      return updated;
    });

    await syncRouteFromTrips(trip.routeId);

    // ---- Notify old/new driver and affected employees ----
    const driverChanged = trip.driverId !== nextDriverId;
    if (driverChanged) {
      const routeLabel =
        trip.route?.routeName || trip.route?.routeCode || "a route";
      const tripLabel = `Trip ${trip.tripNumber}`;

      if (trip.driverId) {
        notifyDriverById(trip.driverId, {
          title: "Removed from trip",
          body: `You've been unassigned from ${tripLabel} on ${routeLabel}.`,
          data: {
            type: "TRIP_DRIVER_REMOVED",
            tripId: trip.id,
            routeId: trip.routeId,
          },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateTripAssignment] Failed to notify previous driver:",
            err,
          ),
        );
      }

      if (nextDriverId) {
        notifyDriverById(nextDriverId, {
          title: "New trip assigned",
          body: `You've been assigned to ${tripLabel} on ${routeLabel}${effectiveShift ? ` (${effectiveShift} shift)` : ""}.`,
          data: {
            type: "TRIP_DRIVER_ASSIGNED",
            tripId: trip.id,
            routeId: trip.routeId,
          },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateTripAssignment] Failed to notify new driver:",
            err,
          ),
        );
      }

      // Employees riding this trip weren't notified at all before — they
      // only found out their driver changed when they opened the app.
      const affectedSchedules = await prisma.weeklySchedule.findMany({
        where: { tripId: trip.id, status: { not: "CANCELLED" } },
        select: { employeeId: true },
      });
      affectedSchedules.forEach(({ employeeId }) => {
        if (!employeeId) return;
        notifyEmployeeById(employeeId, {
          title: "Trip driver changed",
          body: `Your driver on ${routeLabel} has changed to ${updatedTrip.driver?.name || "a new driver"}.`,
          data: {
            type: "SCHEDULE_TRIP_DRIVER_CHANGED",
            tripId: trip.id,
            routeId: trip.routeId,
          },
          event: "schedule-updated",
        }).catch((err) =>
          console.error(
            "[updateTripAssignment] Failed to notify affected employee:",
            err,
          ),
        );
      });

    }

    // Re-sync any already-generated PENDING rides so they pick up the new
    // driver/vehicle too — not just the weeklySchedule template rows above.
    // A trip can have active schedules across multiple weeks, so re-sync
    // each distinct affected week rather than assuming a single weekStart.
    const affectedWeeks = await prisma.weeklySchedule.findMany({
      where: { tripId: trip.id, status: { not: "CANCELLED" } },
      select: { weekStart: true },
      distinct: ["weekStart"],
    });

    await Promise.all(
      affectedWeeks.map(({ weekStart }) =>
        syncPendingRidesForWeekBestEffort(weekStart, {
          driverIds: [trip.driverId, nextDriverId].filter(Boolean),
          tripIds: [trip.id],
          vehicleIds: [trip.vehicleId, nextVehicleId].filter(Boolean),
          routeIds: [trip.routeId],
        }).catch(() => {}),
      ),
    );

    const response = okResponse(
      updatedTrip,
      "Trip driver/vehicle updated, route details synced, and pending rides re-synced.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ---------- Eligible employees for a trip's "Assign employee" picker ----------
// NOTE: Manual employee-to-trip assignment (assignEmployeeToTrip) has moved to
// weeklySchedule_controller.js, since it writes/updates a WeeklySchedule row
// and must trigger syncPendingRidesForWeekBestEffort like every other
// schedule mutation in that file. This picker endpoint stays here since it's
// a read-only helper for the route/trip UI.
// Two things narrow the list down from "every employee in the company":
//   1. Relevance — only employees in the route's area, on the route/trip's
//      shift. Someone from a different area/shift is never a real candidate
//      for this run.
//   2. Availability — exclude anyone who already has an ACTIVE (non-
//      CANCELLED) WeeklySchedule for the target week, on ANY trip. Without
//      this, picking an already-scheduled employee here would silently
//      move them off their existing trip (assignEmployeeToTrip upserts on
//      employeeId+weekStart), with no visibility into that in the UI.
const getEligibleEmployeesForTrip = async (req, res, next) => {
  try {
    const { tripId } = req.params;
    const { weekStart, search } = req.query;

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: { route: true },
    });
    if (!trip) {
      const response = badRequestResponse("Trip not found.");
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = weekStart
      ? toDateOnly(weekStart)
      : currentWeekMonday();
    const effectiveShift = effectiveTripShift(trip, trip.route);

    const employeeWhere = {
      status: "ACTIVE",
      ...(trip.route?.areaId ? { areaId: trip.route.areaId } : {}),
      ...(effectiveShift ? { shiftTiming: effectiveShift } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { employeeCode: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [candidates, alreadyScheduled] = await Promise.all([
      prisma.employee.findMany({
        where: employeeWhere,
        select: {
          id: true,
          name: true,
          employeeCode: true,
          areaId: true,
          shiftTiming: true,
        },
        orderBy: { name: "asc" },
        take: 200,
      }),
      prisma.weeklySchedule.findMany({
        where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
        select: { employeeId: true },
      }),
    ]);

    const scheduledIds = new Set(alreadyScheduled.map((s) => s.employeeId));
    const eligible = candidates.filter((e) => !scheduledIds.has(e.id));

    const response = okResponse(
      {
        tripId,
        weekStart: weekStartDate.toISOString().slice(0, 10),
        shiftTiming: effectiveShift || null,
        areaId: trip.route?.areaId || null,
        employees: eligible,
        excludedAlreadyScheduled: candidates.length - eligible.length,
      },
      "Eligible employees retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ---------- Route list / detail / update / delete ----------

const getAllRoutes = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      areaId,
      serviceType,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

    const where = {};
    if (status) where.status = status;
    if (areaId) where.areaId = areaId;
    if (serviceType) where.serviceType = serviceType;

    // Search functionality
    if (search) {
      where.OR = [
        { routeCode: { contains: search, mode: "insensitive" } },
        { routeName: { contains: search, mode: "insensitive" } },
      ];
    }

    let occupancyWeekStart = currentWeekMonday();

    const [routes, total] = await Promise.all([
      prisma.route.findMany({
        where,
        skip,
        take,
        include: {
          area: { select: { id: true, name: true } },
          subArea: { select: { id: true, name: true } },
          trips: {
            where: { status: "ACTIVE" },
            include: {
              driver: { select: { id: true, name: true } },
              vehicle: {
                select: { id: true, vehicleNumber: true, capacity: true },
              },
            },
            orderBy: { tripNumber: "asc" },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.route.count({ where }),
    ]);

    // Occupancy is resolved PER ROUTE, not once globally — a route with no
    // schedules for the current week must fall back to *its own* most
    // recent scheduled week, never another route's. Applying one
    // system-wide "most recent" week to every route on the page made a
    // quiet route borrow a busy route's week (or vice versa), showing
    // occupancy for a week that route had nothing to do with.
    const allTripIds = routes.flatMap((route) => route.trips.map((t) => t.id));

    const currentWeekCounts = allTripIds.length
      ? await prisma.weeklySchedule.groupBy({
          by: ["tripId"],
          where: {
            tripId: { in: allTripIds },
            weekStart: occupancyWeekStart,
            status: { not: "CANCELLED" },
          },
          _count: { _all: true },
        })
      : [];
    const currentWeekCountByTrip = new Map(
      currentWeekCounts.map((c) => [c.tripId, c._count._all]),
    );

    const routesNeedingFallback = routes.filter((route) => {
      const tripIds = route.trips.map((t) => t.id);
      return (
        tripIds.length > 0 &&
        tripIds.every((id) => !currentWeekCountByTrip.get(id))
      );
    });

    const fallbackWeekByRoute = new Map();
    await Promise.all(
      routesNeedingFallback.map(async (route) => {
        const tripIds = route.trips.map((t) => t.id);
        const mostRecent = await prisma.weeklySchedule.findFirst({
          where: { tripId: { in: tripIds }, status: { not: "CANCELLED" } },
          orderBy: { weekStart: "desc" },
          select: { weekStart: true },
        });
        if (mostRecent) fallbackWeekByRoute.set(route.id, mostRecent.weekStart);
      }),
    );

    const fallbackCountByTrip = new Map();
    await Promise.all(
      routesNeedingFallback.map(async (route) => {
        const weekStart = fallbackWeekByRoute.get(route.id);
        if (!weekStart) return;
        const tripIds = route.trips.map((t) => t.id);
        const counts = await prisma.weeklySchedule.groupBy({
          by: ["tripId"],
          where: {
            tripId: { in: tripIds },
            weekStart,
            status: { not: "CANCELLED" },
          },
          _count: { _all: true },
        });
        counts.forEach((c) => fallbackCountByTrip.set(c.tripId, c._count._all));
      }),
    );

    const shapedRoutes = routes.map((route) => {
      const usesFallback = fallbackWeekByRoute.has(route.id);
      const resolvedWeekStart = usesFallback
        ? fallbackWeekByRoute.get(route.id)
        : occupancyWeekStart;

      return {
        ...route,
        occupancyWeekStart: resolvedWeekStart.toISOString().slice(0, 10),
        occupancyResolvedAutomatically: usesFallback,
        trips: route.trips.map((trip) => {
          const assignedEmployees = usesFallback
            ? fallbackCountByTrip.get(trip.id) || 0
            : currentWeekCountByTrip.get(trip.id) || 0;
          const capacity = trip.vehicle?.capacity || 0;
          return {
            ...trip,
            capacity,
            assignedEmployees,
            remainingSeats: Math.max(capacity - assignedEmployees, 0),
          };
        }),
      };
    });

    const response = okResponse(
      {
        routes: shapedRoutes,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Routes retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getRouteById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        area: true,
        subArea: true,
        driver: true,
        trips: {
          include: { driver: true, vehicle: true },
          orderBy: { tripNumber: "asc" },
        },
        weeklySchedules: {
          include: {
            employee: { select: { id: true, name: true, employeeCode: true } },
          },
        },
        rides: {
          take: 10,
          orderBy: { rideDate: "desc" },
          include: {
            driver: { select: { id: true, name: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
            passengers: true,
          },
        },
        _count: {
          select: {
            trips: true,
            weeklySchedules: true,
            rides: true,
          },
        },
      },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const response = okResponse(route, "Route retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const updateRoute = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({ where: { id } });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const updateData = await normalizeRoutePayload(req.body);

    if (updateData.routeCode && updateData.routeCode !== route.routeCode) {
      const existingRoute = await prisma.route.findUnique({
        where: { routeCode: updateData.routeCode },
      });
      if (existingRoute) {
        const response = badRequestResponse("Route code already exists.");
        return res.status(response.status.code).json(response);
      }
    }

    const updated = await prisma.route.update({
      where: { id },
      data: updateData,
      include: {
        area: true,
        subArea: true,
        driver: true,
        trips: {
          include: { driver: true, vehicle: true },
          orderBy: { tripNumber: "asc" },
        },
      },
    });

    // ---- Notify affected drivers and employees ----
    // This endpoint previously sent no notifications at all, despite being
    // able to change pickup/office-arrival/drop times, area, or status on
    // a route that already has active trips and schedules — exactly the
    // kind of manual edit that needs to reach riders in real time.
    const NOTIFY_WORTHY_FIELDS = [
      "pickupStartTime",
      "officeArrivalTime",
      "dropTime",
      "shiftTiming",
      "status",
      "areaId",
      "subAreaId",
      "officeLocation",
    ];
    const notifyWorthy = NOTIFY_WORTHY_FIELDS.some((f) => f in updateData);

    if (notifyWorthy) {
      const routeLabel = updated.routeName || updated.routeCode || "your route";

      // Drivers currently on this route's active trips.
      const driverIds = new Set(
        (updated.trips || []).map((t) => t.driverId).filter(Boolean),
      );
      driverIds.forEach((driverId) => {
        notifyDriverById(driverId, {
          title: "Route updated",
          body: `Route "${routeLabel}" was updated — check pickup/drop times.`,
          data: { type: "ROUTE_UPDATED", routeId: id },
          event: "schedule-updated",
        }).catch((err) =>
          console.error("[updateRoute] Failed to notify driver:", err),
        );
      });

      // Employees currently scheduled on this route (not week-scoped —
      // this endpoint has no weekStart param, so we notify everyone with
      // a non-cancelled schedule on the route).
      const affectedSchedules = await prisma.weeklySchedule.findMany({
        where: { routeId: id, status: { not: "CANCELLED" } },
        select: { employeeId: true },
      });
      affectedSchedules.forEach(({ employeeId }) => {
        if (!employeeId) return;
        notifyEmployeeById(employeeId, {
          title: "Route updated",
          body: `Your route "${routeLabel}" was updated — check pickup/drop times.`,
          data: { type: "ROUTE_UPDATED", routeId: id },
          event: "schedule-updated",
        }).catch((err) =>
          console.error("[updateRoute] Failed to notify employee:", err),
        );
      });

    }

    const response = okResponse(updated, "Route updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const deleteRoute = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            trips: true,
            weeklySchedules: true,
            rides: true,
          },
        },
      },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const blocking = [];
    if (route._count.trips > 0) blocking.push(`${route._count.trips} trip(s)`);
    if (route._count.weeklySchedules > 0) blocking.push(`${route._count.weeklySchedules} schedule(s)`);
    if (route._count.rides > 0) blocking.push(`${route._count.rides} ride(s)`);

    if (blocking.length > 0) {
      const response = badRequestResponse(
        `Cannot delete route: referenced by ${blocking.join(", ")}. Remove related records first.`
      );
      return res.status(response.status.code).json(response);
    }

    await prisma.route.delete({ where: { id } });

    const response = okResponse(
      { id: route.id, routeName: route.routeName },
      "Route deleted successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getRouteEmployees = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, search } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        weeklySchedules: {
          where: {
            status: { not: "CANCELLED" },
            ...(search
              ? {
                  employee: {
                    OR: [
                      { name: { contains: search, mode: "insensitive" } },
                      { employeeCode: { contains: search, mode: "insensitive" } },
                    ],
                  },
                }
              : {}),
          },
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
            trip: {
              select: {
                id: true,
                tripNumber: true,
                driver: { select: { id: true, name: true, phone: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            weeklySchedules: {
              where: { status: { not: "CANCELLED" } },
            },
          },
        },
      },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const total = route._count.weeklySchedules;

    const response = okResponse(
      {
        routeId: route.id,
        routeName: route.routeName,
        employees: route.weeklySchedules.map((schedule) => ({
          ...schedule.employee,
          tripNumber: schedule.trip?.tripNumber ?? null,
          driver: schedule.trip?.driver ?? null,
          schedule,
        })),
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Route employees retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getRouteRides = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status, fromDate, toDate } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { routeId: id };
    if (status) where.status = status;
    if (fromDate || toDate) {
      where.rideDate = {};
      if (fromDate) where.rideDate.gte = new Date(fromDate);
      if (toDate) where.rideDate.lte = new Date(toDate);
    }

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        skip,
        take,
        include: {
          driver: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          _count: { select: { passengers: true } },
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.ride.count({ where }),
    ]);

    const ridesWithCounts = rides.map((ride) => ({
      ...ride,
      passengerCount: ride._count.passengers,
      _count: undefined,
    }));

    const response = okResponse(
      {
        routeId: id,
        rides: ridesWithCounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Route rides retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getRouteStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        trips: {
          where: { status: "ACTIVE" },
          include: {
            driver: { select: { id: true, name: true } },
            vehicle: {
              select: { id: true, vehicleNumber: true, capacity: true },
            },
            weeklySchedules: {
              where: { status: { not: "CANCELLED" } },
              select: { id: true },
            },
          },
          orderBy: { tripNumber: "asc" },
        },
        _count: {
          select: {
            rides: true,
            weeklySchedules: true,
          },
        },
      },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const trips = route.trips.map((trip) => ({
      tripId: trip.id,
      tripNumber: trip.tripNumber,
      driver: trip.driver,
      vehicle: trip.vehicle,
      ...shapeTripOccupancy(trip),
    }));

    const stats = {
      id: route.id,
      routeCode: route.routeCode,
      routeName: route.routeName,
      maxCapacity: route.maxCapacity,
      tripCount: trips.length,
      employeeCount: trips.reduce((sum, t) => sum + t.assignedEmployees, 0),
      totalRides: route._count.rides,
      totalSchedules: route._count.weeklySchedules,
      trips,
      status: route.status,
    };

    const response = okResponse(
      stats,
      "Route statistics retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getRouteWeeklyView = async (req, res, next) => {
  try {
    const { routeId } = req.params;
    const { weekStart } = req.query;

    const route = await prisma.route.findUnique({
      where: { id: routeId },
      include: {
        trips: {
          where: { status: "ACTIVE" },
          include: { driver: true, vehicle: true },
          orderBy: { tripNumber: "asc" },
        },
      },
    });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    let weekStartDate = weekStart ? toDateOnly(weekStart) : currentWeekMonday();
    let resolvedAutomatically = false;

    if (!weekStart) {
      const tripIds = route.trips.map((t) => t.id);
      const hasCurrentWeekData =
        tripIds.length > 0 &&
        (await prisma.weeklySchedule.count({
          where: {
            tripId: { in: tripIds },
            weekStart: weekStartDate,
            status: { not: "CANCELLED" },
          },
        })) > 0;

      if (!hasCurrentWeekData && tripIds.length > 0) {
        const mostRecent = await prisma.weeklySchedule.findFirst({
          where: { tripId: { in: tripIds }, status: { not: "CANCELLED" } },
          orderBy: { weekStart: "desc" },
          select: { weekStart: true },
        });
        if (mostRecent) {
          weekStartDate = mostRecent.weekStart;
          resolvedAutomatically = true;
        }
      }
    }

    const trips = await Promise.all(
      route.trips.map(async (trip) => {
        const assigned = await countTripOccupancy(trip.id, weekStartDate);
        const capacity = trip.vehicle?.capacity || 0;
        return {
          tripId: trip.id,
          tripNumber: trip.tripNumber,
          driver: trip.driver ? { id: trip.driver.id, name: trip.driver.name } : null,
          vehicle: trip.vehicle
            ? {
                id: trip.vehicle.id,
                vehicleNumber: trip.vehicle.vehicleNumber,
                type: trip.vehicle.type,
              }
            : null,
          capacity,
          assignedEmployees: assigned,
          remainingSeats: Math.max(capacity - assigned, 0),
        };
      }),
    );

    const response = okResponse(
      {
        routeId: route.id,
        routeName: route.routeName,
        routeCode: route.routeCode,
        shiftTiming: route.shiftTiming,
        multiTrip: trips.length > 1,
        weekStart: weekStartDate.toISOString().slice(0, 10),
        resolvedAutomatically,
        trips,
      },
      "Route weekly view retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

module.exports = {
  createRoute,
  addTripToRoute,
  updateTripAssignment,
  getEligibleEmployeesForTrip,
  getAllRoutes,
  getRouteById,
  updateRoute,
  deleteRoute,
  getRouteEmployees,
  getRouteRides,
  getRouteStats,
  getRouteWeeklyView,
};