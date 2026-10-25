const { prisma } = require("../lib/prisma");

const officeLocations = [
  {
    name: "IBT_1",
    location: "Karachi",
    latitude: 24.859351352853416,
    longitude: 67.05392157823195,
  },
  {
    name: "IBT_2",
    location: "Karachi",
    latitude: 24.795615564679288,
    longitude: 67.05022958268682,
  },
  {
    name: "IBT_3",
    location: "Karachi",
    latitude: 24.87318134714967,
    longitude: 67.09875204904888,
  },
  {
    name: "SKY_TOWER",
    location: "Karachi",
    latitude: 24.801396635103576,
    longitude: 67.03110809797646,
  },
];

async function main() {
  for (const office of officeLocations) {
    const savedOffice = await prisma.office.upsert({
      where: { name: office.name },
      update: {
        location: office.location,
        latitude: office.latitude,
        longitude: office.longitude,
      },
      create: office,
    });

    await prisma.route.updateMany({
      where: { officeLocation: office.name, officeId: null },
      data: { officeId: savedOffice.id },
    });

    await prisma.employee.updateMany({
      where: { officeLocation: office.name, officeId: null },
      data: { officeId: savedOffice.id },
    });
  }

  console.log(`Seeded ${officeLocations.length} office locations.`);
}

main()
  .catch((error) => {
    console.error("Failed to seed office locations:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
