// ---------- Driver rest time / working hours checks ----------

const { DAY_KEYS } = require("./dateTimeHelpers");
const { parseShiftRange } = require("../utils/shiftTime");
const { filterRoster } = require("./roster");

const MIN_REST_MINUTES = 8 * 60;
const DEFAULT_MAX_DAILY_HOURS = 12;
const DEFAULT_MAX_WEEKLY_HOURS = 60;

const hasMinimumRest = (a, b) => {
  if (!a || !b) return true;
  const aEnd = a.start + a.durationMinutes;
  const bEnd = b.start + b.durationMinutes;
  const gapAToB = (((b.start - aEnd) % 1440) + 1440) % 1440;
  const gapBToA = (((a.start - bEnd) % 1440) + 1440) % 1440;
  return Math.max(gapAToB, gapBToA) >= MIN_REST_MINUTES;
};

const countWorkingDays = (entry) =>
  DAY_KEYS.filter((day) => entry[day] && entry[day] !== "OFF").length;

const checkDriverWorkingHours = async (
  client,
  driverId,
  weekStartDate,
  candidateShiftTiming,
  candidateWorkingDays,
  excludeEmployeeId,
  caches,
) => {
  let driver = caches?.driverById?.get(driverId);
  if (!driver) {
    driver = await client.driver.findUnique({ where: { id: driverId } });
    if (driver) caches?.driverById?.set(driverId, driver);
  }
  if (!driver) return { ok: true };

  const maxDaily = driver.maxDailyHours || DEFAULT_MAX_DAILY_HOURS;
  const maxWeekly = driver.maxWeeklyHours || DEFAULT_MAX_WEEKLY_HOURS;

  const range = parseShiftRange(candidateShiftTiming);
  if (!range) return { ok: true };

  const dailyHours = range.durationMinutes / 60;
  if (dailyHours > maxDaily) {
    return {
      ok: false,
      reason: `Shift is ${dailyHours.toFixed(1)}h, which exceeds this driver's ${maxDaily}h daily limit.`,
    };
  }

  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, { driverId, excludeEmployeeId })
    : await client.weeklySchedule.findMany({
        where: {
          driverId,
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
      });

  let weeklyMinutes = range.durationMinutes * (candidateWorkingDays || 5);
  for (const other of others) {
    const otherRange = parseShiftRange(other.shiftTiming);
    if (otherRange)
      weeklyMinutes += otherRange.durationMinutes * countWorkingDays(other);
  }

  const weeklyHours = weeklyMinutes / 60;
  if (weeklyHours > maxWeekly) {
    return {
      ok: false,
      reason: `Assigning this driver would total ${weeklyHours.toFixed(1)}h this week, exceeding their ${maxWeekly}h weekly limit.`,
    };
  }

  return { ok: true };
};

module.exports = {
  MIN_REST_MINUTES,
  DEFAULT_MAX_DAILY_HOURS,
  DEFAULT_MAX_WEEKLY_HOURS,
  hasMinimumRest,
  countWorkingDays,
  checkDriverWorkingHours,
};
