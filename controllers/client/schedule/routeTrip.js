const { prisma } = require("../../../lib/prisma");
const {
  toDateOnly,
  normalizeShift,
  countTripOccupancy,
  syncRouteFromTrips,
  generateUniqueRouteCode,
  slugify,
  guessMaxCapacity,
  normalizeVehicleType,
  findOrCreateVehicleForDriver,
} = require("./helpers");
const {
  findDriverConflict,
  findVehicleConflict,
  autoAssignDriverAndVehicle,
  resolveConflictFreeAssignment,
} = require("./assignment");
const { normalizeShift } = require("../shiftTime");
const { parseShiftRange } = require("../shiftTime");

// ============================================================
// FIND EXISTING TRIP FOR DRIVER THIS WEEK
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
// FIND OR CREATE TRIP ON ROUTE WITH CAPACITY
// ============================================================

// ============================================================
// findOrCreateTripOnRouteWithCapacity - BUG FREE VERSION
// ============================================================

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
  if (!route || !route.id) {
    console.error('[Trip create] Invalid route:', route);
    throw new Error(`Route object is missing or has no id: ${JSON.stringify(route)}`);
  }

  // Get existing trips for this route
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

  // If driver specified, try to find trip with same driver first
  if (driverId && trips && trips.length > 0) {
    const existingTrip = trips.find((t) => t.driverId === driverId);
    if (existingTrip) {
      const capacity = existingTrip.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
      const occupancy = caches?.tripOccupancy?.get(existingTrip.id) || 
        caches?.weekRoster?.filter((r) => r.tripId === existingTrip.id && 
          (!excludeEmployeeId || r.employeeId !== excludeEmployeeId)).length || 0;
      
      if (occupancy >= capacity) {
        // Capture trip number BEFORE setting trip to null
        const tripNumber = existingTrip.tripNumber;
        notes.push(
          `Driver's existing trip #${tripNumber} is at capacity (${occupancy}/${capacity}) - looking for other options.`
        );
        // trip remains null - we'll search for another
      } else {
        trip = existingTrip;
      }
    }
  }

  // If no trip yet, find any trip with capacity
  if (!trip && trips && trips.length > 0) {
    // Sort trips: prefer those with same driver, then lower occupancy (fill up fuller trips first)
    const sortedTrips = [...trips].sort((a, b) => {
      if (driverId) {
        const aSame = a.driverId === driverId ? 1 : 0;
        const bSame = b.driverId === driverId ? 1 : 0;
        if (aSame !== bSame) return bSame - aSame;
      }
      const aOcc = caches?.tripOccupancy?.get(a.id) || 0;
      const bOcc = caches?.tripOccupancy?.get(b.id) || 0;
      return bOcc - aOcc; // Higher occupancy first to fill up
    });

    for (const candidate of sortedTrips) {
      const capacity = candidate.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
      const occupancy = caches?.tripOccupancy?.get(candidate.id) || 
        caches?.weekRoster?.filter((r) => r.tripId === candidate.id && 
          (!excludeEmployeeId || r.employeeId !== excludeEmployeeId)).length || 0;
      
      if (occupancy < capacity) {
        // Check driver conflicts if driver specified and different from trip's driver
        if (driverId && candidate.driverId && candidate.driverId !== driverId) {
          const conflict = await findDriverConflict(
            driverId,
            weekStartDate,
            shiftTiming || candidate.shiftTiming,
            candidate.id,
            excludeEmployeeId,
            caches,
          );
          if (conflict) {
            notes.push(
              `Candidate trip #${candidate.tripNumber} has different driver (${candidate.driverId}) - conflict check failed.`
            );
            continue;
          }
        }
        
        trip = candidate;
        // Update occupancy in cache
        if (caches?.tripOccupancy) {
          caches.tripOccupancy.set(trip.id, (caches.tripOccupancy.get(trip.id) || 0) + 1);
        }
        break;
      }
    }
  }

  // If no trip found with capacity, create a new one
  if (!trip) {
    // Check if we should defer creation (for bulk upload optimization)
    if (options && options.allowCreate === false) {
      return {
        trip: null,
        newTrip: false,
        overCapacity: false,
        notes: [...notes, "Trip creation deferred for batch optimization."],
        deferred: true,
      };
    }

    let safeDriverId = driverId || null;
    let safeVehicleId = vehicleIdHint || null;

    // Auto-assign driver if none provided
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
        throw new Error('Cannot create trip: No driver available for this trip');
      }
    }

    // Ensure driver has a vehicle
    if (safeDriverId && !safeVehicleId) {
      console.log(`[Trip create] Driver ${safeDriverId} has no vehicle, creating placeholder...`);
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
        throw new Error(`Driver ${safeDriverId} has no vehicle and couldn't create one`);
      }
    }

    // Check conflicts for new trip
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

    // Create the new trip
    const MAX_TRIP_NUMBER_ATTEMPTS = 5;
    let lastTripCreateError;
    let currentTrips = trips || [];
    
    for (let attempt = 1; attempt <= MAX_TRIP_NUMBER_ATTEMPTS; attempt += 1) {
      const nextTripNumber = currentTrips.length > 0
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
        
        console.log(`[Trip create] Attempt ${attempt} with data:`, JSON.stringify(createData, null, 2));
        
        trip = await prisma.trip.create({
          data: createData,
          include: { vehicle: true },
        });
        
        lastTripCreateError = undefined;
        break;
        
      } catch (createErr) {
        console.error(`[Trip create] Error on attempt ${attempt}:`, {
          code: createErr?.code,
          message: createErr?.message,
          meta: createErr?.meta,
        });
        
        if (createErr?.code !== "P2002") {
          throw createErr;
        }
        
        lastTripCreateError = createErr;
        // Refresh trips list to get latest trip numbers
        currentTrips = await prisma.trip.findMany({
          where: { routeId: route.id, status: "ACTIVE" },
          include: { vehicle: { include: { vendor: true } } },
          orderBy: { tripNumber: "asc" },
        });
      }
    }

    // If all attempts failed with unique constraint errors, use a guaranteed unique number
    if (lastTripCreateError) {
      const guaranteedTripNumber =
        (currentTrips.length > 0
          ? Math.max(...currentTrips.map((t) => t.tripNumber))
          : 0) +
        1000 +
        Math.floor(Math.random() * 1000);
      
      console.log(`[Trip create] Using guaranteed trip number: ${guaranteedTripNumber}`);
      
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

    // Update caches with new trip
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
        }
        
        caches.tripById = caches.tripById || new Map();
        trip.route = route;
        caches.tripById.set(trip.id, trip);
      }
      
      await syncRouteFromTrips(route.id, caches, trips);
      
      return {
        trip,
        newTrip: true,
        overCapacity: false,
        notes,
      };
    } else {
      throw new Error('Failed to create trip - trip is null after creation attempts');
    }
  }

  // We found an existing trip with capacity - return it
  if (trip) {
    if (trip.driverId && caches) {
      caches.tripIdByDriver = caches.tripIdByDriver || new Map();
      caches.tripIdByDriver.set(trip.driverId, trip.id);
    }
    trip.route = route;
    if (caches) {
      caches.tripById = caches.tripById || new Map();
      caches.tripById.set(trip.id, trip);
    }
  }

  return {
    trip,
    newTrip: false,
    overCapacity,
    notes,
  };
};

// ============================================================
// FIND OR CREATE ROUTE AND TRIP
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
) => {
  // First check if driver already has a trip this week with same shift
  if (driverId) {
    const existingTrip = await findExistingTripForDriverThisWeek(
      driverId,
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

  // Find or create route for this area/shift
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

  // Create route if needed
  if (!route) {
    const baseName =
      [areaRecord?.name, shiftTiming].filter(Boolean).join(" - ") ||
      campaign ||
      "General Route";
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
        `for area "${areaRecord?.name || "unknown"}" shift "${shiftTiming}"`,
    );
  }

  // Now find or create trip on this route with capacity awareness
  const {
    trip,
    newTrip,
    overCapacity,
    notes: tripNotes,
  } = await findOrCreateTripOnRouteWithCapacity(
    route,
    vehicleType,
    shiftTiming,
    driverId,
    vehicleIdHint,
    weekStartDate,
    excludeEmployeeId,
    caches,
    options,
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
// OPTIMIZE WEEK ASSIGNMENTS
// ============================================================

const optimizeWeekAssignments = async (weekStartDate) => {
  const { tryAcquireWeekAreaLock } = require("./helpers");
  await tryAcquireWeekAreaLock(weekStartDate);

  const schedules = await prisma.weeklySchedule.findMany({
    where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
    include: { route: true, trip: { include: { vehicle: true } } },
  });

  const summary = {
    scanned: schedules.length,
    driversReassigned: 0,
    vehiclesReassigned: 0,
    tripsBackfilled: 0,
    details: [],
  };

  const caches = {};

  for (const entry of schedules) {
    if (!entry.route) continue;

    let trip = entry.trip;
    if (!trip) {
      const backfilled = await findOrCreateTripOnRouteWithCapacity(
        entry.route,
        undefined,
        entry.shiftTiming || entry.route.shiftTiming,
        entry.driverId || undefined,
        entry.vehicleId || undefined,
        weekStartDate,
        entry.employeeId,
        caches,
        {
          trustProposedDriver: true,
          disableMultiTrip: false,
        },
      );
      trip = backfilled.trip;
      await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: { tripId: trip.id },
      });
      summary.tripsBackfilled++;
    }

    let driverId = entry.driverId || undefined;
    let vehicleId = entry.vehicleId || undefined;
    const shiftTiming = entry.shiftTiming || entry.route.shiftTiming;

    if (driverId) {
      const conflict = await findDriverConflict(
        driverId,
        weekStartDate,
        shiftTiming,
        trip.id,
        entry.employeeId,
        caches,
      );
      if (conflict) {
        summary.details.push({
          weeklyScheduleId: entry.id,
          note: `Driver ${driverId} has conflict but kept per sheet`,
        });
      }
    } else {
      const best = await autoAssignDriverAndVehicle(
        weekStartDate,
        shiftTiming,
        trip.id,
        undefined,
        entry.employeeId,
        caches,
      );
      if (best.driverId) {
        driverId = best.driverId;
        summary.driversReassigned++;
      }
    }

    if (vehicleId) {
      const conflict = await findVehicleConflict(
        vehicleId,
        weekStartDate,
        shiftTiming,
        trip.id,
        entry.employeeId,
        caches,
      );
      if (conflict) {
        summary.details.push({
          weeklyScheduleId: entry.id,
          note: `Vehicle ${vehicleId} has conflict but kept per sheet`,
        });
      }
    } else if (driverId) {
      const vehicle = await findOrCreateVehicleForDriver(
        driverId,
        null,
        entry.route?.routeName
          ? normalizeVehicleType(entry.route.routeName.split("-").pop())
          : "CAR",
        caches,
      );
      if (vehicle) {
        vehicleId = vehicle.id;
        summary.vehiclesReassigned++;
        summary.details.push({
          weeklyScheduleId: entry.id,
          note: `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver.`,
        });
      }
    }

    if (
      driverId !== (entry.driverId || undefined) ||
      vehicleId !== (entry.vehicleId || undefined)
    ) {
      await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: {
          driverId: driverId || null,
          vehicleId: vehicleId || null,
          tripId: trip.id,
        },
      });
      summary.details.push({
        weeklyScheduleId: entry.id,
        employeeId: entry.employeeId,
        routeId: entry.routeId,
        tripId: trip.id,
        driverId,
        vehicleId,
      });
    }
  }

  const { syncPendingRidesForWeekBestEffort } = require("../../../lib/rideplaing");
  await syncPendingRidesForWeekBestEffort(weekStartDate);

  return summary;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  findExistingTripForDriverThisWeek,
  findOrCreateTripOnRouteWithCapacity,
  findOrCreateRouteAndTrip,
  optimizeWeekAssignments,
};