require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

async function deleteRidesRoutesAndSchedules() {
  console.log("Starting deletion...\n");

  // 1. Delete records that reference Ride
  const complaintsDeleted = await prisma.complaint.deleteMany({});
  console.log(`Complaints deleted:        ${complaintsDeleted.count}`);

  const attendancesDeleted = await prisma.attendance.deleteMany({});
  console.log(`Attendances deleted:       ${attendancesDeleted.count}`);

  const ridePassengersDeleted = await prisma.ridePassenger.deleteMany({});
  console.log(`RidePassengers deleted:    ${ridePassengersDeleted.count}`);

  // 2. Delete Ride
  const ridesDeleted = await prisma.ride.deleteMany({});
  console.log(`Rides deleted:             ${ridesDeleted.count}`);

  // 3. Delete WeeklySchedule
  const weeklySchedulesDeleted =
    await prisma.weeklySchedule.deleteMany({});
  console.log(
    `WeeklySchedules deleted:   ${weeklySchedulesDeleted.count}`,
  );

  // 4. Delete Trip
  const tripsDeleted = await prisma.trip.deleteMany({});
  console.log(`Trips deleted:              ${tripsDeleted.count}`);

  // 5. Delete Route
  const routesDeleted = await prisma.route.deleteMany({});
  console.log(`Routes deleted:             ${routesDeleted.count}`);

  console.log("\nAll requested data deleted successfully.");
}

async function main() {
  try {
    await deleteRidesRoutesAndSchedules();
  } catch (err) {
    console.error("\nDelete failed:");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();