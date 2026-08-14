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
 * 3. Install the QR package (see step 5 below):
 *      npm install qrcode
 * 4. Run:
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
 *
 * ----------------------------------------------------------------------
 * 5. DRIVER LOGINS + ATTENDANCE QR CODES (new)
 * ----------------------------------------------------------------------
 * Package: `qrcode` (npm install qrcode) — generates the PNG badge
 * images. Standard, actively maintained, zero native deps.
 *
 * Every driver now gets:
 *   - A User row (role: DRIVER) if it doesn't have one yet, following
 *     the same pattern as employee_seed.js: email `<seedId>@drivers.ibex.com`,
 *     a shared default password (hashed once, not per-row), linked via
 *     Driver.userId.
 *     NOTE: kept on a separate email subdomain (drivers.ibex.com, not
 *     ibex.com) so a driver's seedId can never collide with an
 *     employee's employeeCode in the User.email unique constraint.
 *   - A `qrCode` token on that User: crypto.randomUUID() — unguessable,
 *     globally unique, satisfies User.qrCode's @unique constraint.
 *   - A PNG badge image rendered to
 *     prisma/qrcodes/drivers/<seedId>.png, encoding that same token,
 *     for printing physical ID/attendance badges. The DB only ever
 *     stores the token string — never image bytes.
 *
 * Idempotent: a driver that already has a User + qrCode is left alone
 * (token never changes across re-runs, which matters since printed
 * badges would otherwise go stale). The PNG is always re-rendered
 * though, since that's cheap and keeps the file in sync if you ever
 * change QR styling (size/margin/error-correction level).
 *
 * IMPORTANT CAVEAT: Attendance.employeeId is what your Attendance model
 * actually tracks — there is no Attendance.driverId. If the real-world
 * flow is "driver scans the employee's badge to mark them present",
 * the QR code that matters for attendance needs to live on the
 * EMPLOYEE's User, not the driver's. This block only covers drivers
 * (badge/ID + optional driver-side login QR) — ask if you also want
 * the equivalent added to employee_seed.js.
 */

require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { hashPassword } = require('../services/auth.service')
const QRCode = require('qrcode')
const crypto = require('crypto')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "driver-data.json");
const QR_DIR = path.join(__dirname, "qrcodes", "drivers");

const DRIVER_EMAIL_DOMAIN = "drivers.ibex.com";
const DEFAULT_DRIVER_PASSWORD = "12345678";

// Turns "Asif Jamil Ahmed" into "asif.jamil.ahmed" — lowercase,
// spaces/repeated whitespace collapsed to single dots, anything that
// isn't a letter/digit/dot stripped so the result is always a valid
// email local-part.
function slugifyName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9.]/g, "");
}

// Turns a driver name into a safe filename: spaces removed, and any
// character that's illegal in Windows/macOS/Linux filenames (notably
// backslash/slash, which some raw names in this data contain, e.g.
// "Ali \ Sameer") stripped out too.
function safeFileName(name) {
  return name
    .replace(/\s+/g, "")
    .replace(/[\\/:*?"<>|]/g, "");
}

async function main() {
  const { vendors, drivers, vehicles } = JSON.parse(
    fs.readFileSync(DATA_PATH, "utf8"),
  );

  console.log(
    `Seeding ${vendors.length} vendors, ${drivers.length} drivers, ${vehicles.length} vehicles...`,
  );

  fs.mkdirSync(QR_DIR, { recursive: true });

  // ---------- 1. Vendors ----------
  // Skipped — only Driver (+ login/QR) is being (re)seeded this run.
  // Kept as an empty Map so the Driver loop below still resolves
  // vendorId to undefined instead of throwing, on the assumption Vendor
  // already exists in the DB from a prior run.
  const vendorIdByName = new Map();
  // for (const v of vendors) {
  //   const vendor = await prisma.vendor.upsert({
  //     where: { name: v.name },
  //     update: {},
  //     create: { name: v.name },
  //   });
  //   vendorIdByName.set(v.name, vendor.id);
  // }
  // console.log(`  Vendors ready: ${vendorIdByName.size}`);

  // ---------- 2. Drivers ----------
  // seedId (from seed-data.json) -> real DB id, so step 3 can pair
  // Vehicle.driverId correctly regardless of upsert vs. create path.
  const driverIdBySeedId = new Map();
  let driversCreated = 0;
  let driversMatched = 0;

  // Hashed once up front: every generated driver login shares the same
  // plaintext starting password, so there's no reason to hash it per row.
  const defaultDriverPasswordHash = await hashPassword(DEFAULT_DRIVER_PASSWORD);

  let usersCreated = 0;
  let usersSkipped = 0;
  let userErrors = 0;
  let qrGenerated = 0;
  const usedFileNames = new Set();

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
        include: { user: true },
      });
    } else {
      // No CNIC on this row — match ONLY on this driver's own seed tag,
      // never on name/vendor (see header comment).
      const existing = await prisma.driver.findFirst({
        where: { notes: { contains: seedTag } },
        include: { user: true },
      });
      if (existing) {
        driver = await prisma.driver.update({
          where: { id: existing.id },
          data,
          include: { user: true },
        });
        driversMatched++;
      } else {
        driver = await prisma.driver.create({ data, include: { user: true } });
        driversCreated++;
      }
    }
    driverIdBySeedId.set(d.seedId, driver.id);

    // ---------- Login + attendance QR code ----------
    // Attach a User (with qrCode token) for any driver that doesn't have
    // one yet — covers both drivers just created above and pre-existing
    // ones seeded before logins/QR codes existed.
    let qrToken = driver.user?.qrCode;

    if (!driver.user) {
      // Name-based email, e.g. "Asif Jamil Ahmed" -> asif.jamil.ahmed@...
      // Per the header comment, ~42 name+vendor combos in this data are
      // DIFFERENT real people sharing a name — colliding them onto the
      // same email would upsert the SAME User row for both, and the
      // second driver.update({ userId }) would then throw (Driver.userId
      // is @unique), leaving that driver without a login. An in-memory
      // "already used this run" Set isn't enough to catch this, since
      // the SAME collision can just as easily happen across separate
      // runs (e.g. one Imran got imran@... last week, a different Imran
      // shows up today with no user yet) — so check the DB directly:
      // only reuse a base email if nobody else already owns it.
      const baseSlug = slugifyName(d.name) || d.seedId;
      let email = `${baseSlug}@${DRIVER_EMAIL_DOMAIN}`;
      const emailOwner = await prisma.user.findUnique({
        where: { email },
        include: { driver: true },
      });
      if (emailOwner && emailOwner.driver && emailOwner.driver.id !== driver.id) {
        // Taken by a genuinely different driver — seedId is unique per
        // driver, so this suffixed form is guaranteed free.
        email = `${baseSlug}.${d.seedId}@${DRIVER_EMAIL_DOMAIN}`;
      }

      qrToken = crypto.randomUUID();

      try {
        const user = await prisma.user.upsert({
          where: { email },
          update: {},
          create: {
            email,
            name: driver.name,
            passwordHash: defaultDriverPasswordHash,
            role: "DRIVER",
            qrCode: qrToken,
          },
        });

        await prisma.driver.update({
          where: { id: driver.id },
          data: { userId: user.id },
        });

        // In case the user row already existed (e.g. re-run after a
        // partial failure) but its qrCode was never set.
        qrToken = user.qrCode || qrToken;

        usersCreated++;
      } catch (err) {
        // Don't let one bad row (e.g. an email collision) abort the
        // whole run — log it and keep going.
        userErrors++;
        qrToken = undefined;
        console.error(
          `  Login setup failed for seedId=${d.seedId} (${email}):`,
          err.message,
        );
      }
    } else if (!driver.user.qrCode) {
      // Backfill: driver already had a User (unlikely today, but possible
      // after future changes) that predates the qrCode column being used.
      qrToken = crypto.randomUUID();
      try {
        await prisma.user.update({
          where: { id: driver.user.id },
          data: { qrCode: qrToken },
        });
        usersSkipped++; // login already existed; only the QR was backfilled
      } catch (err) {
        userErrors++;
        qrToken = undefined;
        console.error(
          `  QR backfill failed for seedId=${d.seedId}:`,
          err.message,
        );
      }
    } else {
      usersSkipped++;
    }

    // Always (re-)render the badge PNG so the file on disk matches
    // whatever token is currently in the DB, even on re-runs.
    if (qrToken) {
      let fileBase = safeFileName(d.name) || d.seedId;
      if (usedFileNames.has(fileBase)) {
        fileBase = `${fileBase}.${d.seedId}`;
      }
      usedFileNames.add(fileBase);
      const qrPath = path.join(QR_DIR, `${fileBase}.png`);
      try {
        await QRCode.toFile(qrPath, qrToken, {
          width: 400,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        qrGenerated++;
      } catch (err) {
        console.error(`  QR image generation failed for seedId=${d.seedId}:`, err.message);
      }
    }
  }

  console.log(
    `  Drivers ready: ${driverIdBySeedId.size} (${driversCreated} created, ${driversMatched} matched by seed tag)`,
  );
  console.log(
    `  Driver logins: ${usersCreated} created, ${usersSkipped} already had one, ${userErrors} failed`,
  );
  console.log(`  QR badges rendered: ${qrGenerated} -> ${QR_DIR}`);

  // ---------- 3. Vehicles (+ pair each to its primary driver) ----------
  // Skipped — only Driver (+ login/QR) is being (re)seeded this run.
  // driverIdBySeedId is still built in step 2 above so this block can be
  // re-enabled later without touching the Driver loop.
  // let vehiclesCreated = 0;
  // let vehiclesUpdated = 0;
  //
  // for (const v of vehicles) {
  //   const vendorId = v.vendor ? vendorIdByName.get(v.vendor) : undefined;
  //   const driverId = v.primaryDriverSeedId
  //     ? driverIdBySeedId.get(v.primaryDriverSeedId)
  //     : undefined;
  //
  //   const data = {
  //     type: v.type,
  //     make: v.make || undefined,
  //     model: v.model || undefined,
  //     capacity: v.capacity,
  //     status: v.status || "ACTIVE",
  //     vendorId: vendorId || undefined,
  //     driverId: driverId || undefined,
  //     notes: v.notes || undefined,
  //   };
  //
  //   const existing = await prisma.vehicle.findUnique({
  //     where: { vehicleNumber: v.vehicleNumber },
  //   });
  //   if (existing) {
  //     await prisma.vehicle.update({ where: { id: existing.id }, data });
  //     vehiclesUpdated++;
  //   } else {
  //     await prisma.vehicle.create({ data: { vehicleNumber: v.vehicleNumber, ...data } });
  //     vehiclesCreated++;
  //   }
  // }
  // console.log(
  //   `  Vehicles ready: ${vehiclesCreated} created, ${vehiclesUpdated} updated`,
  // );

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