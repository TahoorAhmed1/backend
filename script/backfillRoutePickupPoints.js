
const { prisma } = require("../lib/prisma");
const { geocodeLocation } = require("../utils/geocode");
const { lookupNameFor } = require("../utils/routePickupPoint");
// ───────────────────────────────────────────────────────────────────────────────

const dry = process.argv.includes("--dry");

(async () => {
  const routes = await prisma.route.findMany({
    where: { pickupLatitude: null, pickupLongitude: null },
    select: {
      id: true, routeCode: true, routeName: true, pickupPointName: true,
      area: { select: { name: true } },
    },
    orderBy: { routeCode: "asc" },
  });

  console.log(`${routes.length} route(s) without a pickup point${dry ? " (dry run)" : ""}\n`);

  let ok = 0;
  const failed = [];

  for (const r of routes) {
    const name = lookupNameFor(r); // "Karsaz - 9AM-6PM - IBT_1" -> "Karsaz"
    const hit = await geocodeLocation(name); // throttled to Nominatim's 1 req/sec
    if (!hit) {
      failed.push({ code: r.routeCode, name });
      console.log(`  ✗ ${r.routeCode}  "${name}"  not found`);
      continue;
    }
    console.log(
      `  ✓ ${r.routeCode}  "${name}"  ${hit.latitude.toFixed(5)}, ${hit.longitude.toFixed(5)}  [${hit.provider}]`,
    );
    if (!dry) {
      await prisma.route.updateMany({
        where: { id: r.id, pickupLatitude: null, pickupLongitude: null },
        data: {
          pickupPointName: name,
          pickupLatitude: hit.latitude,
          pickupLongitude: hit.longitude,
          pickupPointGeocoded: true,
        },
      });
    }
    ok += 1;
  }

  console.log(`\nResolved ${ok}/${routes.length}.`);
  if (failed.length) {
    console.log("Set these manually (name could not be found):");
    failed.forEach((f) => console.log(`  - ${f.code}  "${f.name}"`));
  }
})()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());