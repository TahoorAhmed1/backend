// ---------- Auto-assignment of drivers/vehicles to schedule entries ----------
//
// NOTE: this file and routeTrip.service.js reference each other. See the
// comment at the top of routeTrip.service.js for how the circular require
// is kept safe (whole-module require, access via the namespace object).

const { prisma } = require("../lib/prisma");
const { parseShiftRange, shiftTimesOverlap } = require("../utils/shiftTime");
const { filterRoster } = require("../utils/roster");
const { findDriverConflict, findVehicleConflict } = require("./conflictDetection.service");
const { checkDriverWorkingHours, hasMinimumRest } = require("../utils/driverHours");
const { normalizeVehicleType } = require("../utils/xlsxParsing");
const { findVendor } = require("./driverVehicleMatch.service");
const routeTripService = require("./routeTrip.service");
const { selectAvailableTrip } = require("../utils/tripSelection");

const findBestAvailableDriver = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId,
  caches,
) => {
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        excludeTripId: targetTripId,
        excludeEmployeeId,
      }).filter((r) => r.driverId)
    : await prisma.weeklySchedule.findMany({
        where: {
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          driverId: { not: null },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        select: { driverId: true, shiftTiming: true },
      });

  const candidateRange = candidateShiftTiming
    ? parseShiftRange(candidateShiftTiming)
    : null;
  const busyIds = new Set();
  const loadMap = new Map();
  for (const row of others) {
    loadMap.set(row.driverId, (loadMap.get(row.driverId) || 0) + 1);
    if (!candidateShiftTiming || !row.shiftTiming) {
      busyIds.add(row.driverId);
      continue;
    }
    if (shiftTimesOverlap(candidateShiftTiming, row.shiftTiming)) {
      busyIds.add(row.driverId);
      continue;
    }
    const otherRange = parseShiftRange(row.shiftTiming);
    if (
      candidateRange &&
      otherRange &&
      !hasMinimumRest(candidateRange, otherRange)
    ) {
      busyIds.add(row.driverId);
    }
  }

  const eligible = caches?.availableDrivers
    ? caches.availableDrivers.filter((d) => !busyIds.size || !busyIds.has(d.id))
    : await prisma.driver.findMany({
        where: {
          status: "AVAILABLE",
          ...(busyIds.size ? { id: { notIn: Array.from(busyIds) } } : {}),
        },
        include: { vehicle: true },
        orderBy: { createdAt: "asc" },
      });
  if (!eligible.length) return null;
  if (eligible.length === 1) return eligible[0];

  let best = eligible[0];
  let bestLoad = loadMap.get(best.id) || 0;
  for (const driver of eligible.slice(1)) {
    const load = loadMap.get(driver.id) || 0;
    if (load < bestLoad) {
      best = driver;
      bestLoad = load;
    }
  }
  return best;
};


const findBestAvailableVehicle = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  vehicleTypeHint,
  excludeEmployeeId,
  caches,
) => {
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        excludeTripId: targetTripId,
        excludeEmployeeId,
      }).filter((r) => r.vehicleId)
    : await prisma.weeklySchedule.findMany({
        where: {
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          vehicleId: { not: null },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        select: { vehicleId: true, shiftTiming: true },
      });
  const busyIds = [];
  for (const row of others) {
    if (
      !candidateShiftTiming ||
      !row.shiftTiming ||
      shiftTimesOverlap(candidateShiftTiming, row.shiftTiming)
    ) {
      busyIds.push(row.vehicleId);
    }
  }

  const typeKey = normalizeVehicleType(vehicleTypeHint);

  if (caches?.activeVehicles) {
    const candidates = caches.activeVehicles.filter(
      (v) => !busyIds.length || !busyIds.includes(v.id),
    );

    if (typeKey && VEHICLE_TYPES.has(typeKey)) {
      const typed = candidates.find((v) => v.type === typeKey);
      if (typed) return typed;
    }
    return candidates[0] || null;
  }

  const baseWhere = {
    status: "ACTIVE",
    ...(busyIds.length ? { id: { notIn: busyIds } } : {}),
  };

  if (typeKey && VEHICLE_TYPES.has(typeKey)) {
    const typed = await prisma.vehicle.findFirst({
      where: { ...baseWhere, type: typeKey },
    });
    if (typed) return typed;
  }

  return prisma.vehicle.findFirst({
    where: baseWhere,
  });
};


const autoAssignDriverAndVehicle = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  vehicleTypeHint,
  excludeEmployeeId,
  caches,
) => {
  const driver = await findBestAvailableDriver(
    weekStartDate,
    candidateShiftTiming,
    targetTripId,
    excludeEmployeeId,
    caches,
  );
  if (!driver) {
    return { driverId: null, vehicleId: null };
  }

  let vehicle =
    driver.vehicle && driver.vehicle.status === "ACTIVE"
      ? driver.vehicle
      : null;

  if (!vehicle) {
    console.log(
      `[autoAssign] Driver ${driver.name} (${driver.id}) has no vehicle, creating placeholder...`,
    );
    const vendorName = driver.vendor?.name || "MTS";
    const vehicleType = vehicleTypeHint || "CAR";

    vehicle = await findOrCreateVehicleForDriver(
      driver.id,
      vendorName,
      vehicleType,
      caches,
    );
  }

  if (!vehicle) {
    vehicle = await findBestAvailableVehicle(
      weekStartDate,
      candidateShiftTiming,
      targetTripId,
      vehicleTypeHint,
      excludeEmployeeId,
      caches,
    );
  }

  if (!vehicle) {
    const vendorName = driver.vendor?.name || "MTS";
    const vehicleType = vehicleTypeHint || "CAR";

    vehicle = await findOrCreateVehicleForDriver(
      driver.id,
      vendorName,
      vehicleType,
      caches,
    );
  }

  if (vehicle) {
    console.log(
      `[autoAssign] Driver ${driver.name} assigned to vehicle ${vehicle.vehicleNumber} (${vehicle.id})`,
    );
  } else {
    console.warn(
      `[autoAssign] Driver ${driver.name} has NO vehicle available!`,
    );
  }

  return {
    driverId: driver.id,
    vehicleId: vehicle?.id || null,
  };
};

// ============================================================
// findOrCreateVehicleForDriver
// ============================================================


const findOrCreateVehicleForDriver = async (
  driverId,
  vendorName,
  vehicleType,
  caches,
) => {
  if (!driverId) return null;

  let driver = caches?.driverById?.get(driverId);
  if (!driver) {
    driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { vehicle: true },
    });
    if (driver) caches?.driverById?.set(driverId, driver);
  }

  if (driver?.vehicle?.id) {
    const cached = caches?.vehicle?.get(driver.vehicle.id);
    if (cached) return cached;
    const existingVehicle = await prisma.vehicle.findUnique({
      where: { id: driver.vehicle.id },
    });
    if (existingVehicle) {
      caches?.vehicle?.set(existingVehicle.id, existingVehicle);
      return existingVehicle;
    }
  }

  const anyExistingVehicle = await prisma.vehicle.findFirst({
    where: { driverId },
  });
  if (anyExistingVehicle) {
    caches?.vehicle?.set(anyExistingVehicle.id, anyExistingVehicle);
    if (driver) {
      driver.vehicle = anyExistingVehicle;
      caches?.driverById?.set(driverId, driver);
    }
    return anyExistingVehicle;
  }

  const vendor = await findVendor(vendorName, caches?.vendor);
  const vehicleTypeNorm = normalizeVehicleType(vehicleType);

  if (vendor && vehicleTypeNorm && VEHICLE_TYPES.has(vehicleTypeNorm)) {
    const existingVehicle = await prisma.vehicle.findFirst({
      where: {
        vendorId: vendor.id,
        type: vehicleTypeNorm,
        driverId: null,
        status: "ACTIVE",
      },
    });

    if (existingVehicle) {
      const updated = await prisma.vehicle.update({
        where: { id: existingVehicle.id },
        data: { driverId: driverId },
      });
      caches?.vehicle?.set(updated.id, updated);
      if (driver) {
        driver.vehicle = updated;
        caches?.driverById?.set(driverId, driver);
      }
      return updated;
    }
  }

  const driverName = driver?.name || "UNKNOWN";
  const timestamp = Date.now().toString().slice(-6);
  const vehicleNumber = `TEMP-${driverName.toUpperCase().replace(/\s+/g, "-")}-${timestamp}`;

  const DEFAULT_CAPACITY = {
    CAR: 4,
    VAN: 12,
    HIJET: 10,
    KARVAN: 15,
    BUS: 40,
  };

  let newVehicle;
  try {
    newVehicle = await prisma.vehicle.create({
      data: {
        vehicleNumber: vehicleNumber,
        type: vehicleTypeNorm || "CAR",
        capacity: DEFAULT_CAPACITY[vehicleTypeNorm] || 4,
        status: "ACTIVE",
        vendorId: vendor?.id || null,
        driverId: driverId,
        notes: `Placeholder vehicle created from sheet upload. Original vendor: ${vendorName || "N/A"}, Type: ${vehicleType || "N/A"}. Replace with actual vehicle when available.`,
      },
    });
    console.log(
      `[findOrCreateVehicleForDriver] Created placeholder vehicle ${vehicleNumber} for driver ${driverId}`,
    );
  } catch (createError) {
    if (createError?.code === "P2002") {
      const settled = await prisma.vehicle.findFirst({ where: { driverId } });
      if (settled) {
        caches?.vehicle?.set(settled.id, settled);
        if (driver) {
          driver.vehicle = settled;
          caches?.driverById?.set(driverId, driver);
        }
        return settled;
      }
    }
    throw createError;
  }

  caches?.vehicle?.set(newVehicle.id, newVehicle);
  if (driver) {
    driver.vehicle = newVehicle;
    caches?.driverById?.set(driverId, driver);
  }

  return newVehicle;
};

// ============================================================
// resolveConflictFreeAssignment
// ============================================================


const resolveConflictFreeAssignment = async ({
  trip,
  weekStartDate,
  candidateShiftTiming,
  proposedDriverId,
  proposedVehicleId,
  vehicleTypeHint,
  excludeEmployeeId,
  caches,
  options,
}) => {
  const notes = [];
  let driverId = proposedDriverId || trip.driverId || undefined;
  let vehicleId = proposedVehicleId || trip.vehicleId || undefined;

  const sheetSpecifiedDriver = proposedDriverId;
  const sheetSpecifiedVehicle = proposedVehicleId;

  if (sheetSpecifiedDriver) {
    if (trip.driverId && trip.driverId !== sheetSpecifiedDriver) {
      const updatedTrip = await prisma.trip.update({
        where: { id: trip.id },
        data: { driverId: sheetSpecifiedDriver },
        include: { vehicle: true, route: true },
      });

      if (caches) {
        caches.tripById?.set(trip.id, updatedTrip);
        caches.tripIdByDriver?.set(sheetSpecifiedDriver, trip.id);
        caches.tripDriverMap?.set(trip.id, sheetSpecifiedDriver);

        if (trip.driverId) {
          const oldTripId = caches.tripIdByDriver?.get(trip.driverId);
          if (oldTripId === trip.id) {
            caches.tripIdByDriver?.delete(trip.driverId);
          }
        }
      }

      trip.driverId = sheetSpecifiedDriver;
      trip.driver = updatedTrip.driver;
      notes.push(`Force-updated trip to use sheet-specified driver`);
    }

    driverId = sheetSpecifiedDriver;

    if (sheetSpecifiedVehicle) {
      if (trip.vehicleId && trip.vehicleId !== sheetSpecifiedVehicle) {
        await prisma.trip.update({
          where: { id: trip.id },
          data: { vehicleId: sheetSpecifiedVehicle },
        });
        trip.vehicleId = sheetSpecifiedVehicle;
        notes.push(`Force-updated trip to use sheet-specified vehicle`);
      }
      vehicleId = sheetSpecifiedVehicle;
    }
  }

  if (driverId && trip.driverId && driverId !== trip.driverId) {
    notes.push(
      `This row's named driver differs from another employee's driver sharing Trip #${trip.tripNumber ?? ""} on this route — kept THIS row's own driver as named in the sheet.`,
    );

    await prisma.trip.update({
      where: { id: trip.id },
      data: { driverId: driverId },
    });
    trip.driverId = driverId;

    if (caches) {
      caches.tripIdByDriver?.set(driverId, trip.id);
      caches.tripDriverMap?.set(trip.id, driverId);
    }
  }

  if (vehicleId && trip.vehicleId && vehicleId !== trip.vehicleId) {
    notes.push(
      `This row's named vehicle differs from another employee's vehicle sharing Trip #${trip.tripNumber ?? ""} on this route — kept THIS row's own vehicle as named in the sheet.`,
    );

    await prisma.trip.update({
      where: { id: trip.id },
      data: { vehicleId: vehicleId },
    });
    trip.vehicleId = vehicleId;
  }

  let autoAssignedDriver = false;
  let autoAssignedVehicle = false;
  const shiftTiming =
    candidateShiftTiming || trip.shiftTiming || trip.route?.shiftTiming;

  if (driverId) {
    const conflict = await findDriverConflict(
      driverId,
      weekStartDate,
      shiftTiming,
      trip.id,
      excludeEmployeeId,
      caches,
    );
    if (conflict) {
      notes.push(
        `Driver's shift may overlap route "${conflict.route?.routeCode ?? conflict.routeId}" this week — kept as assigned in the sheet; please double-check manually.`,
      );
    }

    const hoursCheck = await checkDriverWorkingHours(
      prisma,
      driverId,
      weekStartDate,
      shiftTiming,
      undefined,
      excludeEmployeeId,
      caches,
    );
    if (!hoursCheck.ok) {
      notes.push(
        `Driver may exceed working-hours limits this week — ${hoursCheck.reason} Kept as assigned in the sheet; please double-check manually.`,
      );
    }
  } else if (options?.skipAutoAssignDriver) {
    notes.push(
      "Sheet named a driver that couldn't be matched to master data — left unassigned rather than auto-assigning a different driver. Please review manually.",
    );
  } else {
    const best = await autoAssignDriverAndVehicle(
      weekStartDate,
      shiftTiming,
      trip.id,
      vehicleTypeHint,
      excludeEmployeeId,
      caches,
    );
    if (best.driverId) {
      driverId = best.driverId;
      autoAssignedDriver = true;
      if (!vehicleId && best.vehicleId) {
        vehicleId = best.vehicleId;
        autoAssignedVehicle = true;
      }
    } else {
      notes.push("No available driver found for this row — left unassigned.");
    }
  }

  if (vehicleId) {
    const conflict = await findVehicleConflict(
      vehicleId,
      weekStartDate,
      shiftTiming,
      trip.id,
      excludeEmployeeId,
      caches,
    );
    if (conflict) {
      notes.push(
        `Vehicle's shift may overlap route "${conflict.route?.routeCode ?? conflict.routeId}" this week — kept as assigned in the sheet; please double-check manually.`,
      );
    }
  } else if (driverId) {
    const vehicle = await findOrCreateVehicleForDriver(
      driverId,
      null,
      vehicleTypeHint,
      caches,
    );
    if (vehicle) {
      vehicleId = vehicle.id;
      autoAssignedVehicle = true;
      if (vehicle.notes?.includes("Placeholder")) {
        notes.push(
          `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver. Replace with actual vehicle when available.`,
        );
      }
    } else {
      notes.push(
        "No vehicle found for this driver and unable to create placeholder — left unassigned.",
      );
    }
  }

  const tripDriverNeedsUpdate = !trip.driverId && driverId;
  const tripVehicleNeedsUpdate = !trip.vehicleId && vehicleId;

  if (tripDriverNeedsUpdate || tripVehicleNeedsUpdate) {
    const updatedTrip = await prisma.trip.update({
      where: { id: trip.id },
      data: {
        ...(tripDriverNeedsUpdate ? { driverId } : {}),
        ...(tripVehicleNeedsUpdate ? { vehicleId } : {}),
      },
      include: { vehicle: true, route: true },
    });
    caches?.tripsByRoute?.delete(trip.routeId);

    if (driverId) caches?.tripIdByDriver?.set(driverId, trip.id);
    caches?.tripById?.set(trip.id, updatedTrip);
  } else {
    if (driverId) caches?.tripIdByDriver?.set(driverId, trip.id);
  }

  return {
    driverId,
    vehicleId,
    autoAssignedDriver,
    autoAssignedVehicle,
    notes,
  };
};


const findOrCreateTripOnRouteWithCapacity = async (
  route,
  vehicleType,
  shiftTiming,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId,
  caches,
  options = {},
  vendorName,
) => {
  // Force driver ID if specified in options
  const requestedDriverId = options?.forceDriverId || driverId;
  const requestedVehicleId = vehicleIdHint;

  if (!route || !route.id) {
    console.error("[Trip create] Invalid route:", route);
    throw new Error(
      `Route object is missing or has no id: ${JSON.stringify(route)}`,
    );
  }

  let trips = caches?.tripsByRoute?.get(route.id);
  if (!trips) {
    trips = await prisma.trip.findMany({
      where: { routeId: route.id, status: "ACTIVE" },
      include: { vehicle: { include: { vendor: true } } },
      orderBy: { tripNumber: "asc" },
    });
    if (caches) {
      caches.tripsByRoute = caches.tripsByRoute || new Map();
      caches.tripsByRoute.set(route.id, trips);
    }
  }
  const hadExistingTrips = trips && trips.length > 0;

  let trip = null;
  let overCapacity = false;
  const notes = [];

  if (requestedDriverId && trips && trips.length > 0) {
    const driverTrips = trips.filter((t) => t.driverId === requestedDriverId);

    if (driverTrips.length > 0) {
      trip = selectAvailableTrip(
        driverTrips,
        (candidateTrip) =>
          caches?.tripOccupancy?.get(candidateTrip.id) ??
          caches?.weekRoster?.filter((r) => r.tripId === candidateTrip.id)
            .length ??
          0,
        (candidateTrip) =>
          candidateTrip.vehicle?.capacity ??
          routeTripService.guessMaxCapacity(vehicleType),
      );
    }
  }

  if (!trip && !requestedDriverId && trips && trips.length > 0) {
    trip = selectAvailableTrip(
      trips,
      (candidateTrip) =>
        caches?.tripOccupancy?.get(candidateTrip.id) ??
        caches?.weekRoster?.filter((r) => r.tripId === candidateTrip.id)
          .length ??
        0,
      (candidateTrip) =>
        candidateTrip.vehicle?.capacity ??
        routeTripService.guessMaxCapacity(vehicleType),
    );
  }

  if (!trip) {
    if (options && options.allowCreate === false) {
      return {
        trip: null,
        newTrip: false,
        overCapacity: false,
        notes: [...notes, "Trip creation deferred for batch optimization."],
        deferred: true,
      };
    }

    let safeDriverId = requestedDriverId || null;
    let safeVehicleId = requestedVehicleId || null;

    if (!safeDriverId) {
      const best = await autoAssignDriverAndVehicle(
        weekStartDate,
        shiftTiming,
        null,
        vehicleType,
        excludeEmployeeId,
        caches,
      );
      if (best && best.driverId) {
        safeDriverId = best.driverId;
        safeVehicleId = best.vehicleId || null;
        notes.push(`Driver auto-assigned: ${safeDriverId}`);
      } else {
        throw new Error(
          "Cannot create trip: No driver available for this trip",
        );
      }
    }

    if (safeDriverId && !safeVehicleId) {
      const vehicle = await findOrCreateVehicleForDriver(
        safeDriverId,
        vendorName || "MTS",
        vehicleType || "CAR",
        caches,
      );
      if (vehicle) {
        safeVehicleId = vehicle.id;
        if (vehicle.notes && vehicle.notes.includes("Placeholder")) {
          notes.push(
            `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver "${safeDriverId}". Replace with actual vehicle when available.`,
          );
        }
      } else {
        throw new Error(
          `Driver ${safeDriverId} has no vehicle and couldn't create one`,
        );
      }
    }

    if (safeDriverId) {
      const driverConflict = await findDriverConflict(
        safeDriverId,
        weekStartDate,
        shiftTiming,
        null,
        excludeEmployeeId,
        caches,
      );
      if (driverConflict) {
        notes.push(
          `Driver's shift may overlap route "${driverConflict.route?.routeCode || driverConflict.routeId}" this week — kept as named in the sheet; please double-check manually.`,
        );
      }
    }

    if (safeVehicleId) {
      const vehicleConflict = await findVehicleConflict(
        safeVehicleId,
        weekStartDate,
        shiftTiming,
        null,
        excludeEmployeeId,
        caches,
      );
      if (vehicleConflict) {
        notes.push(
          `Vehicle's shift may overlap route "${vehicleConflict.route?.routeCode || vehicleConflict.routeId}" this week — kept as named in the sheet; please double-check manually.`,
        );
      }
    }

    const MAX_TRIP_NUMBER_ATTEMPTS = 5;
    let lastTripCreateError;
    let currentTrips = trips || [];

    for (let attempt = 1; attempt <= MAX_TRIP_NUMBER_ATTEMPTS; attempt += 1) {
      const nextTripNumber =
        currentTrips.length > 0
          ? Math.max(...currentTrips.map((t) => t.tripNumber)) + 1
          : 1;

      try {
        const createData = {
          routeId: route.id,
          tripNumber: nextTripNumber,
          driverId: safeDriverId,
          vehicleId: safeVehicleId || null,
          shiftTiming: shiftTiming || null,
        };

        trip = await prisma.trip.create({
          data: createData,
          include: { vehicle: true },
        });

        if (trip) {
          if (!trips) trips = [];
          trips.push(trip);
          if (caches) {
            caches.tripsByRoute = caches.tripsByRoute || new Map();
            caches.tripsByRoute.set(route.id, trips);
            caches.tripOccupancy = caches.tripOccupancy || new Map();
            caches.tripOccupancy.set(trip.id, 1);
            if (trip.driverId) {
              caches.tripIdByDriver = caches.tripIdByDriver || new Map();
              caches.tripIdByDriver.set(trip.driverId, trip.id);
              caches.tripDriverMap = caches.tripDriverMap || new Map();
              caches.tripDriverMap.set(trip.id, trip.driverId);
            }
            caches.tripById = caches.tripById || new Map();
            trip.route = route;
            caches.tripById.set(trip.id, trip);
          }
        }

        lastTripCreateError = undefined;
        break;
      } catch (createErr) {
        if (createErr?.code !== "P2002") {
          throw createErr;
        }
        lastTripCreateError = createErr;
        currentTrips = await prisma.trip.findMany({
          where: { routeId: route.id, status: "ACTIVE" },
          include: { vehicle: { include: { vendor: true } } },
          orderBy: { tripNumber: "asc" },
        });
      }
    }

    if (lastTripCreateError) {
      const guaranteedTripNumber =
        (currentTrips.length > 0
          ? Math.max(...currentTrips.map((t) => t.tripNumber))
          : 0) +
        1000 +
        Math.floor(Math.random() * 1000);

      trip = await prisma.trip.create({
        data: {
          routeId: route.id,
          tripNumber: guaranteedTripNumber,
          driverId: safeDriverId,
          vehicleId: safeVehicleId || null,
          shiftTiming: shiftTiming || null,
        },
        include: { vehicle: true },
      });
    }

    if (trip) {
      await routeTripService.syncRouteFromTrips(route.id, caches, trips);
      return { trip, newTrip: true, overCapacity: false, notes };
    } else {
      throw new Error(
        "Failed to create trip - trip is null after creation attempts",
      );
    }
  }

  if (trip) {
    if (trip.driverId && caches) {
      caches.tripIdByDriver = caches.tripIdByDriver || new Map();
      caches.tripIdByDriver.set(trip.driverId, trip.id);
      caches.tripDriverMap = caches.tripDriverMap || new Map();
      caches.tripDriverMap.set(trip.id, trip.driverId);
    }
    trip.route = route;
    if (caches) {
      caches.tripById = caches.tripById || new Map();
      caches.tripById.set(trip.id, trip);
    }
  }

  return { trip, newTrip: false, overCapacity, notes };
};


Object.assign(module.exports, {
  findBestAvailableDriver,
  findBestAvailableVehicle,
  autoAssignDriverAndVehicle,
  findOrCreateVehicleForDriver,
  resolveConflictFreeAssignment,
  findOrCreateTripOnRouteWithCapacity,
});