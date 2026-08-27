// ---------- Concurrency protection (advisory locks) ----------

const { prisma } = require("../lib/prisma");

const acquireWeekAreaLock = async (client, weekStartDate, areaKey) => {
  const lockKey = `weekly-schedule::${weekStartDate.toISOString()}::${areaKey || "no-area"}`;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
};

const tryAcquireWeekAreaLock = async (weekStartDate, areaKey) => {
  try {
    await prisma.$transaction(
      (tx) => acquireWeekAreaLock(tx, weekStartDate, areaKey),
      { maxWait: 10000, timeout: 10000 },
    );
  } catch (lockError) {
    console.warn(
      `[weeklySchedule] Skipping week/area lock (continuing without it): ${lockError.message}`,
    );
  }
};

module.exports = {
  acquireWeekAreaLock,
  tryAcquireWeekAreaLock,
};
