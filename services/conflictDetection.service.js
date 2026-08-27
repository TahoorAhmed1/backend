// ---------- Conflict detection (driver/vehicle double-booking) ----------

const { prisma } = require("../lib/prisma");
const { parseShiftRange, shiftTimesOverlap } = require("../utils/shiftTime");
const { filterRoster } = require("../utils/roster");

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


module.exports = {
  findDriverConflict,
  findVehicleConflict,
};
