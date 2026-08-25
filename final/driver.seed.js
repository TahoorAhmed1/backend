require("dotenv/config");
const { PrismaClient, Prisma } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { hashPassword } = require("../services/auth.service");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ============================================================
// CONFIG
// ============================================================
// data.json already has real ids and fully-resolved FKs (vendorId,
// driverId) plus already-mapped enum values — no name/seedId lookups,
// no fuzzy shift/status mapping needed here.
const DATA_PATH = path.join(__dirname, "driver.data.json");
const QR_DIR = path.join(__dirname, "..", "qrcodes", "drivers");
const DRIVER_EMAIL_DOMAIN = "ibex.com";
const DEFAULT_DRIVER_PASSWORD = "12345678";

const q = (name) => `"${name}"`;

/**
 * Bulk INSERT ... ON CONFLICT (id) DO UPDATE in a single round trip.
 * Every row already carries its final `id`, so upserting on the primary
 * key keeps re-runs of the seed idempotent against the same JSON.
 *
 * createdAt/updatedAt are NOT NULL with no DB-level default on these
 * tables (only Prisma Client sets them, and this is a raw query) — so
 * they're always supplied explicitly here: now() on insert for both,
 * and updatedAt refreshed to now() again on conflict. createdAt is
 * intentionally left out of the UPDATE SET so it never gets clobbered
 * on an existing row.
 *
 * IMPORTANT: ON CONFLICT (id) ONLY protects against `id` collisions.
 * If the table has OTHER @unique columns (e.g. Driver.name/phone/
 * licenseNumber/cnic, Vehicle.vehicleNumber/driverId), a collision on
 * one of those — either within the batch itself, or against a
 * DIFFERENT id already in the DB — is NOT caught by this ON CONFLICT
 * clause. Postgres will throw 23505 and the raw multi-row INSERT fails
 * as a whole. Callers with such columns must either de-dupe the batch
 * before calling this (see dedupeUniqueField / dedupeVehicleNumber),
 * or wrap the call in a safe per-row fallback (see
 * bulkUpsertDriversSafely / bulkUpsertVehiclesSafely) so one bad row
 * can't take down the entire batch.
 */
async function bulkUpsert(table, columns, rows, { conflictCol = "id", touchUpdatedAt = true } = {}) {
  if (!rows.length) return;

  const insertCols = [...columns, "createdAt", "updatedAt"];
  const updateCols = columns.filter((c) => c !== conflictCol);

  const colList = Prisma.raw(insertCols.map(q).join(", "));
  const valuesSql = Prisma.join(
    rows.map(
      (r) =>
        Prisma.sql`(${Prisma.join([
          ...columns.map((c) => r[c] ?? null),
          Prisma.raw("now()"),
          Prisma.raw("now()"),
        ])})`,
    ),
  );

  const setParts = updateCols.map((c) => Prisma.sql`${Prisma.raw(q(c))} = EXCLUDED.${Prisma.raw(q(c))}`);
  if (touchUpdatedAt) setParts.push(Prisma.sql`${Prisma.raw(q("updatedAt"))} = now()`);

  const query = Prisma.sql`INSERT INTO ${Prisma.raw(q(table))} (${colList}) VALUES ${valuesSql}
      ON CONFLICT (${Prisma.raw(q(conflictCol))}) DO UPDATE SET ${Prisma.join(setParts)}`;

  await prisma.$executeRaw(query);
}

// ============================================================
// ENUM NORMALIZATION
// ============================================================
const VALID_VEHICLE_TYPES = new Set(["CAR", "VAN", "HIJET", "KARVAN", "BUS"]);
function normalizeVehicleType(rawType) {
  if (!rawType) return null;
  const upper = String(rawType).trim().toUpperCase().replace(/\s+/g, "");
  return VALID_VEHICLE_TYPES.has(upper) ? upper : null;
}

const VALID_VEHICLE_STATUSES = new Set(["ACTIVE", "INACTIVE", "MAINTENANCE", "BREAKDOWN"]);
function normalizeVehicleStatus(raw) {
  if (!raw) return "ACTIVE";
  const upper = String(raw).trim().toUpperCase();
  return VALID_VEHICLE_STATUSES.has(upper) ? upper : "ACTIVE";
}

const VALID_DRIVER_STATUSES = new Set(["AVAILABLE", "ON_RIDE", "OFFLINE", "INACTIVE"]);
function normalizeDriverStatus(raw) {
  if (!raw) return "AVAILABLE";
  const upper = String(raw).trim().toUpperCase();
  return VALID_DRIVER_STATUSES.has(upper) ? upper : "AVAILABLE";
}

const VALID_SHIFT_TYPES = new Set(["TWELVE_HOUR", "TWENTY_FOUR_HOUR", "SINGLE_SHIFT", "FIXED_SHIFT"]);
function normalizeShiftType(raw) {
  if (!raw) return "TWELVE_HOUR";
  const upper = String(raw).trim().toUpperCase();
  return VALID_SHIFT_TYPES.has(upper) ? upper : "TWELVE_HOUR";
}

const VALID_ENTITIES = new Set(["IBEX", "VW"]);
function normalizeEntity(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  return VALID_ENTITIES.has(upper) ? upper : null;
}

function safeFileName(name) {
  return String(name || "driver").replace(/\s+/g, "").replace(/[\\/:*?"<>|]/g, "");
}

/**
 * name/phone/licenseNumber/cnic are all @unique on Driver — a single
 * multi-row INSERT hard-fails if the batch itself has two rows sharing
 * any of these values, regardless of the ON CONFLICT target (that only
 * protects against `id` collisions). De-dupe within the batch first.
 * `name` is required+unique, so a clash gets disambiguated with a
 * suffix rather than dropped; the optional fields just get cleared on
 * the later occurrence.
 */
function dedupeUniqueField(rows, field, { allowNull }) {
  const seen = new Map();
  for (const row of rows) {
    const val = row[field];
    if (val == null) continue;
    if (!seen.has(val)) {
      seen.set(val, row);
      continue;
    }
    if (allowNull) {
      console.warn(
        `  ⚠️ Duplicate ${field} "${val}" on driver ${row.id} (${row.name}) — clearing it (Driver.${field} is @unique).`,
      );
      row[field] = null;
    } else {
      let suffix = 2;
      let candidate = `${val} (${suffix})`;
      while (seen.has(candidate)) {
        suffix++;
        candidate = `${val} (${suffix})`;
      }
      console.warn(
        `  ⚠️ Duplicate ${field} "${val}" on driver ${row.id} — renamed to "${candidate}" (Driver.${field} is @unique). Fix the source data when you get a chance.`,
      );
      row[field] = candidate;
      seen.set(candidate, row);
    }
  }
}

/**
 * Vehicle.vehicleNumber is @unique and required (not nullable), so it
 * gets the same treatment as Driver.name above: a clash within the
 * batch gets disambiguated with a "(2)" style suffix rather than
 * dropped or nulled, and logged loudly so the source data can be
 * fixed at the origin. This is what was MISSING before and caused
 * the whole 33-row Vehicle insert to fail on one duplicate
 * "SA-6543" row.
 */
function dedupeVehicleNumber(rows) {
  const seen = new Map();
  let dupCount = 0;
  for (const row of rows) {
    const val = row.vehicleNumber;
    if (val == null) continue;
    if (!seen.has(val)) {
      seen.set(val, row);
      continue;
    }
    dupCount++;
    let suffix = 2;
    let candidate = `${val} (${suffix})`;
    while (seen.has(candidate)) {
      suffix++;
      candidate = `${val} (${suffix})`;
    }
    console.warn(
      `  ⚠️ Duplicate vehicleNumber "${val}" on vehicle ${row.id} — renamed to "${candidate}" (Vehicle.vehicleNumber is @unique). Fix the source data when you get a chance.`,
    );
    row.vehicleNumber = candidate;
    seen.set(candidate, row);
  }
  return dupCount;
}

async function mapLimit(items, limit, iteratorFn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await iteratorFn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

const SEED_CONCURRENCY = Number(process.env.SEED_CONCURRENCY) || 8;

const DRIVER_COLUMNS = ["id", "name", "phone", "licenseNumber", "cnic", "vendorId", "shiftType", "shiftLabel", "status"];

const VEHICLE_COLUMNS = [
  "id",
  "vehicleNumber",
  "type",
  "make",
  "model",
  "year",
  "capacity",
  "vendorId",
  "status",
  "vehicleEntity",
  "driverId",
];

/**
 * Fast path: one bulk upsert for all drivers. name/phone/licenseNumber/cnic
 * are @unique, so this only fails if a row collides with a DIFFERENT id
 * already sitting in the DB (in-batch collisions were already cleaned up
 * by dedupeUniqueField). That's rare enough not to slow down every normal
 * run — so on failure we fall back to a per-row upsert that can catch and
 * report exactly which row and which field conflicted, instead of losing
 * the whole batch to one bad row.
 */
async function bulkUpsertDriversSafely(driverRows) {
  try {
    await bulkUpsert("Driver", DRIVER_COLUMNS, driverRows);
    return { mode: "bulk", ok: driverRows.length, failed: 0 };
  } catch (err) {
    console.warn(
      `  ⚠️ Bulk driver upsert hit a conflict (${err.message}). Falling back to per-row upserts to isolate it...`,
    );
    let ok = 0;
    let failed = 0;
    await mapLimit(driverRows, SEED_CONCURRENCY, async (row) => {
      try {
        await prisma.driver.upsert({
          where: { id: row.id },
          update: {
            name: row.name,
            phone: row.phone,
            licenseNumber: row.licenseNumber,
            cnic: row.cnic,
            vendorId: row.vendorId,
            shiftType: row.shiftType,
            shiftLabel: row.shiftLabel,
            status: row.status,
          },
          create: row,
        });
        ok++;
      } catch (rowErr) {
        failed++;
        console.error(`  ✗ Driver ${row.id} (${row.name}) failed: ${rowErr.message}`);
      }
    });
    console.log(`  Per-row fallback: ${ok} upserted, ${failed} failed (see above).`);
    return { mode: "per-row", ok, failed };
  }
}

/**
 * Same fast-path/fallback pattern as bulkUpsertDriversSafely, mirrored
 * for Vehicle. vehicleNumber and driverId are both @unique on Vehicle;
 * in-batch collisions are handled upstream (dedupeVehicleNumber /
 * claimedDriverIds in main()), so this fallback exists specifically to
 * catch — and clearly log — a row colliding against a DIFFERENT id
 * already present in the DB, without losing the rest of the batch.
 */
async function bulkUpsertVehiclesSafely(vehicleRows) {
  try {
    await bulkUpsert("Vehicle", VEHICLE_COLUMNS, vehicleRows);
    return { mode: "bulk", ok: vehicleRows.length, failed: 0 };
  } catch (err) {
    console.warn(
      `  ⚠️ Bulk vehicle upsert hit a conflict (${err.message}). Falling back to per-row upserts to isolate it...`,
    );
    let ok = 0;
    let failed = 0;
    await mapLimit(vehicleRows, SEED_CONCURRENCY, async (row) => {
      try {
        await prisma.vehicle.upsert({
          where: { id: row.id },
          update: {
            vehicleNumber: row.vehicleNumber,
            type: row.type,
            make: row.make,
            model: row.model,
            year: row.year,
            capacity: row.capacity,
            vendorId: row.vendorId,
            status: row.status,
            vehicleEntity: row.vehicleEntity,
            driverId: row.driverId,
          },
          create: row,
        });
        ok++;
      } catch (rowErr) {
        failed++;
        console.error(`  ✗ Vehicle ${row.id} (${row.vehicleNumber}) failed: ${rowErr.message}`);
      }
    });
    console.log(`  Per-row fallback: ${ok} upserted, ${failed} failed (see above).`);
    return { mode: "per-row", ok, failed };
  }
}

async function main() {
  const { vendors, drivers, vehicles } = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  console.log(
    `Seeding ${vendors.length} vendors, ${drivers.length} drivers, ${vehicles.length} vehicles...`,
  );

  // ---------- 1. Vendors ----------
  await bulkUpsert("Vendor", ["id", "name"], vendors);
  console.log(`  Vendors ready: ${vendors.length}`);

  // ---------- 2. Drivers ----------
  // vendorId/shiftType/status are already resolved/mapped in the JSON —
  // just validate the enum values and bulk upsert on id.
  const driverRows = drivers.map((d) => ({
    id: d.id,
    name: d.name,
    phone: d.phone || null,
    licenseNumber: d.licenseNumber || null,
    cnic: d.cnic || null,
    vendorId: d.vendorId || null,
    shiftType: normalizeShiftType(d.shiftType),
    shiftLabel: d.shiftLabel || null,
    status: normalizeDriverStatus(d.status),
  }));

  // Driver.name/phone/licenseNumber/cnic are all @unique — clean up
  // in-batch collisions before we try a bulk insert (see dedupeUniqueField).
  dedupeUniqueField(driverRows, "licenseNumber", { allowNull: true });
  dedupeUniqueField(driverRows, "cnic", { allowNull: true });

  const driverResult = await bulkUpsertDriversSafely(driverRows);
  console.log(
    `  Drivers ready: ${driverRows.length} (${driverResult.mode}${
      driverResult.mode === "per-row" ? `, ${driverResult.ok} ok / ${driverResult.failed} failed` : ""
    })`,
  );

  // ---------- 3. Vehicles ----------
  // Vehicle.driverId is @unique — if the source data ever has the same
  // driverId on two vehicles, only the first one keeps it.
  const claimedDriverIds = new Set();
  let droppedDuplicateDriverLinks = 0;
  let skippedUnrecognisedType = 0;
  const vehicleRows = vehicles
    .map((v) => {
      let driverId = v.driverId || null;
      if (driverId) {
        if (claimedDriverIds.has(driverId)) {
          droppedDuplicateDriverLinks++;
          console.warn(
            `  ⚠️ Vehicle ${v.vehicleNumber}: driverId ${driverId} already assigned to another vehicle in this batch — leaving unassigned.`,
          );
          driverId = null;
        } else {
          claimedDriverIds.add(driverId);
        }
      }

      const type = normalizeVehicleType(v.type);
      if (!type) {
        skippedUnrecognisedType++;
        console.warn(`  ⚠️ Vehicle ${v.vehicleNumber} has unrecognised type "${v.type}" — skipping row.`);
        return null;
      }

      return {
        id: v.id,
        vehicleNumber: v.vehicleNumber,
        type,
        make: v.make || null,
        model: v.model || null,
        year: v.year != null ? String(v.year) : null,
        capacity: v.capacity ?? 1,
        vendorId: v.vendorId || null,
        status: normalizeVehicleStatus(v.status),
        vehicleEntity: normalizeEntity(v.entityName ?? v.entity),
        driverId,
      };
    })
    .filter(Boolean);

  // Vehicle.vehicleNumber is @unique and required — clean up in-batch
  // collisions before we try a bulk insert (see dedupeVehicleNumber).
  // This is what was missing and caused Vehicle_vehicleNumber_key to
  // fail the whole batch on the "SA-6543" duplicate.
  const dupeVehicleNumbers = dedupeVehicleNumber(vehicleRows);

  const vehicleResult = await bulkUpsertVehiclesSafely(vehicleRows);
  console.log(
    `  Vehicles ready: ${vehicleRows.length} (${vehicleResult.mode}${
      vehicleResult.mode === "per-row" ? `, ${vehicleResult.ok} ok / ${vehicleResult.failed} failed` : ""
    })`,
  );
  if (skippedUnrecognisedType) {
    console.log(`  ⚠ ${skippedUnrecognisedType} vehicle(s) skipped: unrecognised type.`);
  }
  if (droppedDuplicateDriverLinks) {
    console.log(`  ⚠ ${droppedDuplicateDriverLinks} vehicle(s) had a duplicate driverId, left unassigned.`);
  }
  if (dupeVehicleNumbers) {
    console.log(`  ⚠ ${dupeVehicleNumbers} vehicle(s) had a duplicate vehicleNumber, renamed with a suffix.`);
  }

  // ---------- 4. Logins + QR codes for drivers that don't have one ----------
  fs.mkdirSync(QR_DIR, { recursive: true });

  const withoutUser = await prisma.driver.findMany({
    where: { userId: null, id: { in: driverRows.map((d) => d.id) } },
    select: { id: true, name: true, cnic: true },
  });

  if (withoutUser.length === 0) {
    console.log("  Logins ready: all drivers already had one");
  } else {
    const passwordHash = await hashPassword(DEFAULT_DRIVER_PASSWORD);
    let usersCreated = 0;
    let qrGenerated = 0;
    let loginsFailed = 0;

    await mapLimit(withoutUser, SEED_CONCURRENCY, async (driver) => {
      // Stable, unique local-part: cnic digits if we have one, else the
      // driver's own id (always present and always unique).
      const localPart = driver.cnic ? driver.cnic.replace(/[^0-9]/g, "") : driver.id;
      const email = `${localPart}@${DRIVER_EMAIL_DOMAIN}`;
      const qrToken = crypto.randomUUID();

      try {
        const user = await prisma.user.upsert({
          where: { email },
          update: {},
          create: {
            email,
            name: driver.name,
            passwordHash,
            role: "DRIVER",
            qrCode: qrToken,
          },
        });

        await prisma.driver.update({ where: { id: driver.id }, data: { userId: user.id } });
        usersCreated++;

        if (user.qrCode) {
          const qrPath = path.join(QR_DIR, `${safeFileName(driver.name)}-${driver.id}.png`);
          if (!fs.existsSync(qrPath)) {
            await QRCode.toFile(qrPath, user.qrCode, { width: 400, margin: 2, errorCorrectionLevel: "M" });
            qrGenerated++;
          }
        }
      } catch (err) {
        loginsFailed++;
        console.error(`  ✗ Login setup failed for driver ${driver.id} (${email}):`, err.message);
      }
    });

    console.log(
      `  Logins ready: ${usersCreated} created, QR images: ${qrGenerated} generated${
        loginsFailed ? `, ${loginsFailed} failed` : ""
      }`,
    );
  }

  console.log("Seed complete.");
  console.log(
    `Summary — vendors: ${vendors.length}, drivers: ${driverRows.length} (${driverResult.ok} ok${
      driverResult.failed ? `, ${driverResult.failed} failed` : ""
    }), vehicles: ${vehicleRows.length} (${vehicleResult.ok} ok${
      vehicleResult.failed ? `, ${vehicleResult.failed} failed` : ""
    })`,
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });