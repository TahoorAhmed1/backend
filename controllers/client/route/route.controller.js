const { prisma } = require("../../../lib/prisma");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");
const { shiftTimesOverlap } = require("../../../utils/shiftTime");

// ---------- helpers ----------

const toDateOnly = (d) => {
  const date = new Date(d);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

/**
 * Monday (UTC, date-only) of the week containing "now". Mirrors the
 * frontend's mondayOf() so "current week" means the same thing on both
 * sides. Used to give every trip a real assigned/remaining seat count
 * wherever trips are listed, instead of requiring a second per-route
 * weekly-view call just to avoid showing a false "0/capacity".
 */
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

/** Shapes a Trip (with its vehicle + weeklySchedules already loaded) into
 * the capacity/assigned/remaining triple the UI needs, everywhere trips are
 * listed — the single source of truth for "how full is this trip", so the
 * route list, stats, and weekly view all agree instead of each computing it
 * (or not computing it) slightly differently. */
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

/**
 * A trip's "effective" shift is its own shiftTiming if set, otherwise the
 * parent route's. Trips usually don't override the route's shift — they
 * only would if a second vehicle on the same route genuinely runs a
 * different window.
 */
const effectiveTripShift = (trip, route) =>
  trip.shiftTiming || route?.shiftTiming;

/**
 * Requirement 9: before a driver or vehicle is put on a route/trip, make
 * sure they're not already committed to a DIFFERENT route/trip whose shift
 * overlaps this one. Unlike WeeklySchedule's conflict checks (which are
 * week-scoped), Trips represent a standing assignment, so this checks
 * across every currently ACTIVE trip for that driver/vehicle.
 *
 * Returns the conflicting Trip (with its route) or null.
 */
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

/**
 * Recomputes Route.maxCapacity as the sum of every ACTIVE trip's vehicle
 * capacity, and keeps the legacy Route.driverId pointer aligned with the
 * first ACTIVE trip so older single-driver queries/UI still show something
 * sensible. Call this after any trip create/update/remove.
 */
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

/**
 * How many employees are currently riding a given Trip for a given week.
 */
const countTripOccupancy = async (tripId, weekStartDate, excludeEmployeeId) =>
  prisma.weeklySchedule.count({
    where: {
      tripId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
  });

/** Loads a trip with everything needed to compute capacity/remaining seats. */
const loadTripFull = (tripId) =>
  prisma.trip.findUnique({
    where: { id: tripId },
    include: { route: true, driver: true, vehicle: true },
  });

/**
 * Normalizes the free-form route payload used by create/update:
 * - resolves `area`/`subArea` names to areaId/subAreaId
 * - aliases `location`/`shiftTime` onto the real schema fields
 * - strips UI-only/legacy fields. Capacity and the route-level driver are
 *   derived from Trips now (see syncRouteFromTrips) and are never settable
 *   by hand through the route payload.
 */
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

/**
 * Step 1-2 of the requested workflow: create the route and assign a driver;
 * the vehicle and its seating capacity are fetched directly from that
 * driver's assigned vehicle rather than being entered by hand, so the route
 * can never show a capacity that doesn't match the vehicle actually on it.
 *
 * Body:
 *   routeCode, routeName (routeName required; routeCode auto-generated if omitted)
 *   areaId, subAreaId, officeLocation, serviceType
 *   shiftTiming, pickupStartTime, dropTime
 *   driverId (required — a route always starts with a driver assigned)
 */
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

    if (!routeName || !driverId) {
      const response = badRequestResponse(
        "routeName and driverId are required.",
      );
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

    // Requirement 9: verify the driver (and, transitively, their vehicle)
    // isn't already committed to a different route/trip during an
    // overlapping shift before we let this route claim them.
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
          routeName,
          areaId: areaId || undefined,
          subAreaId: subAreaId || undefined,
          officeLocation: officeLocation || undefined,
          serviceType: serviceType || "PICK_AND_DROP",
          shiftTiming: shiftTiming || undefined,
          pickupStartTime: pickupStartTime
            ? new Date(pickupStartTime)
            : undefined,
          dropTime: dropTime ? new Date(dropTime) : undefined,
          driverId,
          // Capacity is fetched directly from the assigned driver's vehicle,
          // never entered manually.
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

    const response = okResponse(
      {
        route: result.route,
        trip: result.trip,
        capacity: driver.vehicle.capacity,
      },
      "Route created and driver/vehicle assigned.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Overflow: additional trip on the same route ----------

/**
 * Step 4/6 of the workflow (Option 2): when a route's current trip(s) are at
 * capacity, open ANOTHER trip on the SAME route — its own driver, vehicle,
 * and (derived) capacity — instead of creating a lookalike route. Multiple
 * trips share the route name; they're told apart by tripNumber.
 *
 * Route param (preferred) or body: routeId
 * Body: { driverId, shiftTiming? }
 */
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
        "This driver has no vehicle assigned yet — assign a vehicle to the driver before adding this trip.",
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

    const response = okResponse(
      { trip, capacity: driver.vehicle.capacity },
      `Trip ${tripNumber} opened on route "${route.routeName}" for overflow.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Driver/vehicle changes on an existing trip ----------

/**
 * Requirement 8: if a trip's driver or vehicle changes, the route details
 * (capacity, and every already-assigned employee's denormalized
 * driver/vehicle) update automatically instead of going stale.
 *
 * Route param: tripId
 * Body (PATCH): { driverId?, vehicleId? } — at least one required.
 */
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

    // If only the driver changed and no vehicle was explicitly given, follow
    // the driver's own paired vehicle — same "vehicle comes from the driver"
    // rule used at route creation — unless the caller explicitly passed a
    // vehicleId (including null, to intentionally detach).
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
          "This driver has no vehicle assigned yet — assign a vehicle to the driver before reassigning this trip to them.",
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

      // Cascade the new driver/vehicle onto every WeeklySchedule row already
      // riding this trip, so the weekly schedule reflects who's actually
      // driving/using without a separate manual edit per employee.
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

    const response = okResponse(
      updatedTrip,
      "Trip driver/vehicle updated and route details synced.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Employee assignment with capacity validation ----------

/**
 * Steps 3-5 of the workflow: before assigning an employee, check remaining
 * capacity on the trip. If it's full, don't silently overbook — report the
 * overflow with the two options the workflow calls for (open a new route,
 * or open another trip on this route) so the caller/UI can act on it.
 *
 * Route param (preferred) or body: tripId
 * Body: { employeeId, weekStart, ...other WeeklySchedule fields }
 */
const assignEmployeeToTrip = async (req, res, next) => {
  try {
    const tripId = req.params.tripId || req.body.tripId;
    const { employeeId, weekStart, ...scheduleFields } = req.body;
    if (!tripId || !employeeId || !weekStart) {
      const response = badRequestResponse(
        "tripId, employeeId, and weekStart are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const trip = await loadTripFull(tripId);
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
    const occupancy = await countTripOccupancy(
      tripId,
      weekStartDate,
      employeeId,
    );
    const remaining = capacity - occupancy;

    if (remaining <= 0) {
      // Requirement 5: never assign past capacity. Surface the two options
      // from the workflow instead — the caller decides which to take.
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
        `Trip ${trip.tripNumber} on route "${trip.route.routeName}" is at capacity (${capacity}/${capacity}). ` +
          "Either assign this employee to another trip with room, add a new trip to this route (a different available driver/vehicle), or create a new route for the overflow.",
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
      return res.status(response.status.code).json(response);
    }

    const existing = await prisma.weeklySchedule.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: weekStartDate } },
    });

    const data = {
      ...scheduleFields,
      weekStart: weekStartDate,
      employeeId,
      routeId: trip.routeId,
      tripId: trip.id,
      driverId: trip.driverId,
      vehicleId: trip.vehicleId,
      shiftTiming:
        scheduleFields.shiftTiming || effectiveTripShift(trip, trip.route),
      status: scheduleFields.status || "ACTIVE",
    };

    let schedule;
    if (existing) {
      if (existing.isLocked) {
        const response = badRequestResponse(
          "This employee's schedule for this week is locked.",
        );
        return res.status(response.status.code).json(response);
      }
      schedule = await prisma.weeklySchedule.update({
        where: { id: existing.id },
        data,
      });
    } else {
      schedule = await prisma.weeklySchedule.create({ data });
    }

    const response = okResponse(
      { schedule, remainingSeats: remaining - 1, capacity },
      "Employee assigned to trip.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Route list / detail / update / delete ----------

const getAllRoutes = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status, areaId, serviceType } = req.query;
    const offset = Math.max(Number.parseInt(skip, 10) || 0, 0);
    const limit = Math.min(Math.max(Number.parseInt(take, 10) || 10, 1), 100);

    const where = {};
    if (status) where.status = status;
    if (areaId) where.areaId = areaId;
    if (serviceType) where.serviceType = serviceType;

    // Which week counts as "current" for the seats-badge on every route
    // card. Default to today's real week, but if nobody anywhere has been
    // scheduled for that exact week yet (e.g. rosters were set up for a
    // different week), fall back to the most recent week that actually has
    // active assignments — one query for the whole list rather than
    // resolving per route, so this stays cheap regardless of page size.
    let occupancyWeekStart = currentWeekMonday();
    const hasCurrentWeekData =
      (await prisma.weeklySchedule.count({
        where: { weekStart: occupancyWeekStart, status: { not: "CANCELLED" } },
      })) > 0;
    if (!hasCurrentWeekData) {
      const mostRecent = await prisma.weeklySchedule.findFirst({
        where: { status: { not: "CANCELLED" } },
        orderBy: { weekStart: "desc" },
        select: { weekStart: true },
      });
      if (mostRecent) occupancyWeekStart = mostRecent.weekStart;
    }

    const [routes, total] = await Promise.all([
      prisma.route.findMany({
        where,
        // skip: offset,
        // take: limit,

        include: {
          area: { select: { id: true, name: true } },
          subArea: { select: { id: true, name: true } },
          trips: {
            where: { status: "ACTIVE" },
            include: {
              // Trip owns driver/vehicle now — Route.driver is only kept
              // around for legacy back-compat writes (see schema comment),
              // it's not selected here since every current-flow route's
              // "who's driving" answer comes from its trips.
              driver: { select: { id: true, name: true } },
              vehicle: {
                select: { id: true, vehicleNumber: true, capacity: true },
              },
              // Occupancy for occupancyWeekStart (resolved above), computed
              // once here so every route card can show real
              // "assigned/capacity" seats without a second round trip.
              weeklySchedules: {
                where: {
                  weekStart: occupancyWeekStart,
                  status: { not: "CANCELLED" },
                },
                select: { id: true },
              },
            },
            orderBy: { tripNumber: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.route.count({ where }),
    ]);

    const shapedRoutes = routes.map((route) => ({
      ...route,
      trips: route.trips.map((trip) => ({
        ...trip,
        ...shapeTripOccupancy(trip),
      })),
    }));

    const response = okResponse(
      {
        routes: shapedRoutes,
        // pagination: {
        //   total,
        //   limit,
        //   offset,
        // },
      },
      "Routes retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
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
          include: {
            driver: { select: { id: true, name: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
            passengers: true,
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
    next(error);
  }
};

/**
 * Route-level fields only (name, area, office location, shift, etc). Driver
 * and capacity are NOT editable here — they're derived from Trips, so use
 * addTripToRoute / updateTripAssignment to change who's actually driving.
 */
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
      data: { ...updateData, updatedAt: new Date() },
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

    const response = okResponse(updated, "Route updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteRoute = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        trips: { where: { status: "ACTIVE" } },
        weeklySchedules: { where: { status: { not: "CANCELLED" } } },
        rides: true,
      },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    if (
      route.trips.length > 0 ||
      route.weeklySchedules.length > 0 ||
      route.rides.length > 0
    ) {
      const response = badRequestResponse(
        "Cannot delete route with active trips, schedules, or rides.",
      );
      return res.status(response.status.code).json(response);
    }

    await prisma.route.delete({ where: { id } });

    const response = okResponse(null, "Route deleted successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRouteEmployees = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        weeklySchedules: {
          where: { status: { not: "CANCELLED" } },
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                employeeCode: true,
                contactNumber: true,
              },
            },
            // Driver is read off the employee's Trip, not the schedule's
            // own denormalized driverId/route — Trip is the source of
            // truth for "who's actually driving this employee".
            trip: {
              select: {
                id: true,
                tripNumber: true,
                driver: { select: { id: true, name: true, phone: true } },
              },
            },
          },
        },
      },
    });

    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

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
      },
      "Route employees retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRouteRides = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { skip = 0, take = 10, status } = req.query;

    const where = { routeId: id };
    if (status) where.status = status;

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(take),
        include: {
          driver: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          passengers: true,
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.ride.count({ where }),
    ]);

    const response = okResponse(
      {
        routeId: id,
        rides,
        pagination: { total, limit: parseInt(take), offset: parseInt(skip) },
      },
      "Route rides retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
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
        rides: { select: { id: true } },
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
      totalRides: route.rides.length,
      trips,
      status: route.status,
    };

    const response = okResponse(
      stats,
      "Route statistics retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Weekly schedule display for a route ----------

/**
 * Requirement 7: everything the weekly schedule needs to show for a route —
 * route name, shift, each trip's number/driver/vehicle/capacity, assigned
 * count, and remaining seats — in one call.
 *
 * Route param: routeId
 * Query: weekStart (optional — see resolution below)
 */
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

    // Resolve which week to show. An explicit weekStart is always honored —
    // the caller is intentionally looking at that week. Otherwise, default
    // to "today's" week, but if that week has zero assignments for this
    // route while some OTHER week does, show the most recent week that
    // actually has assignments instead. Without this, a route whose roster
    // was scheduled for a different week (e.g. seeded/demo data, or a
    // roster set up ahead of/behind the literal calendar week) silently
    // renders as "0/N seats" even though people really are assigned —
    // indistinguishable from a genuinely empty trip.
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
          driver: trip.driver
            ? { id: trip.driver.id, name: trip.driver.name }
            : null,
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
        // The actual week these numbers reflect — always echoed back so the
        // UI can label it, since it may not be the caller's requested/
        // assumed week when resolvedAutomatically is true.
        weekStart: weekStartDate.toISOString().slice(0, 10),
        resolvedAutomatically,
        trips,
      },
      "Route weekly view retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createRoute,
  addTripToRoute,
  updateTripAssignment,
  assignEmployeeToTrip,
  getAllRoutes,
  getRouteById,
  updateRoute,
  deleteRoute,
  getRouteEmployees,
  getRouteRides,
  getRouteStats,
  getRouteWeeklyView,
};