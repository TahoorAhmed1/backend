// ---------- Real-time route optimization ----------

const { prisma } = require("../lib/prisma");
const { tryAcquireWeekAreaLock } = require("../utils/locking");
const {
  findOrCreateTripOnRouteWithCapacity,
  autoAssignDriverAndVehicle,
  findOrCreateVehicleForDriver,
} = require("./autoAssignment.service");
const { findDriverConflict, findVehicleConflict } = require("./conflictDetection.service");
const { normalizeVehicleType } = require("../utils/xlsxParsing");

const optimizeWeekAssignments = async (weekStartDate) => {
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
        undefined,
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
        { driverById: new Map() },
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

  await syncPendingRidesForWeekBestEffort(weekStartDate);

  return summary;
};


module.exports = {
  optimizeWeekAssignments,
};
