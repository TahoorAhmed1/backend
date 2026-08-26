const { prisma } = require("../../../lib/prisma");
const {
  normalizeMatch,
  checkDriverWorkingHours,
  filterRoster,
  hasMinimumRest,
  normalizeVehicleType,
  findVendor,
  findOrCreateVehicleForDriver,
} = require("./helpers");
const { VEHICLE_TYPES } = require("./constants");
const {
  normalizeShift,
  parseShiftRange,
  shiftTimesOverlap,
} = require("../shiftTime");

// ============================================================
// DRIVER CONFLICT DETECTION
// ============================================================

const findDriverConflict = async (
  driverId,
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId,
  caches,
) => {
  if (!driverId) return null;
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        driverId,
        excludeTripId: targetTripId,
        excludeEmployeeId,
      })
    : await prisma.weeklySchedule.findMany({
        where: {
          driverId,
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        include: { route: true },
      });

  const candidateRange = candidateShiftTiming
    ? parseShiftRange(candidateShiftTiming)
    : null;

  for (const other of others) {
    if (!candidateShiftTiming || !other.shiftTiming) return other;
    if (shiftTimesOverlap(candidateShiftTiming, other.shiftTiming))
      return other;
    const otherRange = parseShiftRange(other.shiftTiming);
    if (
      candidateRange &&
      otherRange &&
      !hasMinimumRest(candidateRange, otherRange)
    )
      return other;
  }
  return null;
};

const findVehicleConflict = async (
  vehicleId,
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId,
  caches,
) => {
  if (!vehicleId) return null;
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        vehicleId,
        excludeTripId: targetTripId,
        excludeEmployeeId,
      })
    : await prisma.weeklySchedule.findMany({
        where: {
          vehicleId,
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        include: { route: true },
      });

  for (const other of others) {
    if (!candidateShiftTiming || !other.shiftTiming) return other;
    if (shiftTimesOverlap(candidateShiftTiming, other.shiftTiming))
      return other;
  }
  return null;
};

// ============================================================
// DRIVER LOOKUP
// ============================================================

const pickBestDriverCandidate = (candidates, normalizedVendor) => {
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const driver = candidates[0];
    const driverVendor = normalizeMatch(driver.vendor?.name);
    const vehicleVendor = normalizeMatch(driver.vehicle?.vendor?.name);

    let result = driver;
    if (normalizedVendor) {
      const vendorUnverifiable = !driverVendor && !vehicleVendor;
      const vendorMismatch =
        !vendorUnverifiable &&
        driverVendor !== normalizedVendor &&
        vehicleVendor !== normalizedVendor;
      if (vendorUnverifiable || vendorMismatch) {
        result.__matchWarning = true;
      }
    }
    return result;
  }

  let filtered = candidates;
  if (normalizedVendor) {
    const vendorFiltered = filtered.filter((d) => {
      const driverVendor = normalizeMatch(d.vendor?.name);
      const vehicleVendor = normalizeMatch(d.vehicle?.vendor?.name);
      return (
        driverVendor === normalizedVendor || vehicleVendor === normalizedVendor
      );
    });
    if (vendorFiltered.length > 0) filtered = vendorFiltered;
  }

  if (filtered.length === 1) {
    const result = filtered[0];
    if (normalizedVendor && filtered === candidates && candidates.length > 1) {
      result.__matchWarning = true;
    }
    return result;
  } else if (filtered.length > 1) {
    const result = filtered[0];
    result.__matchWarning = true;
    return result;
  }
  return null;
};

const findDriver = async (
  driverName,
  vendorNameFromSheet,
  vehicleTypeFromSheet,
  cache,
  extraCaches,
) => {
  const trimmedName = String(driverName || "").trim();
  if (!trimmedName) return null;

  const normalizedName = trimmedName.replace(/\s+/g, " ");
  const normalizedVendor = normalizeMatch(vendorNameFromSheet);
  const firstWord = normalizedName.split(" ")[0];

  const cacheKey = `${normalizedName.toLowerCase()}::${normalizedVendor}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const driverInclude = {
    vehicle: { include: { vendor: true } },
    vendor: true,
  };

  const vendorClause = normalizedVendor
    ? {
        OR: [
          {
            vendor: { name: { equals: normalizedVendor, mode: "insensitive" } },
          },
          {
            vehicle: {
              vendor: {
                name: { equals: normalizedVendor, mode: "insensitive" },
              },
            },
          },
        ],
      }
    : null;

  let candidates = await prisma.driver.findMany({
    where: { name: { equals: normalizedName, mode: "insensitive" } },
    include: driverInclude,
  });

  let matchedLoosely = false;
  if (candidates.length === 0 && firstWord && firstWord !== normalizedName) {
    const nameClause = { name: { equals: firstWord, mode: "insensitive" } };

    if (vendorClause) {
      candidates = await prisma.driver.findMany({
        where: { AND: [nameClause, vendorClause] },
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }

    if (candidates.length === 0) {
      candidates = await prisma.driver.findMany({
        where: nameClause,
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }
  }

  if (candidates.length === 0 && firstWord) {
    const nameClause = { name: { contains: firstWord, mode: "insensitive" } };

    if (vendorClause) {
      candidates = await prisma.driver.findMany({
        where: { AND: [nameClause, vendorClause] },
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }

    if (candidates.length === 0) {
      candidates = await prisma.driver.findMany({
        where: nameClause,
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }
  }

  const result = pickBestDriverCandidate(candidates, normalizedVendor);
  if (result && matchedLoosely) result.__looseNameMatch = true;

  cache?.set(cacheKey, result);
  if (result) extraCaches?.driverById?.set(result.id, result);
  return result;
};

const findVehicleByReg = async (vehicleReg, cache) => {
  const trimmed = String(vehicleReg || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toUpperCase();
  if (cache?.has(key)) return cache.get(key);

  const vehicle = await prisma.vehicle.findFirst({
    where: { vehicleNumber: { equals: trimmed, mode: "insensitive" } },
  });
  cache?.set(key, vehicle || null);
  return vehicle;
};

// ============================================================
// BEST AVAILABLE DRIVER / VEHICLE
// ============================================================

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

  let vehicle = driver.vehicle && driver.vehicle.status === "ACTIVE"
    ? driver.vehicle
    : null;

  if (!vehicle) {
    console.log(`[autoAssign] Driver ${driver.name} (${driver.id}) has no vehicle, creating placeholder...`);
    const vendorName = driver.vendor?.name || "MTS";
    const vehicleType = vehicleTypeHint || "CAR";
    
    vehicle = await findOrCreateVehicleForDriver(
      driver.id,
      vendorName,
      vehicleType,
      caches
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
      caches
    );
  }

  if (vehicle) {
    console.log(`[autoAssign] Driver ${driver.name} assigned to vehicle ${vehicle.vehicleNumber} (${vehicle.id})`);
  } else {
    console.warn(`[autoAssign] Driver ${driver.name} has NO vehicle available!`);
  }

  return { 
    driverId: driver.id, 
    vehicleId: vehicle?.id || null 
  };
};

// ============================================================
// RESOLVE CONFLICT-FREE ASSIGNMENT
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

  if (proposedDriverId && trip.driverId && proposedDriverId !== trip.driverId) {
    notes.push(
      `This row's named driver differs from another employee's driver sharing Trip #${trip.tripNumber ?? ""} on this route — kept THIS row's own driver as named in the sheet; that other employee's assignment is unaffected by this row.`,
    );
  }
  if (
    proposedVehicleId &&
    trip.vehicleId &&
    proposedVehicleId !== trip.vehicleId
  ) {
    notes.push(
      `This row's named vehicle differs from another employee's vehicle sharing Trip #${trip.tripNumber ?? ""} on this route — kept THIS row's own vehicle as named in the sheet.`,
    );
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

// ============================================================
// FIND OR CREATE VEHICLE FOR DRIVER
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
    console.log(`[findOrCreateVehicleForDriver] Created placeholder vehicle ${vehicleNumber} for driver ${driverId}`);
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
// EXPORTS
// ============================================================

module.exports = {
  findDriverConflict,
  findVehicleConflict,
  findDriver,
  findVehicleByReg,
  findBestAvailableDriver,
  findBestAvailableVehicle,
  autoAssignDriverAndVehicle,
  resolveConflictFreeAssignment,
  findOrCreateVehicleForDriver,
};