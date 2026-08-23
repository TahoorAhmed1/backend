require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/**
 * Wipes Ride, Route, and WeeklySchedule data, plus the tables that hold
 * hard (non-cascading) foreign keys into them, so the deletes don't fail
 * on constraint violations.
 *
 * Deletion order and why:
 *  1. Complaint     - has rideId (no cascade) -> must go before Ride
 *  2. Attendance     - has rideId (no cascade) -> must go before Ride
 *  3. RidePassenger  - has rideId (cascade)    -> cleaned explicitly anyway
 *  4. Ride           - has tripId (no cascade) -> must go before Trip
 *  5. WeeklySchedule - has tripId/routeId (no cascade) -> before Trip/Route
 *  6. Trip           - has routeId (cascade)   -> must go before Route
 *  7. Route
 */
async function deleteRidesRoutesAndSchedules() {
  return prisma.$transaction([
    // prisma.attendance.deleteMany({}),
    prisma.ridePassenger.deleteMany({}),
    prisma.ride.deleteMany({}),
    // prisma.weeklySchedule.deleteMany({}),
    // prisma.trip.deleteMany({}),
    // prisma.route.deleteMany({}),
  ],10000);
}

async function main() {
  console.log("Deleting rides, routes, and weekly schedules...");

  const [
    // attendancesDeleted,
    ridePassengersDeleted,
    ridesDeleted,
    // weeklySchedulesDeleted,
    // tripsDeleted,
    // routesDeleted,
  ] = await deleteRidesRoutesAndSchedules();

  //   console.log(`Attendances deleted:              ${attendancesDeleted.count}`)
  console.log(
    `RidePassengers deleted:           ${ridePassengersDeleted.count}`,
  );
  console.log(`Rides deleted:                    ${ridesDeleted.count}`);
  //   console.log(`WeeklySchedules deleted:          ${weeklySchedulesDeleted.count}`)
  //   console.log(`Trips deleted:                    ${tripsDeleted.count}`)
  //   console.log(`Routes deleted:                   ${routesDeleted.count}`)

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
