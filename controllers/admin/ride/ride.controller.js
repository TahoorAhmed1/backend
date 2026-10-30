const { prisma } = require("../../../lib/prisma");
const responses = require("../../../constants/responses");

/* ------------------------------------------------------------------
 * Response shim.
 * Your real helpers RETURN an object ({ status: { code }, ... }); they do not send.
 * These wrappers send it, so every call below can be okResponse(res, data, msg).
 * ------------------------------------------------------------------ */
const send = (res, r) => res.status(r.status.code).json(r);
const okResponse = (res, data, msg = "Success.") =>
  send(res, responses.okResponse(data, msg));
const badRequestResponse = (res, msg) =>
  send(res, responses.badRequestResponse(msg));
const createSuccessResponse = (res, data, msg = "Created.") =>
  send(res, responses.createSuccessResponse(data, msg));

// A driver/employee point older than this is flagged `isStale` so the map can grey it out.
const STALE_AFTER_MS = 2 * 60 * 1000;
const MAX_PAGE_SIZE = 500;
const ACTIVE_STATUSES = ["STARTED", "ARRIVED"];

const DRIVER_SELECT = { id: true, name: true, phone: true }; // Driver has `phone`, NOT `contactNumber`
const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  employeeCode: true,
  contactNumber: true,
  address: true,
  pickupLatitude: true,
  pickupLongitude: true,
};

const DEFAULT_PAGE = 1;
const SLOW_QUERY_MS = 1000;
const LIST_DEADLINE_MS = 20 * 1000; // keep BELOW your gateway/proxy timeout
const COUNT_BUDGET_MS = 5 * 1000; // nice-to-have counts must never block the list

/* ----------------------------- formatters ----------------------------- */
// Same output as your old working controller, so the frontend table renders as before.

function formatTimeForResponse(value) {
  if (!value) return null;
  if (typeof value === "string" && !value.includes("T") && !value.includes("-")) {
    return value;
  }
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Karachi",
      });
    }
  } catch (e) {
    // ignore
  }
  return String(value);
}

function formatDateForResponse(value) {
  if (!value) return null;
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  } catch (e) {
    // ignore
  }
  return String(value);
}

const formatRide = (r) => ({
  ...r,
  rideDate: formatDateForResponse(r.rideDate),
  pickupTime: formatTimeForResponse(r.pickupTime),
  officeArrivalTime: formatTimeForResponse(r.officeArrivalTime),
  dropTime: formatTimeForResponse(r.dropTime),
});

/* ----------------------------- helpers ----------------------------- */

const stage = async (label, fn) => {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms > SLOW_QUERY_MS) console.warn(`[rides] ${label} took ${ms}ms`);
  }
};

const timed = stage;

const parsePaging = (query, defLimit = 10, maxLimit = MAX_PAGE_SIZE) => {
  const page = Math.max(parseInt(query.page, 10) || DEFAULT_PAGE, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

const pagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
  hasNextPage: page * limit < total,
  hasPrevPage: page > 1,
});

/** Rejects with code REQUEST_TIMEOUT if `promise` does not settle in `ms`. */
const withDeadline = (promise, ms, label) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = "REQUEST_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

/* ------------------------- filters (inline, no util) ------------------------- */

const buildFilters = ({
  status,
  routeId,
  driverId,
  vehicleId,
  vendorId,
  tripId,
  rideDate,
  fromDate,
  toDate,
}) => {
  const where = {};
  if (status) where.status = status;
  if (routeId) where.routeId = routeId;
  if (driverId) where.driverId = driverId;
  if (vehicleId) where.vehicleId = vehicleId;
  if (vendorId) where.vendorId = vendorId;
  if (tripId) where.tripId = tripId;

  if (rideDate) {
    const start = new Date(rideDate);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      where.rideDate = { gte: start, lt: end };
    }
  } else if (fromDate || toDate) {
    where.rideDate = {};
    if (fromDate) where.rideDate.gte = new Date(fromDate);
    if (toDate) where.rideDate.lte = new Date(toDate);
  }
  return where;
};

/* ------------------------------ count cache ------------------------------ */

const COUNT_TTL_MS = 30 * 1000;
const COUNT_CACHE_MAX = 200;
const countCache = new Map();

const cachedRideCount = (where) => {
  const key = JSON.stringify(where ?? {});
  const hit = countCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;

  const promise = prisma.ride.count({ where });
  promise.catch(() => countCache.delete(key)); // never cache a failure
  if (countCache.size >= COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value);
  countCache.set(key, { promise, expires: Date.now() + COUNT_TTL_MS });
  return promise;
};
const invalidateRideCounts = () => countCache.clear();

/* ------------------------------ search ------------------------------ */

const SEARCH_ID_CAP = 500;
const resolveSearchWhere = async (search) => {
  const term = String(search).trim();
  const contains = { contains: term, mode: "insensitive" };
  const idsOnly = { select: { id: true }, take: SEARCH_ID_CAP };

  const [routes, drivers, vehicles, vendors] = await Promise.all([
    prisma.route.findMany({
      where: { OR: [{ routeCode: contains }, { routeName: contains }] },
      ...idsOnly,
    }),
    prisma.driver.findMany({
      where: { OR: [{ name: contains }, { phone: contains }] },
      ...idsOnly,
    }),
    prisma.vehicle.findMany({ where: { vehicleNumber: contains }, ...idsOnly }),
    prisma.vendor.findMany({
      where: { OR: [{ name: contains }, { shortName: contains }] },
      ...idsOnly,
    }),
  ]);

  const or = [];
  if (routes.length) or.push({ routeId: { in: routes.map((r) => r.id) } });
  if (drivers.length) or.push({ driverId: { in: drivers.map((r) => r.id) } });
  if (vehicles.length) or.push({ vehicleId: { in: vehicles.map((r) => r.id) } });
  if (vendors.length) or.push({ vendorId: { in: vendors.map((r) => r.id) } });

  return or.length ? { OR: or } : null;
};

/* ------------------------------ counts ------------------------------ */

const countsByRide = async (model, rideIds) => {
  if (!rideIds.length) return new Map();
  const rows = await prisma[model].groupBy({
    by: ["rideId"],
    where: { rideId: { in: rideIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.rideId, r._count._all]));
};

const passengerCountsFor = (rideIds) => countsByRide("ridePassenger", rideIds);

// !! Check these two against the model names in schema.prisma (e.g. `attendance`, `complaint`).
// If a name is wrong, that column is returned as null and the list still loads.
const ATTENDANCE_MODEL = "attendance";
const COMPLAINT_MODEL = "complaint";

const softCounts = (model, rideIds) =>
  withDeadline(countsByRide(model, rideIds), COUNT_BUDGET_MS, `${model}Counts`).catch((err) => {
    console.error(`[rides] ${model} counts skipped:`, err.message);
    return null;
  });

/* ------------------------------ selects ------------------------------ */

const RIDE_ORDER = [{ rideDate: "desc" }, { id: "desc" }];

const RIDE_LIST_SELECT = {
  id: true,
  rideDate: true,
  status: true,
  serviceType: true,
  pickupTime: true,
  officeArrivalTime: true,
  dropTime: true,
  routeId: true,
  driverId: true,
  vehicleId: true,
  vendorId: true,
  tripId: true,
  areaId: true,
  subAreaId: true,
  route: { select: { id: true, routeCode: true, routeName: true } },
  driver: { select: DRIVER_SELECT },
  vehicle: { select: { id: true, vehicleNumber: true, type: true, capacity: true } },
  vendor: { select: { id: true, name: true, shortName: true } },
  area: { select: { id: true, name: true } },
  subArea: { select: { id: true, name: true } },
};

const withStale = (loc) =>
  loc
    ? { ...loc, isStale: Date.now() - new Date(loc.recordedAt).getTime() > STALE_AFTER_MS }
    : null;

const TIME_FIELDS = ["pickupTime", "officeArrivalTime", "dropTime"];
const PLAIN_FIELDS = ["areaId", "subAreaId", "serviceType", "status"];

const buildRideData = (body) => {
  const data = {};
  for (const f of PLAIN_FIELDS) if (body[f] !== undefined) data[f] = body[f] || null;
  if (data.serviceType === null) delete data.serviceType; // enum with default, not nullable
  if (data.status === null) delete data.status;
  for (const f of TIME_FIELDS) {
    if (body[f] === undefined) continue;
    if (body[f] === null || body[f] === "") {
      data[f] = null;
      continue;
    }
    const d = new Date(body[f]);
    if (Number.isNaN(d.getTime())) throw new Error(`${f} must be a valid date-time (ISO 8601)`);
    data[f] = d;
  }
  return data;
};

const prismaMessage = (error, fallback) => {
  if (error.code === "P2002") return "A ride already exists for this driver, trip and date";
  if (error.code === "P2003")
    return "One of the referenced ids (route/driver/vehicle/vendor/trip/area) does not exist";
  return error.message || fallback;
};

/* ------------------------------ CRUD ------------------------------- */

const createRide = async (req, res) => {
  try {
    const { rideDate, routeId, driverId, vehicleId, vendorId, tripId, serviceType } = req.body;

    if (!rideDate) return badRequestResponse(res, "Ride date is required.");
    if (!routeId) return badRequestResponse(res, "Route is required.");

    const date = new Date(rideDate);
    if (Number.isNaN(date.getTime()))
      return badRequestResponse(res, "rideDate must be a valid date");

    const route = await prisma.route.findUnique({ where: { id: routeId } });
    if (!route) return badRequestResponse(res, "Route not found.");

    let driverVendorId = null;
    let vehicleVendorId = null;

    if (driverId) {
      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, vendorId: true },
      });
      if (!driver) return badRequestResponse(res, "Driver not found.");
      driverVendorId = driver.vendorId;
    }

    if (vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { id: true, vendorId: true },
      });
      if (!vehicle) return badRequestResponse(res, "Vehicle not found.");
      vehicleVendorId = vehicle.vendorId;
    }

    const data = buildRideData(req.body);
    data.serviceType = serviceType || route.serviceType || "PICK_AND_DROP";

    const ride = await prisma.ride.create({
      data: {
        ...data,
        rideDate: date,
        routeId,
        driverId: driverId || null,
        vehicleId: vehicleId || null,
        vendorId: vendorId || driverVendorId || vehicleVendorId || null,
        tripId: tripId || null,
      },
      include: {
        route: { select: { id: true, routeName: true, routeCode: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        vendor: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
      },
    });
    invalidateRideCounts();

    return createSuccessResponse(res, formatRide(ride), "Ride created successfully.");
  } catch (error) {
    console.error("createRide error:", error);
    return badRequestResponse(res, prismaMessage(error, "Failed to create ride"));
  }
};

const loadRidesPage = async ({ search, filters, page, limit, skip }) => {
  const base = buildFilters(filters);
  let where = base;

  if (search && String(search).trim()) {
    const searchWhere = await resolveSearchWhere(search);
    if (!searchWhere) return { rides: [], pagination: pagination(page, limit, 0) };
    where = { AND: [base, searchWhere] };
  }

  const [rows, total] = await stage("findMany+count", () =>
    Promise.all([
      prisma.ride.findMany({
        where,
        skip,
        take: limit,
        orderBy: RIDE_ORDER,
        select: RIDE_LIST_SELECT,
        relationLoadStrategy: "join",
      }),
      cachedRideCount(where),
    ])
  );

  const ids = rows.map((r) => r.id);
  const [passengers, attendances, complaints] = await Promise.all([
    softCounts("ridePassenger", ids),
    softCounts(ATTENDANCE_MODEL, ids),
    softCounts(COMPLAINT_MODEL, ids),
  ]);

  const pick = (map, id) => (map ? map.get(id) ?? 0 : null);

  const rides = rows.map((r) => {
    const passengerCount = pick(passengers, r.id);
    const attendanceCount = pick(attendances, r.id);
    const complaintCount = pick(complaints, r.id);
    return {
      ...formatRide(r),
      passengerCount,
      attendanceCount,
      complaintCount,
      _count: {
        passengers: passengerCount,
        attendances: attendanceCount,
        complaints: complaintCount,
      },
    };
  });

  return { rides, pagination: pagination(page, limit, total) };
};

const getAllRides = async (req, res) => {
  try {
    const {
      search,
      status,
      routeId,
      driverId,
      vehicleId,
      vendorId,
      tripId,
      rideDate,
      fromDate,
      toDate,
    } = req.query;
    const { page, limit, skip } = parsePaging(req.query, 10, 100);

    const payload = await withDeadline(
      loadRidesPage({
        search,
        filters: {
          status,
          routeId,
          driverId,
          vehicleId,
          vendorId,
          tripId,
          rideDate,
          fromDate,
          toDate,
        },
        page,
        limit,
        skip,
      }),
      LIST_DEADLINE_MS,
      "getAllRides"
    );

    return okResponse(res, payload, "Rides retrieved successfully.");
  } catch (error) {
    console.error("getAllRides error:", error);
    if (error.code === "REQUEST_TIMEOUT") {
      return res.status(503).json({
        success: false,
        message: "Loading rides took too long. Please narrow the filters and try again.",
      });
    }
    return badRequestResponse(res, error.message || "Failed to fetch rides");
  }
};

const getRideById = async (req, res) => {
  try {
    const { id } = req.params;

    const [ride, locationCount, employeeLocationCount] = await timed("getRideById", () =>
      Promise.all([
        prisma.ride.findUnique({
          where: { id },
          include: {
            route: true,
            driver: true,
            vehicle: true,
            vendor: true,
            area: true,
            subArea: true,
            trip: true,
            passengers: { include: { employee: { select: EMPLOYEE_SELECT } } },
            attendances: { include: { employee: { select: { id: true, name: true } } } },
            complaints: true,
            locations: { orderBy: { recordedAt: "desc" }, take: 1 },
          },
        }),
        prisma.driverLocation.count({ where: { rideId: id } }),
        prisma.employeeLocation.count({ where: { rideId: id } }),
      ])
    );

    if (!ride) return badRequestResponse(res, "Ride not found.");

    const { locations, ...rest } = ride;
    return okResponse(
      res,
      {
        ...formatRide(rest),
        passengerCount: ride.passengers.length,
        attendanceCount: ride.attendances.length,
        complaintCount: ride.complaints.length,
        latestDriverLocation: withStale(locations[0]),
        _count: {
          passengers: ride.passengers.length,
          attendances: ride.attendances.length,
          complaints: ride.complaints.length,
          locations: locationCount,
          employeeLocations: employeeLocationCount,
        },
      },
      "Ride retrieved successfully."
    );
  } catch (error) {
    console.error("getRideById error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch ride");
  }
};

const updateRide = async (req, res) => {
  try {
    const { id } = req.params;
    const { rideDate, routeId, driverId, vehicleId, vendorId, tripId } = req.body;

    const existing = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return badRequestResponse(res, "Ride not found.");

    const data = buildRideData(req.body);

    if (rideDate !== undefined) {
      const d = new Date(rideDate);
      if (Number.isNaN(d.getTime()))
        return badRequestResponse(res, "rideDate must be a valid date");
      data.rideDate = d;
    }
    if (routeId !== undefined) data.routeId = routeId;
    if (driverId !== undefined) data.driverId = driverId || null;
    if (vehicleId !== undefined) data.vehicleId = vehicleId || null;
    if (vendorId !== undefined) data.vendorId = vendorId || null;
    if (tripId !== undefined) data.tripId = tripId || null;

    const ride = await prisma.ride.update({
      where: { id },
      data,
      include: {
        route: { select: { id: true, routeName: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        vendor: { select: { id: true, name: true } },
      },
    });
    invalidateRideCounts();
    return okResponse(res, formatRide(ride), "Ride updated successfully.");
  } catch (error) {
    console.error("updateRide error:", error);
    return badRequestResponse(res, prismaMessage(error, "Failed to update ride"));
  }
};

const deleteRide = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return badRequestResponse(res, "Ride not found.");

    await prisma.ride.delete({ where: { id } });
    invalidateRideCounts();
    return okResponse(res, null, "Ride deleted successfully.");
  } catch (error) {
    console.error("deleteRide error:", error);
    return badRequestResponse(
      res,
      error.code === "P2003"
        ? "Ride cannot be deleted because other records (passengers/attendance/complaints) reference it"
        : error.message || "Failed to delete ride"
    );
  }
};

/* ---------------------------- passengers --------------------------- */

/**
 * Body: { employeeIds: string[], leg?: "PICKUP" | "DROP" }
 * Old formats still accepted: { passengerIds: [...] } and { passengers: [{ employeeId }] }.
 */
const addPassengersToRide = async (req, res) => {
  try {
    const { id } = req.params;
    let employeeIds = req.body.employeeIds || req.body.passengerIds;
    if (!employeeIds && Array.isArray(req.body.passengers)) {
      employeeIds = req.body.passengers.map((p) => (typeof p === "string" ? p : p.employeeId));
    }
    const leg = req.body.leg || "PICKUP";

    if (!Array.isArray(employeeIds) || employeeIds.length === 0)
      return badRequestResponse(res, "employeeIds must be a non-empty array");
    if (!["PICKUP", "DROP"].includes(leg))
      return badRequestResponse(res, "leg must be PICKUP or DROP");

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) return badRequestResponse(res, "Ride not found.");

    const uniqueIds = [...new Set(employeeIds.filter(Boolean))];
    const employees = await prisma.employee.findMany({
      where: { id: { in: uniqueIds } },
      include: { area: true, subArea: true },
    });

    const found = new Set(employees.map((e) => e.id));
    const missing = uniqueIds.filter((e) => !found.has(e));
    if (missing.length)
      return badRequestResponse(res, `Employees not found: ${missing.join(", ")}`);

    const result = await prisma.ridePassenger.createMany({
      data: employees.map((e) => ({
        rideId: id,
        employeeId: e.id,
        leg,
        serviceType: ride.serviceType,
        scheduledTime: leg === "PICKUP" ? ride.pickupTime : ride.dropTime,
        employeeName: e.name,
        address: e.address,
        contact: e.contactNumber,
        area: e.area?.name ?? null,
        subArea: e.subArea?.name ?? null,
      })),
      skipDuplicates: true,
    });

    return okResponse(
      res,
      { added: result.count, skipped: uniqueIds.length - result.count },
      "Passengers added successfully."
    );
  } catch (error) {
    console.error("addPassengersToRide error:", error);
    return badRequestResponse(res, error.message || "Failed to add passengers");
  }
};

const getRidePassengers = async (req, res) => {
  try {
    const { id } = req.params;
    const { search, leg } = req.query;
    const { page, limit, skip } = parsePaging(req.query, 20, 200);

    const ride = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!ride) return badRequestResponse(res, "Ride not found.");

    const where = {
      rideId: id,
      ...(leg ? { leg } : {}),
      ...(search
        ? {
            OR: [
              { employeeName: { contains: search, mode: "insensitive" } },
              { employee: { name: { contains: search, mode: "insensitive" } } },
              { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [passengers, total] = await Promise.all([
      prisma.ridePassenger.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ scheduledTime: "asc" }, { id: "asc" }],
        include: { employee: { select: EMPLOYEE_SELECT } },
      }),
      prisma.ridePassenger.count({ where }),
    ]);

    return okResponse(
      res,
      { rideId: id, passengers, pagination: pagination(page, limit, total) },
      "Ride passengers retrieved successfully."
    );
  } catch (error) {
    console.error("getRidePassengers error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch ride passengers");
  }
};

/* ------------------------------ status ----------------------------- */

const updateRideStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["PENDING", "STARTED", "ARRIVED", "COMPLETED", "CANCELLED"];
    if (!allowed.includes(status))
      return badRequestResponse(res, `Invalid status. Allowed values: ${allowed.join(", ")}`);

    const existing = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return badRequestResponse(res, "Ride not found.");

    const ride = await prisma.ride.update({
      where: { id },
      data: { status },
      select: { id: true, rideDate: true, status: true, updatedAt: true },
    });
    invalidateRideCounts();
    return okResponse(
      res,
      { ...ride, rideDate: formatDateForResponse(ride.rideDate) },
      "Ride status updated successfully."
    );
  } catch (error) {
    console.error("updateRideStatus error:", error);
    return badRequestResponse(res, error.message || "Failed to update ride status");
  }
};

/* ----------------------------- tracking ---------------------------- */

const getLiveRides = async (req, res) => {
  try {
    const { routeId, vendorId } = req.query;

    const rides = await timed("getLiveRides", () =>
      prisma.ride.findMany({
        where: {
          status: { in: ACTIVE_STATUSES },
          ...(routeId ? { routeId } : {}),
          ...(vendorId ? { vendorId } : {}),
        },
        orderBy: [{ pickupTime: "asc" }, { id: "asc" }],
        select: {
          id: true,
          rideDate: true,
          status: true,
          serviceType: true,
          pickupTime: true,
          officeArrivalTime: true,
          dropTime: true,
          route: { select: { id: true, routeCode: true, routeName: true } },
          driver: { select: DRIVER_SELECT },
          vehicle: { select: { id: true, vehicleNumber: true, type: true, capacity: true } },
          locations: { orderBy: { recordedAt: "desc" }, take: 1 },
        },
        relationLoadStrategy: "join",
      })
    );

    const counts = await passengerCountsFor(rides.map((r) => r.id));

    const data = rides.map(({ locations, ...r }) => ({
      ...formatRide(r),
      latestDriverLocation: withStale(locations[0]),
      _count: { passengers: counts.get(r.id) ?? 0 },
    }));

    return okResponse(
      res,
      { rides: data, count: data.length, serverTime: new Date() },
      "Live rides retrieved successfully."
    );
  } catch (error) {
    console.error("getLiveRides error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch live rides");
  }
};

const getRideDriverLocation = async (req, res) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      select: { id: true, driverId: true, status: true },
    });
    if (!ride) return badRequestResponse(res, "Ride not found.");

    const location = await prisma.driverLocation.findFirst({
      where: { rideId: id },
      orderBy: { recordedAt: "desc" },
      include: { driver: { select: DRIVER_SELECT } },
    });

    return okResponse(res, {
      rideId: id,
      rideStatus: ride.status,
      driverId: ride.driverId,
      location: withStale(location),
      serverTime: new Date(),
    });
  } catch (error) {
    console.error("getRideDriverLocation error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch driver location");
  }
};

const getRideDriverLocationHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { page, limit, skip } = parsePaging(req.query, 100);
    const order = req.query.order === "asc" ? "asc" : "desc";

    let since;
    if (req.query.since) {
      since = new Date(req.query.since);
      if (Number.isNaN(since.getTime()))
        return badRequestResponse(res, "since must be a valid ISO date-time");
    }

    const ride = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!ride) return badRequestResponse(res, "Ride not found.");

    const where = { rideId: id, ...(since ? { recordedAt: { gt: since } } : {}) };

    const [locations, total] = await Promise.all([
      prisma.driverLocation.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ recordedAt: order }, { id: order }],
      }),
      prisma.driverLocation.count({ where }),
    ]);

    return okResponse(res, {
      rideId: id,
      locations,
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    console.error("getRideDriverLocationHistory error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch driver location history");
  }
};

const getRideEmployeeLocations = async (req, res) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!ride) return badRequestResponse(res, "Ride not found.");

    const latest = await prisma.$queryRaw`
      SELECT DISTINCT ON ("employeeId") *
      FROM "EmployeeLocation"
      WHERE "rideId" = ${id}
      ORDER BY "employeeId", "recordedAt" DESC
    `;

    const employees = await prisma.employee.findMany({
      where: { id: { in: latest.map((l) => l.employeeId) } },
      select: EMPLOYEE_SELECT,
    });
    const byId = new Map(employees.map((e) => [e.id, e]));

    const locations = latest.map((l) =>
      withStale({ ...l, employee: byId.get(l.employeeId) || null })
    );

    return okResponse(res, {
      rideId: id,
      locations,
      count: locations.length,
      serverTime: new Date(),
    });
  } catch (error) {
    console.error("getRideEmployeeLocations error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch employee locations");
  }
};

const getRideEmployeeLocationHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.query;
    const { page, limit, skip } = parsePaging(req.query, 100);
    const order = req.query.order === "asc" ? "asc" : "desc";

    let since;
    if (req.query.since) {
      since = new Date(req.query.since);
      if (Number.isNaN(since.getTime()))
        return badRequestResponse(res, "since must be a valid ISO date-time");
    }

    const ride = await prisma.ride.findUnique({ where: { id }, select: { id: true } });
    if (!ride) return badRequestResponse(res, "Ride not found.");

    const where = {
      rideId: id,
      ...(employeeId ? { employeeId } : {}),
      ...(since ? { recordedAt: { gt: since } } : {}),
    };

    const [locations, total] = await Promise.all([
      prisma.employeeLocation.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ recordedAt: order }, { id: order }],
        include: { employee: { select: EMPLOYEE_SELECT } },
      }),
      prisma.employeeLocation.count({ where }),
    ]);

    return okResponse(res, {
      rideId: id,
      employeeId: employeeId || null,
      locations,
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    console.error("getRideEmployeeLocationHistory error:", error);
    return badRequestResponse(res, error.message || "Failed to fetch employee location history");
  }
};

module.exports = {
  createRide,
  getAllRides,
  getRideById,
  updateRide,
  deleteRide,
  addPassengersToRide,
  updateRideStatus,
  getRidePassengers,
  getLiveRides,
  getRideDriverLocation,
  getRideDriverLocationHistory,
  getRideEmployeeLocations,
  getRideEmployeeLocationHistory,
};