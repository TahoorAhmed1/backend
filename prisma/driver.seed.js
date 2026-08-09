/**
 * prisma/seed.js
 *
 * Seeds Vendor / Driver / Vehicle from prisma/seed-data.json, which was
 * generated from "Driver & Vehicle Reg Details.xlsx" (4 vendor sheets:
 * UTS, MTS, BusCaro, CTS).
 *
 * WHY A SEPARATE DATA FILE INSTEAD OF INLINING IT HERE:
 * the source spreadsheet needed a fair amount of cleanup before it was
 * safe to write to the DB (duplicate plate numbers across vendor sheets,
 * duplicate driver identities under different name spellings, junk CNIC
 * placeholder text like "on waiting", a phone-shaped value that was
 * actually a shift-type label, etc.) — see the "Known data caveats"
 * section below for what was decided and why. Keeping the already-cleaned
 * data in JSON keeps this script itself simple and re-runnable.
 *
 * ----------------------------------------------------------------------
 * HOW TO RUN
 * ----------------------------------------------------------------------
 * 1. Put this file at prisma/seed.js and seed-data.json at
 *    prisma/seed-data.json (same folder as your schema.prisma).
 * 2. Add to package.json:
 *      "prisma": { "seed": "node prisma/seed.js" }
 * 3. Run:
 *      npx prisma db seed
 *    (or just `node prisma/seed.js` directly)
 *
 * ----------------------------------------------------------------------
 * IDEMPOTENCY (safe to re-run) — and the bug this fixed
 * ----------------------------------------------------------------------
 * - Vendor: upserted by `name` (unique in schema).
 * - Vehicle: upserted by `vehicleNumber` (unique in schema).
 * - Driver: has NO unique, always-present field in this data — many rows
 *   have no CNIC. An earlier version of this script matched no-CNIC
 *   drivers by (name + vendor) as a re-run safety net — but 42 name+
 *   vendor combos in this data (e.g. two different people both named
 *   "Bilal" under UTS, one per vehicle) share that key while being
 *   genuinely different people. That fallback was collapsing them onto
 *   the SAME DB row **within a single run** — the first "Bilal" gets
 *   created, then the second "Bilal" a few rows later matches that same
 *   row instead of creating a new one — so two different vehicles then
 *   fought over one driverId and the second vehicle.create() threw
 *   `Unique constraint failed on the fields: (driverId)`.
 *
 *   Fixed by not matching on name/vendor at all. Every driver in
 *   seed-data.json already has a stable, unique `seedId` (that's exactly
 *   what it's for) — so instead each no-CNIC driver is tagged with
 *   `[seedId:dXXXX]` in its `notes` field, and re-runs match on that
 *   exact tag instead of on name+vendor. That guarantees a strict 1:1
 *   mapping no matter how many real people happen to share a name.
 *
 * ----------------------------------------------------------------------
 * KNOWN DATA CAVEATS — decisions already baked into seed-data.json
 * ----------------------------------------------------------------------
 * 1. 17 plate numbers appeared under more than one vendor sheet (e.g. a
 *    vehicle reassigned from one vendor to another). Per your call: the
 *    LAST vendor sheet it appears in (processing order UTS → MTS →
 *    BusCaro → CTS) is treated as the current, authoritative owner.
 * 2. ~66 first names (e.g. "Waqar", "Imran") appear under multiple
 *    vendors. Per your call: only merged into one Driver record when a
 *    phone number or CNIC actually matched across the rows; otherwise
 *    kept as separate people even though they share a first name.
 * 3. A few rows had the SAME real CNIC under two differently-spelled
 *    names (e.g. "Shoaib" vs "Shoaib shujauddin") — these were merged
 *    (CNIC is the more reliable identity signal), and the alternate
 *    spelling is recorded in that driver's `notes`.
 * 4. CNIC values that were placeholder text ("on waiting") or otherwise
 *    didn't look like a real 13-digit CNIC were dropped (left null)
 *    rather than risk a bogus unique-constraint value.
 * 5. 14 drivers had no vehicle registration at all in their row — they're
 *    seeded as Drivers with no paired Vehicle. Your existing
 *    findOrCreateDefaultVehicleForDriver fallback (in
 *    weeklySchedule_controller.js) will give them a placeholder vehicle
 *    automatically the first time they show up in a weekly schedule
 *    upload.
 * 6. 10 vehicles had no recognizable type in the sheet; defaulted to VAN
 *    with a note on the record flagging it for manual review.
 * Full per-row detail for all of the above is in seed-data.json's
 * driver/vehicle `notes` fields, and in the `issues` array printed by the
 * parser (ask if you want that full list re-surfaced).
 */

require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "driver-data.json");

async function main() {
  const { vendors, drivers, vehicles } = JSON.parse(
    fs.readFileSync(DATA_PATH, "utf8"),
  );

  console.log(
    `Seeding ${vendors.length} vendors, ${drivers.length} drivers, ${vehicles.length} vehicles...`,
  );

  // ---------- 1. Vendors ----------
  const vendorIdByName = new Map();
  for (const v of vendors) {
    const vendor = await prisma.vendor.upsert({
      where: { name: v.name },
      update: {},
      create: { name: v.name },
    });
    vendorIdByName.set(v.name, vendor.id);
  }
  console.log(`  Vendors ready: ${vendorIdByName.size}`);

  // ---------- 2. Drivers ----------
  // seedId (from seed-data.json) -> real DB id, so step 3 can pair
  // Vehicle.driverId correctly regardless of upsert vs. create path.
  const driverIdBySeedId = new Map();
  let driversCreated = 0;
  let driversMatched = 0;

  for (const d of drivers) {
    const vendorId = d.vendor ? vendorIdByName.get(d.vendor) : undefined;
    // Unique tag embedded in notes so no-CNIC drivers can be matched
    // EXACTLY on re-run, instead of via a fuzzy name+vendor lookup that
    // would wrongly conflate different real people who share a name
    // (see the file header comment for the bug this replaced).
    const seedTag = `[seedId:${d.seedId}]`;
    const notes = d.notes ? `${d.notes} ${seedTag}` : seedTag;
    const data = {
      name: d.name,
      phone: d.phone || undefined,
      licenseNumber: d.licenseNumber || undefined,
      cnic: d.cnic || undefined,
      vendorId: vendorId || undefined,
      status: d.status || "AVAILABLE",
      notes,
    };

    let driver;
    if (d.cnic) {
      // cnic is @unique — safe to upsert directly on it.
      driver = await prisma.driver.upsert({
        where: { cnic: d.cnic },
        update: data,
        create: data,
      });
    } else {
      // No CNIC on this row — match ONLY on this driver's own seed tag,
      // never on name/vendor (see header comment).
      const existing = await prisma.driver.findFirst({
        where: { notes: { contains: seedTag } },
      });
      if (existing) {
        driver = await prisma.driver.update({ where: { id: existing.id }, data });
        driversMatched++;
      } else {
        driver = await prisma.driver.create({ data });
        driversCreated++;
      }
    }
    driverIdBySeedId.set(d.seedId, driver.id);
  }
  console.log(
    `  Drivers ready: ${driverIdBySeedId.size} (created/updated via upsert or matched by name+vendor)`,
  );

  // ---------- 3. Vehicles (+ pair each to its primary driver) ----------
  let vehiclesCreated = 0;
  let vehiclesUpdated = 0;

  for (const v of vehicles) {
    const vendorId = v.vendor ? vendorIdByName.get(v.vendor) : undefined;
    const driverId = v.primaryDriverSeedId
      ? driverIdBySeedId.get(v.primaryDriverSeedId)
      : undefined;

    const data = {
      type: v.type,
      make: v.make || undefined,
      model: v.model || undefined,
      capacity: v.capacity,
      status: v.status || "ACTIVE",
      vendorId: vendorId || undefined,
      driverId: driverId || undefined,
      notes: v.notes || undefined,
    };

    const existing = await prisma.vehicle.findUnique({
      where: { vehicleNumber: v.vehicleNumber },
    });
    if (existing) {
      await prisma.vehicle.update({ where: { id: existing.id }, data });
      vehiclesUpdated++;
    } else {
      await prisma.vehicle.create({ data: { vehicleNumber: v.vehicleNumber, ...data } });
      vehiclesCreated++;
    }
  }
  console.log(
    `  Vehicles ready: ${vehiclesCreated} created, ${vehiclesUpdated} updated`,
  );

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });