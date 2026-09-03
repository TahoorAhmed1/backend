const { prisma } = require("../lib/prisma");
const { notifyUsers } = require("../services/notification.service");

const DAY_MS = 24 * 60 * 60 * 1000;

// "Sep 1 - Sep 7, 2026" in local (Karachi) time, regardless of what
// timezone weekStartDate's underlying Date object was constructed in.
function formatWeekRange(weekStartDate) {
  const start = new Date(weekStartDate);
  const end = new Date(start.getTime() + 6 * DAY_MS);

  const fmt = (d) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "Asia/Karachi",
    });

  const year = start.toLocaleDateString("en-US", {
    year: "numeric",
    timeZone: "Asia/Karachi",
  });

  return `${fmt(start)} - ${fmt(end)}, ${year}`;
}

/**
 * Notify every affected employee and driver exactly ONCE that their
 * weekly ride schedule has changed — regardless of how many individual
 * ride rows (one per day, up to 7) were touched for them during the
 * week's sync. Call this once, after the whole week has been synced.
 *
 * @param {Object} params
 * @param {string[]} params.employeeIds - Employee.id values affected this week
 * @param {string[]} params.driverIds   - Driver.id values affected this week
 * @param {Date|string} params.weekStartDate - Monday of the week being notified
 */
async function notifyScheduleUpdatedForWeek({
  employeeIds = [],
  driverIds = [],
  weekStartDate,
}) {
  const uniqueEmployeeIds = [...new Set(employeeIds.filter(Boolean))];
  const uniqueDriverIds = [...new Set(driverIds.filter(Boolean))];

  if (uniqueEmployeeIds.length === 0 && uniqueDriverIds.length === 0) return;

  const weekRange = formatWeekRange(weekStartDate);
  const weekStartIso = new Date(weekStartDate).toISOString();

  const [employees, drivers] = await Promise.all([
    uniqueEmployeeIds.length
      ? prisma.employee.findMany({
          where: { id: { in: uniqueEmployeeIds }, userId: { not: null } },
          select: { userId: true },
        })
      : [],
    uniqueDriverIds.length
      ? prisma.driver.findMany({
          where: { id: { in: uniqueDriverIds }, userId: { not: null } },
          select: { userId: true },
        })
      : [],
  ]);

  const employeeUserIds = employees.map((e) => e.userId).filter(Boolean);
  const driverUserIds = drivers.map((d) => d.userId).filter(Boolean);

  await Promise.all([
    employeeUserIds.length
      ? notifyUsers(employeeUserIds, {
          title: "Ride Schedule Updated",
          body: `Your ride schedule for ${weekRange} has been updated.`,
          data: {
            type: "WEEKLY_SCHEDULE_UPDATED",
            weekStart: weekStartIso,
            role: "EMPLOYEE",
          },
          event: "schedule-updated",
        })
      : null,
    driverUserIds.length
      ? notifyUsers(driverUserIds, {
          title: "Driving Schedule Updated",
          body: `Your driving schedule for ${weekRange} has been updated.`,
          data: {
            type: "WEEKLY_SCHEDULE_UPDATED",
            weekStart: weekStartIso,
            role: "DRIVER",
          },
          event: "schedule-updated",
        })
      : null,
  ]);
}

// Sync writes must never fail because a push notification failed to send.
async function notifyEmployeeScheduleUpdatedBestEffort(params) {
  try {
    await notifyScheduleUpdatedForWeek(params);
  } catch (err) {
    console.warn(
      `[rideNotifications] failed to notify schedule update for week ${params?.weekStartDate}: ${err.message}`,
    );
  }
}

module.exports = {
  notifyScheduleUpdatedForWeek,
  notifyEmployeeScheduleUpdatedBestEffort,
};