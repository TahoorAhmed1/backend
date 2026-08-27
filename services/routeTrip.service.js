// ---------- Route / trip creation & capacity helpers ----------
//
// NOTE: this file and autoAssignment.service.js reference each other
// (findOrCreateRouteAndTrip here calls findOrCreateTripOnRouteWithCapacity there,
// and autoAssignment calls guessMaxCapacity/syncRouteFromTrips here). To keep that
// circular require safe in CommonJS, both sides require the *whole module object*
// and access functions off it at call time (never destructured at the top),
// so it doesn't matter which module finishes loading first.

const { prisma } = require("../lib/prisma");
const { parseShiftRange } = require("../utils/shiftTime");
const { normalizeVehicleType } = require("../utils/xlsxParsing");
const autoAssignmentService = require("./autoAssignment.service");
const { normalizeShift } = require("../utils/shiftTime");

const slugify = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");


const DEFAULT_CAPACITY_BY_VEHICLE_TYPE = {
  CAR: 4,
  VAN: 12,
  HIJET: 10,
  KARVAN: 15,
  BUS: 40,
};
const FALLBACK_ROUTE_CAPACITY = 10;

const guessMaxCapacity = (vehicleTypeRaw) => {
  const key = normalizeVehicleType(vehicleTypeRaw);
  return DEFAULT_CAPACITY_BY_VEHICLE_TYPE[key] || FALLBACK_ROUTE_CAPACITY;
};


const countTripOccupancy = async (tripId, weekStartDate, excludeEmployeeId) => {
  return prisma.weeklySchedule.count({
    where: {
      tripId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
  });
};


const generateUniqueRouteCode = async (baseCode) => {
  let candidate = baseCode;
  let n = 1;
  while (await prisma.route.findUnique({ where: { routeCode: candidate } })) {
    n += 1;
    candidate = `${baseCode}-L${n}`;
  }
  return candidate;
};


const syncRouteFromTrips = async (routeId, caches, tripsHint) => {
  const trips =
    tripsHint ||
    (await prisma.trip.findMany({
      where: { routeId, status: "ACTIVE" },
      include: { vehicle: true },
      orderBy: { tripNumber: "asc" },
    }));

  const cachedRoute = caches?.routeById?.get(routeId);
  if (cachedRoute) {
    return cachedRoute;
  }

  const updated = await prisma.route.update({
    where: { id: routeId },
    data: {},
    include: { area: true },
  });
  caches?.routeById?.set(routeId, updated);
  return updated;
};

// ============================================================
// findExistingTripForDriverThisWeek
// ============================================================


const findExistingTripForDriverThisWeek = async (
  driverId,
  shiftTiming,
  vehicleType,
  weekStartDate,
  excludeEmployeeId,
  caches,
  options = {},
  areaRecord,
) => {
  if (!driverId || !caches?.tripIdByDriver) return null;
  const tripId = caches.tripIdByDriver.get(driverId);
  if (!tripId) return null;

  let trip = caches?.tripById?.get(tripId);
  if (!trip) {
    trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        vehicle: { include: { vendor: true } },
        route: { include: { area: true } },
      },
    });
    if (trip) caches?.tripById?.set(tripId, trip);
  }
  if (!trip || trip.status !== "ACTIVE" || trip.driverId !== driverId) {
    return null;
  }

  if (areaRecord && trip.route?.areaId && trip.route.areaId !== areaRecord.id) {
    return null;
  }

  const tripShiftTiming = trip.shiftTiming || trip.route?.shiftTiming;
  const candidateRange = parseShiftRange(shiftTiming);
  const tripRange = parseShiftRange(tripShiftTiming);
  const sameShift =
    candidateRange && tripRange
      ? candidateRange.start === tripRange.start &&
        candidateRange.durationMinutes === tripRange.durationMinutes
      : normalizeShift(shiftTiming) === normalizeShift(tripShiftTiming);
  if (!sameShift) return null;

  const capacity = trip.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
  const occupancy = caches?.weekRoster
    ? caches.weekRoster.filter(
        (r) =>
          r.tripId === trip.id &&
          (!excludeEmployeeId || r.employeeId !== excludeEmployeeId),
      ).length
    : await countTripOccupancy(trip.id, weekStartDate, excludeEmployeeId);
  const overCapacity = occupancy >= capacity;

  if (overCapacity && !options.disableMultiTrip) return null;

  return { trip, route: trip.route, overCapacity };
};

// ============================================================
// findOrCreateRouteAndTrip - UPDATED WITH CAPACITY AWARENESS
// ============================================================


const findOrCreateRouteAndTrip = async (
  areaRecord,
  vehicleType,
  shiftTiming,
  campaign,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId,
  caches,
  options = {},
  vendorName,
  location, // <-- ADD THIS
  vehicleEntity, // <-- ADD THIS
) => {
  const requestedDriverId = driverId;

  if (requestedDriverId) {
    const existingTrip = await findExistingTripForDriverThisWeek(
      requestedDriverId,
      shiftTiming,
      vehicleType,
      weekStartDate,
      excludeEmployeeId,
      caches,
      options,
      areaRecord,
    );
    if (existingTrip) {
      return {
        route: existingTrip.route,
        trip: existingTrip.trip,
        created: false,
        newTrip: false,
        overCapacity: existingTrip.overCapacity || false,
        notes: existingTrip.overCapacity
          ? [
              `Trip #${existingTrip.trip.tripNumber} (driver already on it this week/shift) is at/over its vehicle's capacity — added anyway per current settings; needs manual review.`,
            ]
          : [],
      };
    }
  }

  let route = null;
  let routeCreated = false;

  if (areaRecord) {
    let candidates = caches?.routesByArea?.get(areaRecord.id);
    if (!candidates) {
      candidates = await prisma.route.findMany({
        where: { areaId: areaRecord.id },
        include: { area: true },
        orderBy: { routeCode: "asc" },
      });
      caches?.routesByArea?.set(areaRecord.id, candidates);
    }

    if (shiftTiming) {
      const shiftNorm = normalizeShift(shiftTiming);
      route = candidates.find((r) => {
        const rShiftNorm = normalizeShift(r.shiftTiming);
        return rShiftNorm === shiftNorm;
      });
    } else {
      route = candidates[0] || null;
    }
  }

  if (!route) {
    // ========== FIX: Add location and vehicleEntity to route name ==========
    const nameParts = [areaRecord?.name, shiftTiming, location].filter(Boolean);

    const baseName = nameParts.join(" - ") || campaign || "General Route";
    // ========== END FIX ==========

    const baseCode = slugify(baseName) || `ROUTE-${Date.now()}`;

    const MAX_ROUTE_CODE_ATTEMPTS = 5;
    let lastRouteCreateError;
    for (let attempt = 1; attempt <= MAX_ROUTE_CODE_ATTEMPTS; attempt += 1) {
      const routeCode = await generateUniqueRouteCode(baseCode);
      try {
        route = await prisma.route.create({
          data: {
            routeName: baseName,
            routeCode,
            shiftTiming: shiftTiming || undefined,
            areaId: areaRecord?.id,
          },
          include: { area: true },
        });
        lastRouteCreateError = undefined;
        break;
      } catch (createErr) {
        if (createErr?.code !== "P2002") throw createErr;
        lastRouteCreateError = createErr;
      }
    }

    if (lastRouteCreateError) {
      const guaranteedCode = `${baseCode}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      route = await prisma.route.create({
        data: {
          routeName: baseName,
          routeCode: guaranteedCode,
          shiftTiming: shiftTiming || undefined,
          areaId: areaRecord?.id,
        },
        include: { area: true },
      });
    }
    routeCreated = true;
    if (areaRecord) caches?.routesByArea?.delete(areaRecord.id);
    console.log(
      `[weeklySchedule] Created new route: "${route.routeCode}" ` +
        `for area "${areaRecord?.name || "unknown"}" shift "${shiftTiming}"` +
        ` location "${location}" vehicleEntity "${vehicleEntity}"`,
    );
  }

  const {
    trip,
    newTrip,
    overCapacity,
    notes: tripNotes,
  } = await autoAssignmentService.findOrCreateTripOnRouteWithCapacity(
    route,
    vehicleType,
    shiftTiming,
    requestedDriverId,
    vehicleIdHint,
    weekStartDate,
    excludeEmployeeId,
    caches,
    { ...options, forceDriverId: requestedDriverId },
    vendorName,
  );

  route = caches?.routeById?.get(route.id) || route;

  return {
    route,
    trip,
    created: routeCreated,
    newTrip,
    overCapacity,
    notes: tripNotes || [],
  };
};

// ============================================================
// resolvePendingVehicleAssignments
// ============================================================


module.exports = {
  slugify,
  DEFAULT_CAPACITY_BY_VEHICLE_TYPE,
  FALLBACK_ROUTE_CAPACITY,
  guessMaxCapacity,
  countTripOccupancy,
  generateUniqueRouteCode,
  syncRouteFromTrips,
  findExistingTripForDriverThisWeek,
  findOrCreateRouteAndTrip,
};
