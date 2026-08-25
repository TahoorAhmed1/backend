/**
 * prisma/reset-schedule-data.js
 *
 * Wipes ALL WeeklySchedule, Trip, and Route rows — a clean slate before
 * re-running the optimized weeklySchedule_controller.js against your now-
 * seeded Employee/Driver/Vehicle master data, so old test/dry-run routes
 * and schedules from earlier uploads don't linger alongside the new ones.
 *
 * Does NOT touch Employee, Driver, Vehicle, Vendor, Area/SubArea/Block —
 * only the weekly-schedule-specific tables. Your master data seeds
 * (prisma/seed.js, prisma/seed-employees.js) are untouched.
 *
 * ----------------------------------------------------------------------
 * WHY THIS CHECKS FOR RIDES FIRST INSTEAD OF JUST DELETING
 * ----------------------------------------------------------------------
 * Route has a `rides Ride[]` relation, and Ride.routeId is REQUIRED (not
 * nullable) — if any live/completed Ride rows exist for a route, deleting
 * that route would either fail on the FK constraint or (if you forced it)
 * orphan real ride/attendance/complaint history. That's a different,
 * higher-stakes subsystem than "weekly schedule data" — attendance and
 * complaint records can be compliance/payroll-relevant, so this script
 * refuses to touch them unless you explicitly opt in.
 *
 * DEFAULT BEHAVIOR: if any Ride rows reference the routes about to be
 * deleted, the script stops and prints how many, without deleting
 * anything. That's almost certainly what you want for a "clear out old
 * test schedule data" reset.
 *
 * OPT-IN: run with --force-rides to also remove those Ride rows (and their
 * RidePassenger children, which cascade automatically) — Attendance and
 * Complaint rows tied to a removed Ride are NOT deleted, just unlinked
 * (rideId set to null), since those are historical records in their own
 * right and shouldn't disappear just because the ride they referenced did.
 *
 * ----------------------------------------------------------------------
 * HOW TO RUN
 * ----------------------------------------------------------------------
 *   node prisma/reset-schedule-data.js
 *   node prisma/reset-schedule-data.js --force-rides   (only if the first run tells you to)
 */

require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const FORCE_RIDES = process.argv.includes("--force-rides");

async function main() {
  const [scheduleCount, tripCount, routeCount] = await Promise.all([
    prisma.weeklySchedule.count(),
    prisma.trip.count(),
    prisma.route.count(),
  ]);

  console.log(
    `Found ${scheduleCount} WeeklySchedule row(s), ${tripCount} Trip row(s), ${routeCount} Route row(s).`,
  );

  const blockingRideCount = await prisma.ride.count();

  if (blockingRideCount > 0 && !FORCE_RIDES) {
    console.log(
      `\nStopping WITHOUT deleting anything: found ${blockingRideCount} Ride row(s) ` +
        `still pointing at routes that would be deleted. Ride.routeId is required, so ` +
        `these routes can't be removed while those rides exist.\n` +
        `\nIf these rides are also just old test data you want cleared out, re-run:\n` +
        `    node prisma/reset-schedule-data.js --force-rides\n` +
        `\n(This will also unlink — not delete — any Attendance/Complaint rows that ` +
        `reference those rides, so that history stays intact.)`,
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (FORCE_RIDES && blockingRideCount > 0) {
      const rideIds = (await tx.ride.findMany({ select: { id: true } })).map(
        (r) => r.id,
      );

      const [unlinkedAttendance, unlinkedComplaints] = await Promise.all([
        tx.attendance.updateMany({
          where: { rideId: { in: rideIds } },
          data: { rideId: null },
        }),
        tx.complaint.updateMany({
          where: { rideId: { in: rideIds } },
          data: { rideId: null },
        }),
      ]);
      console.log(
        `  Unlinked ${unlinkedAttendance.count} Attendance and ` +
          `${unlinkedComplaints.count} Complaint row(s) from the rides being removed ` +
          `(kept the records themselves).`,
      );

      // RidePassenger cascades automatically (onDelete: Cascade on Ride).
      const deletedRides = await tx.ride.deleteMany({});
      console.log(`  Deleted ${deletedRides.count} Ride row(s).`);
    }

    // Children before parents: WeeklySchedule references Route AND Trip
    // directly (in addition to Trip's own Route reference), so it has to
    // go first regardless of Trip's onDelete:Cascade from Route.
    const deletedSchedules = await tx.weeklySchedule.deleteMany({});
    const deletedTrips = await tx.trip.deleteMany({});
    const deletedRoutes = await tx.route.deleteMany({});

    console.log(
      `  Deleted ${deletedSchedules.count} WeeklySchedule, ${deletedTrips.count} Trip, ` +
        `${deletedRoutes.count} Route row(s).`,
    );
  });

  console.log("\nDone — clean slate for the next bulk upload.");
}

main()
  .catch((err) => {
    console.error("Reset failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });