require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
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
const DATA_PATH = path.join(__dirname, "driver-data.json");
const QR_DIR = path.join(__dirname, "..", "qrcodes", "drivers");
const DRIVER_EMAIL_DOMAIN = "ibex.com";
const DEFAULT_DRIVER_PASSWORD = "12345678";

// ============================================================
// HELPERS
// ============================================================
function normalize(str) {
  return String(str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLicense(str) {
  return String(str || "").trim().toLowerCase().replace(/\s+/g, "");
}

function getSeedId(driver) {
  return driver?.seedId ? String(driver.seedId).trim() : null;
}

// ============================================================
// COMPARE EXISTING DB DRIVER vs INCOMING SEED DATA
// ============================================================
// Only compares fields we actually have new values for (data has already
// had `undefined` keys stripped, so `field in data` means the seed JSON
// supplied something for that field). Returns an array of human-readable
// diffs; empty array means "no real update needed".
const DRIVER_TRACKED_FIELDS = [
  "name",
  "phone",
  "licenseNumber",
  "vendorId",
  "status",
  "shiftType",
  "shiftLabel",
  "maxDailyHours",
  "maxWeeklyHours",
];

function computeDriverChanges(existing, data) {
  const changes = [];
  for (const field of DRIVER_TRACKED_FIELDS) {
    if (!(field in data)) continue; // seed JSON didn't supply this field
    const oldVal = existing[field] ?? "";
    const newVal = data[field] ?? "";
    if (String(oldVal) !== String(newVal)) {
      changes.push(`${field}: "${oldVal}" -> "${newVal}"`);
    }
  }
  return changes;
}

function safeFileName(name) {
  return String(name || "driver")
    .replace(/\s+/g, "")
    .replace(/[\\/:*?"<>|]/g, "");
}

// ============================================================
// SHIFT TYPE MAPPING (matches Prisma enum DriverShiftType)
// ============================================================
const SHIFT_TYPE_MAP = {
  "24": "TWENTY_FOUR_HOUR",
  "24 HOUR": "TWENTY_FOUR_HOUR",
  "24 HOURS": "TWENTY_FOUR_HOUR",
  "TWENTY_FOUR_HOUR": "TWENTY_FOUR_HOUR",
  "TWENTY FOUR HOUR": "TWENTY_FOUR_HOUR",
  "24 HOUR CAR/VEHICLE": "TWENTY_FOUR_HOUR",
  "24HOUR": "TWENTY_FOUR_HOUR",

  "SHIFT": "SINGLE_SHIFT",
  "SINGLE_SHIFT": "SINGLE_SHIFT",
  "DAY": "SINGLE_SHIFT",
  "DAY SHIFT": "SINGLE_SHIFT",

  "12": "TWELVE_HOUR",
  "12 HOUR": "TWELVE_HOUR",
  "TWELVE_HOUR": "TWELVE_HOUR",
  "TWELVE HOUR": "TWELVE_HOUR",

  "OT": "OVERTIME_SHIFT",
  "OVERTIME_SHIFT": "OVERTIME_SHIFT",
  "OVERTIME": "OVERTIME_SHIFT",

  "FIXED_SHIFT": "FIXED_SHIFT",
  "FIXED": "FIXED_SHIFT",
};

function mapShiftType(rawShift) {
  if (!rawShift) return undefined;
  const normalized = String(rawShift).trim().toUpperCase();

  if (SHIFT_TYPE_MAP[normalized]) {
    return SHIFT_TYPE_MAP[normalized];
  }

  const upper = normalized;
  if (upper.includes("24") || upper.includes("TWENTY FOUR")) {
    return "TWENTY_FOUR_HOUR";
  }
  if (upper.includes("SHIFT") || upper.includes("SINGLE") || upper.includes("DAY")) {
    return "SINGLE_SHIFT";
  }
  if (upper.includes("12") || upper.includes("TWELVE")) {
    return "TWELVE_HOUR";
  }
  if (upper.includes("OT") || upper.includes("OVERTIME")) {
    return "OVERTIME_SHIFT";
  }
  if (upper.includes("FIXED")) {
    return "FIXED_SHIFT";
  }

  console.warn(`  ⚠️ Unrecognized shift type: "${rawShift}" – using default TWELVE_HOUR`);
  return undefined;
}

// ============================================================
// PARSE EXPERIENCE YEARS -> maxDailyHours / maxWeeklyHours
// ============================================================
function parseExperienceToHours(experienceNote) {
  if (!experienceNote) return { maxDailyHours: null, maxWeeklyHours: null };

  const str = String(experienceNote).toLowerCase();
  const yearMatch = str.match(/(\d+)\s*(?:year|yr)/i);
  if (yearMatch) {
    const years = parseInt(yearMatch[1]);
    if (years >= 15) {
      return { maxDailyHours: 12, maxWeeklyHours: 60 };
    } else if (years >= 10) {
      return { maxDailyHours: 10, maxWeeklyHours: 50 };
    } else if (years >= 5) {
      return { maxDailyHours: 8, maxWeeklyHours: 40 };
    } else if (years >= 2) {
      return { maxDailyHours: 6, maxWeeklyHours: 30 };
    }
  }

  return { maxDailyHours: null, maxWeeklyHours: null };
}

// ============================================================
// LICENSE + CNIC — NO SPLITTING, USE RAW VALUES AS RECEIVED
// ============================================================
function splitLicenseAndCnic(rawLicense, existingCnic) {
  // licenseNumber: whatever was received, as-is (no parsing, no '#' splitting -
  // could be a normal license number, a CNIC-shaped string, a plate-style
  // value, anything - just pass it straight through).
  const licenseNumber = rawLicense ? String(rawLicense).trim() : "";
  // cnic: only ever comes from the dedicated cnic field, untouched.
  const cnic = existingCnic || null;
  return { licenseNumber, cnic };
}

// ============================================================
// STATUS MAPPING
// ============================================================
const DRIVER_STATUS_MAP = {
  ACTIVE: "AVAILABLE",
  INACTIVE: "INACTIVE",
  RELEASED: "INACTIVE",
  BLACKLISTED: "INACTIVE",
};

function mapDriverStatus(rawStatus) {
  if (!rawStatus) return "AVAILABLE";
  const normalized = String(rawStatus).trim().toUpperCase();
  const mapped = DRIVER_STATUS_MAP[normalized];
  if (!mapped) {
    console.error(`  Unrecognised driver status "${rawStatus}" – falling back to AVAILABLE.`);
    return "AVAILABLE";
  }
  return mapped;
}

function statusNoteFor(rawStatus, mappedStatus) {
  return rawStatus && rawStatus !== mappedStatus ? `[orig status: ${rawStatus}]` : null;
}

// ============================================================
// VEHICLE STATUS MAPPING
// ============================================================
const VEHICLE_STATUS_MAP = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  RELEASED: "INACTIVE",
  BLACKLISTED: "INACTIVE",
};

function mapVehicleStatus(rawStatus) {
  if (!rawStatus) return "ACTIVE";
  const normalized = String(rawStatus).trim().toUpperCase();
  const mapped = VEHICLE_STATUS_MAP[normalized];
  if (!mapped) {
    console.error(`  Unrecognised vehicle status "${rawStatus}" – falling back to ACTIVE.`);
    return "ACTIVE";
  }
  return mapped;
}

// ============================================================
// VEHICLE TYPE MAPPING
// ============================================================
const VALID_VEHICLE_TYPES = new Set(["CAR", "VAN", "HIJET", "KARVAN", "BUS"]);
function normalizeVehicleType(rawType) {
  if (!rawType) return null;
  const upper = String(rawType).trim().toUpperCase();
  return VALID_VEHICLE_TYPES.has(upper) ? upper : null;
}

const VEHICLE_CAPACITY_DEFAULTS = {
  CAR: 4,
  VAN: 12,
  HIJET: 7,
  KARVAN: 10,
  BUS: 40,
};

function resolveCapacity(rawCapacity, vehicleType) {
  if (typeof rawCapacity === "number" && rawCapacity > 0) {
    return { capacity: rawCapacity, defaulted: false };
  }
  const fallback = VEHICLE_CAPACITY_DEFAULTS[vehicleType] || 1;
  return { capacity: fallback, defaulted: true };
}

// ============================================================
// PRE‑FLIGHT VALIDATION
// ============================================================
const VALID_DRIVER_STATUSES = new Set(Object.keys(DRIVER_STATUS_MAP));

function validateSeedData(vendors, drivers, vehicles) {
  const issues = [];
  const vendorNames = new Set(vendors.map((v) => v.name));

  const seedIdCounts = new Map();
  const cnicCounts = new Map();
  for (const d of drivers) {
    seedIdCounts.set(d.seedId, (seedIdCounts.get(d.seedId) || 0) + 1);
    if (d.cnic) cnicCounts.set(d.cnic, (cnicCounts.get(d.cnic) || 0) + 1);
    if (d.vendor && !vendorNames.has(d.vendor)) {
      issues.push(`Driver ${d.seedId} (${d.name}) has unrecognised vendor "${d.vendor}"`);
    }
    if (d.status && !VALID_DRIVER_STATUSES.has(String(d.status).trim().toUpperCase())) {
      issues.push(`Driver ${d.seedId} (${d.name}) has unmapped status "${d.status}"`);
    }
    // Use the same fuzzy/case-insensitive logic mapShiftType() uses at
    // seed time, not a raw exact-key check - otherwise this flags values
    // (e.g. lowercase) that would actually map fine during processing.
    if (d.shiftTiming && !mapShiftType(d.shiftTiming)) {
      issues.push(`Driver ${d.seedId} (${d.name}) has unmapped shiftTiming "${d.shiftTiming}"`);
    }
  }
  for (const [seedId, count] of seedIdCounts) {
    if (count > 1) issues.push(`Duplicate driver seedId "${seedId}" (${count}x) – later rows skipped`);
  }
  for (const [cnic, count] of cnicCounts) {
    if (count > 1) issues.push(`Duplicate driver cnic "${cnic}" (${count}x) – resolved per-row during seeding`);
  }

  const driverSeedIds = new Set(drivers.map((d) => d.seedId));
  const vehicleNumberCounts = new Map();
  const primaryDriverCounts = new Map();
  for (const v of vehicles) {
    if (!v.vehicleNumber) {
      issues.push(`Vehicle missing vehicleNumber: ${JSON.stringify(v)} – row will be skipped`);
      continue;
    }
    vehicleNumberCounts.set(v.vehicleNumber, (vehicleNumberCounts.get(v.vehicleNumber) || 0) + 1);
    if (v.vendor && !vendorNames.has(v.vendor)) {
      issues.push(`Vehicle ${v.vehicleNumber} has unrecognised vendor "${v.vendor}"`);
    }
    if (v.type && !normalizeVehicleType(v.type)) {
      issues.push(`Vehicle ${v.vehicleNumber} has unmapped type "${v.type}" – row will be skipped`);
    }
    if (v.primaryDriverSeedId) {
      if (!driverSeedIds.has(v.primaryDriverSeedId)) {
        issues.push(
          `Vehicle ${v.vehicleNumber} references unknown primaryDriverSeedId "${v.primaryDriverSeedId}" – will be left unassigned`
        );
      }
      const list = primaryDriverCounts.get(v.primaryDriverSeedId) || [];
      list.push(v.vehicleNumber);
      primaryDriverCounts.set(v.primaryDriverSeedId, list);
    }
  }
  for (const [num, count] of vehicleNumberCounts) {
    if (count > 1) issues.push(`Duplicate vehicleNumber "${num}" (${count}x)`);
  }
  for (const [seedId, plates] of primaryDriverCounts) {
    if (plates.length > 1) {
      issues.push(
        `Driver ${seedId} is primary on ${plates.length} vehicles: ${plates.join(", ")} (Vehicle.driverId is @unique – first one wins, rest left unassigned)`
      );
    }
  }

  // Report, but never abort: every case above is already handled gracefully
  // on its own row during seeding (nulled/skipped/left-unlinked/logged), so
  // hard-stopping the whole batch over a handful of messy rows would only
  // block the hundreds of clean rows along with them.
  if (issues.length > 0) {
    console.warn(`\n⚠ Pre‑flight found ${issues.length} data issue(s) (non-blocking, handled per-row):\n`);
    for (const issue of issues) console.warn(`  - ${issue}`);
    console.warn("");
  } else {
    console.log("✓ Pre‑flight validation passed.");
  }
}

// ============================================================
// CONCURRENCY + PROGRESS / HEARTBEAT
// ============================================================
// Most of the slowness here is network round-trips to Postgres, not CPU -
// so running several items concurrently (instead of one full await chain
// after another) is the single biggest speed win. Order-sensitive loops
// (the JSON de-dup pass, and the vehicle loop's "first vehicle wins"
// primary-driver rule) stay sequential on purpose; everything else is
// safe to parallelize since each item's DB work is independent.
const SEED_CONCURRENCY = Number(process.env.SEED_CONCURRENCY) || 8;

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

// Shared mutable status the heartbeat reads from. Every phase/loop below
// updates this as it goes so the heartbeat always has something current
// to report, even mid-batch.
const progress = { phase: "starting", current: 0, total: 0, startedAt: Date.now() };

function setPhase(phase, total) {
  progress.phase = phase;
  progress.current = 0;
  progress.total = total;
  console.log(`\n▶ ${phase}${total ? ` (0/${total})` : ""}...`);
}

function bumpProgress(step = 1) {
  progress.current += step;
}

const PROGRESS_LOG_EVERY = 25; // print a concrete "still moving" line every N items
function maybeLogItemProgress(label) {
  if (progress.current === progress.total || progress.current % PROGRESS_LOG_EVERY === 0) {
    console.log(`    ...${label} ${progress.current}/${progress.total}`);
  }
}

function startHeartbeat(intervalMs = 15000) {
  return setInterval(() => {
    const elapsedSec = Math.round((Date.now() - progress.startedAt) / 1000);
    console.log(
      `  ⏳ [${elapsedSec}s elapsed] still running - phase: "${progress.phase}" (${progress.current}/${progress.total || "?"})`
    );
  }, intervalMs);
}

async function main() {
  console.log("\n==============================================");
  console.log("   DRIVER USER + QR + VEHICLE SEED (MERGED)");
  console.log("==============================================\n");

  // Heartbeat runs for the whole script so you always get a "still alive"
  // line periodically, even during a long stretch of DB calls, instead of
  // silence that looks like it's stuck.
  const heartbeat = startHeartbeat();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
  }
}

async function run() {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`driver-data.json not found at ${DATA_PATH}`);
  }
  const { vendors, drivers, vehicles } = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  console.log(`JSON: ${vendors.length} vendors, ${drivers.length} drivers, ${vehicles.length} vehicles`);
  console.log(`Concurrency: ${SEED_CONCURRENCY} parallel DB operations (set SEED_CONCURRENCY env var to change)`);

  validateSeedData(vendors, drivers, vehicles);

  fs.mkdirSync(QR_DIR, { recursive: true });

  // ---------- Upsert vendors ----------
  setPhase("Upserting vendors", vendors.length);
  const vendorIdByName = new Map();
  await mapLimit(vendors, SEED_CONCURRENCY, async (v) => {
    const vendor = await prisma.vendor.upsert({
      where: { name: v.name },
      update: {},
      create: { name: v.name },
    });
    vendorIdByName.set(v.name, vendor.id);
    bumpProgress();
    maybeLogItemProgress("vendors");
  });
  console.log(`  Vendors ready: ${vendorIdByName.size}`);

  // ---------- Clean JSON drivers ----------
  // Stays sequential on purpose: duplicate detection depends on processing
  // order (seenCnicMap/seenJsonSeedIds build up as we go).
  setPhase("Cleaning/de-duplicating driver JSON", drivers.length);
  const uniqueDrivers = [];
  const seenJsonSeedIds = new Map();
  const seenCnicMap = new Map();
  let skippedNoSeedId = 0;
  let skippedDuplicateSeedId = 0;
  let noLicenseCount = 0;
  let nulledDuplicateCnic = 0;
  let skippedDuplicateCnic = 0;
  let removedDuplicateDrivers = 0;

  for (const d of drivers) {
    bumpProgress();
    maybeLogItemProgress("driver JSON rows cleaned");
    const seedId = getSeedId(d);
    if (!seedId) {
      skippedNoSeedId++;
      continue;
    }
    const { licenseNumber, cnic: splitCnic } = splitLicenseAndCnic(d.licenseNumber, d.cnic);
    const normalizedLicense = normalizeLicense(licenseNumber);
    if (!normalizedLicense) {
      noLicenseCount++;
      console.warn(
        `  ⚠️ Driver ${seedId} (${d.name}) - no license number on file – seeding without it.`
      );
    }
    if (seenJsonSeedIds.has(seedId)) {
      skippedDuplicateSeedId++;
      continue;
    }

    let cnic = splitCnic;
    if (cnic) {
      const prior = seenCnicMap.get(cnic);
      if (prior) {
        // CNIC alone matching could just be a data-entry coincidence. Only
        // treat this as a genuine duplicate person - and skip entirely -
        // when at least one OTHER field also matches (name/license/phone).
        // Otherwise keep both records, just drop the CNIC from this one.
        const nameMatch = normalize(d.name) === normalize(prior.name);
        const licenseMatch = Boolean(
          normalizedLicense && prior.licenseNormalized && normalizedLicense === prior.licenseNormalized
        );
        const phoneMatch = Boolean(
          d.phone && prior.phone && normalize(d.phone) === normalize(prior.phone)
        );
        const extraMatches = [nameMatch, licenseMatch, phoneMatch].filter(Boolean).length;

        if (extraMatches >= 1) {
          skippedDuplicateCnic++;
          console.warn(
            `  ⚠️ Skipping driver ${seedId} (${d.name}) - duplicate of ${prior.seedId} (${prior.name}): CNIC ${cnic} matches plus ${extraMatches} other field(s) (name:${nameMatch}, license:${licenseMatch}, phone:${phoneMatch})`
          );

          // This may have already been created in an earlier run (before
          // this stricter duplicate rule existed). If so, remove it now.
          const dupSeedTag = `[seedId:${seedId}]`;
          const existingDup = await prisma.driver.findFirst({
            where: { notes: { contains: dupSeedTag } },
          });
          if (existingDup) {
            try {
              await prisma.$transaction(async (tx) => {
                await tx.vehicle.updateMany({
                  where: { driverId: existingDup.id },
                  data: { driverId: null },
                });
                await tx.driver.delete({ where: { id: existingDup.id } });
              });
              removedDuplicateDrivers++;
              console.warn(
                `  🗑️ Removed previously-seeded duplicate driver ${seedId} (${existingDup.name}) from database.`
              );
            } catch (err) {
              console.error(
                `  Failed to remove duplicate driver ${seedId} (${existingDup.name}):`,
                err.message
              );
            }
          }
          continue;
        } else {
          nulledDuplicateCnic++;
          console.warn(
            `  ⚠️ Driver ${seedId} (${d.name}) - duplicate CNIC: ${cnic} (already used by ${prior.seedId}, ${prior.name}) but no other matching fields – seeding without CNIC.`
          );
          cnic = null;
        }
      } else {
        seenCnicMap.set(cnic, {
          seedId,
          name: d.name,
          phone: d.phone,
          licenseNormalized: normalizedLicense,
        });
      }
    }

    d._splitLicense = normalizedLicense ? licenseNumber : null;
    d._splitCnic = cnic;
    seenJsonSeedIds.set(seedId, d);
    uniqueDrivers.push(d);
  }

  console.log(
    `\n  Cleaned JSON drivers: ${uniqueDrivers.length} (${skippedNoSeedId} no‑seedId, ${noLicenseCount} no‑license (kept), ${skippedDuplicateSeedId} dup‑seedId, ${nulledDuplicateCnic} dup‑CNIC nulled, ${skippedDuplicateCnic} dup‑CNIC skipped, ${removedDuplicateDrivers} removed from DB)`
  );

  const defaultPasswordHash = await hashPassword(DEFAULT_DRIVER_PASSWORD);
  const driverIdBySeedId = new Map();

  let driversCreated = 0;
  let driversUpdated = 0;
  let usersCreated = 0;
  let usersLinked = 0;
  let usersSkipped = 0;
  let qrGenerated = 0;
  let vendorWarnings = 0;
  let shiftTypeWarnings = 0;
  let cnicConflictSkipped = 0;

  // ---------- Process drivers ----------
  // Each driver here is fully independent (no shared ordering requirement,
  // unlike the cleaning pass above) so this runs with SEED_CONCURRENCY
  // drivers in flight at once instead of one full await-chain at a time.
  setPhase("Seeding drivers (create/update + user + QR)", uniqueDrivers.length);

  await mapLimit(uniqueDrivers, SEED_CONCURRENCY, async (d) => {
    const seedId = d.seedId;
    const licenseNumber = d._splitLicense;
    const cnic = d._splitCnic;

    // Resolve vendor
    let vendorId;
    if (d.vendor) {
      vendorId = vendorIdByName.get(d.vendor);
      if (!vendorId) {
        vendorWarnings++;
        console.error(`  No vendor "${d.vendor}" for driver ${seedId} – leaving unlinked.`);
      }
    }

    // Map shift type
    let shiftType = undefined;
    if (d.shiftTiming) {
      shiftType = mapShiftType(d.shiftTiming);
      if (!shiftType) {
        shiftTypeWarnings++;
        console.warn(
          `  ⚠️ Could not map shiftTiming "${d.shiftTiming}" for driver ${seedId} – using default TWELVE_HOUR.`
        );
      }
    }

    // Parse experience for max hours
    const { maxDailyHours, maxWeeklyHours } = parseExperienceToHours(d.notes);

    // Status & notes
    const mappedStatus = mapDriverStatus(d.status);
    const origStatusNote = statusNoteFor(d.status, mappedStatus);
    const seedTag = `[seedId:${seedId}]`;
    const shiftNote = shiftType ? `[shift:${d.shiftTiming}->${shiftType}]` : null;
    const hoursNote = maxDailyHours ? `[maxHours:${maxDailyHours}/${maxWeeklyHours}]` : null;
    const notes = [d.notes, origStatusNote, seedTag, shiftNote, hoursNote]
      .filter(Boolean)
      .join(" ");

    // Build data with correct schema fields
    const data = {
      name: d.name,
      phone: d.phone || undefined,
      licenseNumber: licenseNumber,
      cnic: cnic || undefined,
      vendorId: vendorId || undefined,
      status: mappedStatus,
      shiftType: shiftType || "TWELVE_HOUR",
      shiftLabel: d.shiftTiming || undefined,
      maxDailyHours: maxDailyHours,
      maxWeeklyHours: maxWeeklyHours,
      notes,
    };

    // Remove undefined fields
    Object.keys(data).forEach((key) => data[key] === undefined && delete data[key]);

    // Find existing driver - prefer a CNIC match (authoritative), fall back
    // to the legacy seedId-tag-in-notes lookup for records without a CNIC.
    let driver = null;
    let isCnicMatch = false;
    if (cnic) {
      driver = await prisma.driver.findUnique({
        where: { cnic: cnic },
        include: { user: true },
      });
      if (driver) isCnicMatch = true;
    }
    if (!driver) {
      driver = await prisma.driver.findFirst({
        where: { notes: { contains: seedTag } },
        include: { user: true },
      });
    }

    try {
      if (driver && isCnicMatch) {
        // CNIC already exists - only write if something actually changed.
        const changes = computeDriverChanges(driver, data);
        if (changes.length > 0) {
          driver = await prisma.driver.update({
            where: { id: driver.id },
            data,
            include: { user: true },
          });
          driversUpdated++;
          console.log(
            `  ↻ Updated driver ${seedId} (${d.name}) - CNIC ${cnic} matched existing driver "${driver.name}", changes: ${changes.join(", ")}`
          );
        } else {
          cnicConflictSkipped++;
          const currentValues = DRIVER_TRACKED_FIELDS.filter((f) => f in data)
            .map((f) => `${f}="${driver[f] ?? ""}"`)
            .join(", ");
          console.warn(
            `  ⚠️ Skipping driver ${seedId} (${d.name}) - CNIC ${cnic} already exists in database with no changes (driver: ${driver.name}) | current DB values: ${currentValues}`
          );
        }
      } else if (driver) {
        driver = await prisma.driver.update({
          where: { id: driver.id },
          data,
          include: { user: true },
        });
        driversUpdated++;
      } else {
        driver = await prisma.driver.create({
          data,
          include: { user: true },
        });
        driversCreated++;
      }

      // Store under the normalized (trim+lowercase) seedId so the lookup on
      // the vehicle side - which normalizes primaryDriverSeedId before
      // calling .get() - always matches regardless of casing in either file.
      driverIdBySeedId.set(normalize(seedId), driver.id);

      // User + QR
      const email = `${seedId.toLowerCase()}@${DRIVER_EMAIL_DOMAIN}`;
      let user = driver.user;

      if (!user) {
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
          await prisma.driver.updateMany({
            where: { userId: existingUser.id },
            data: { userId: null },
          });

          user = await prisma.user.update({
            where: { id: existingUser.id },
            data: { name: driver.name, role: "DRIVER" },
          });
          await prisma.driver.update({
            where: { id: driver.id },
            data: { userId: user.id },
          });
          usersLinked++;
        } else {
          const qrToken = crypto.randomUUID();
          user = await prisma.user.create({
            data: {
              email,
              name: driver.name,
              passwordHash: defaultPasswordHash,
              role: "DRIVER",
              qrCode: qrToken,
            },
          });
          await prisma.driver.update({
            where: { id: driver.id },
            data: { userId: user.id },
          });
          usersCreated++;
        }
      } else {
        usersSkipped++;
        if (!user.qrCode) {
          const qrToken = crypto.randomUUID();
          user = await prisma.user.update({
            where: { id: user.id },
            data: { qrCode: qrToken },
          });
        }
      }

      // Generate QR image
      if (user?.qrCode) {
        const fileBase = `${safeFileName(d.name) || "driver"}-${seedId}`;
        const qrPath = path.join(QR_DIR, `${fileBase}.png`);
        if (!fs.existsSync(qrPath)) {
          try {
            await QRCode.toFile(qrPath, user.qrCode, {
              width: 400,
              margin: 2,
              errorCorrectionLevel: "M",
            });
            qrGenerated++;
          } catch (err) {
            console.error(`  QR generation failed for ${seedId}:`, err.message);
          }
        }
      }
    } catch (error) {
      if (error.code === "P2002") {
        const target = error.meta?.target;
        const targetFields = Array.isArray(target) ? target.join(", ") : target || "unknown field";
        console.warn(
          `  ⚠️ Skipping driver ${seedId} (${d.name}) - unique constraint hit on [${targetFields}]${
            targetFields.includes("cnic") ? ` (CNIC ${cnic})` : ""
          }`
        );
        if (cnic) {
          const existing = await prisma.driver.findUnique({ where: { cnic: cnic } });
          if (existing) {
            driverIdBySeedId.set(normalize(seedId), existing.id);
          }
        }
        cnicConflictSkipped++;
      } else {
        throw error;
      }
    }

    bumpProgress();
    maybeLogItemProgress("drivers seeded");
  });

  console.log(
    `\n  Drivers: ${driversCreated} created, ${driversUpdated} updated, ${cnicConflictSkipped} skipped (CNIC conflict).`
  );
  console.log(
    `  Users: ${usersCreated} created, ${usersLinked} linked, ${usersSkipped} already existed.`
  );
  console.log(`  QR images: ${qrGenerated} generated (skipped if existed).`);
  if (vendorWarnings) console.log(`  ⚠ ${vendorWarnings} drivers had unresolved vendor names.`);
  if (shiftTypeWarnings) console.log(`  ⚠ ${shiftTypeWarnings} drivers had unmapped shiftType.`);

  // ---------- Process vehicles ----------
  // Stays sequential on purpose: when multiple vehicles reference the same
  // primaryDriverSeedId, "first one wins" (see preflight warning) - that
  // rule only makes sense with a deterministic, in-order pass.
  setPhase("Seeding vehicles", vehicles.length);
  let vehiclesCreated = 0;
  let vehiclesUpdated = 0;
  let vehicleErrors = 0;
  const seedIdsClaimed = new Set();

  for (const v of vehicles) {
    bumpProgress();
    maybeLogItemProgress("vehicles seeded");
    const vehicleNumber = String(v.vehicleNumber || "").trim();
    if (!vehicleNumber) {
      console.error(`  Skipping vehicle with empty number.`);
      continue;
    }

    // Resolve driver
    let driverId = null;
    if (v.primaryDriverSeedId) {
      const seedId = normalize(v.primaryDriverSeedId);
      if (seedId) {
        driverId = driverIdBySeedId.get(seedId) || null;
        if (!driverId) {
          console.error(
            `  Vehicle ${vehicleNumber}: primary driver seed ${v.primaryDriverSeedId} not found – unassigned.`
          );
        } else if (seedIdsClaimed.has(seedId)) {
          console.error(
            `  Vehicle ${vehicleNumber}: seedId ${seedId} already assigned to another vehicle – unassigned.`
          );
          driverId = null;
        } else {
          seedIdsClaimed.add(seedId);
        }
      }
    }

    // Normalize vehicle type
    const vehicleType = normalizeVehicleType(v.type);
    if (!vehicleType) {
      console.error(`  Vehicle ${vehicleNumber} has unrecognised type "${v.type}" – skipping.`);
      continue;
    }
    const { capacity, defaulted } = resolveCapacity(v.capacity, vehicleType);
    const capacityNote = defaulted
      ? `[capacity defaulted to ${capacity} based on type=${vehicleType}]`
      : null;

    const vendorId = v.vendor ? vendorIdByName.get(v.vendor) : undefined;
    const mappedStatus = mapVehicleStatus(v.status);
    const origStatusNote =
      v.status && v.status !== mappedStatus ? `[orig status: ${v.status}]` : null;
    const year = v.model || undefined;
    const notes = [v.notes, origStatusNote, capacityNote].filter(Boolean).join(" ") || undefined;

    // Build vehicle data
    const data = {
      type: vehicleType,
      make: v.make || undefined,
      year,
      capacity,
      status: mappedStatus,
      vendorId: vendorId || undefined,
      driverId: driverId || undefined,
      notes,
    };

    // Remove undefined fields
    Object.keys(data).forEach((key) => data[key] === undefined && delete data[key]);

    try {
      const existing = await prisma.vehicle.findUnique({
        where: { vehicleNumber },
      });
      if (existing) {
        if (driverId && existing.driverId !== driverId) {
          await prisma.$transaction(async (tx) => {
            // Clear this driver off ANY vehicle currently holding it (not
            // just this vehicle's own prior driverId) - driverId is @unique
            // so a stale assignment elsewhere would block the update below.
            await tx.vehicle.updateMany({
              where: { driverId, NOT: { id: existing.id } },
              data: { driverId: null },
            });
            if (existing.driverId) {
              await tx.vehicle.update({
                where: { id: existing.id },
                data: { driverId: null },
              });
            }
            await tx.vehicle.update({
              where: { id: existing.id },
              data: { ...data, driverId },
            });
          });
        } else {
          await prisma.vehicle.update({
            where: { id: existing.id },
            data,
          });
        }
        vehiclesUpdated++;
      } else {
        if (driverId) {
          // Clear this driver off any vehicle already holding it before
          // creating the new one - same unique-constraint concern as above.
          await prisma.vehicle.updateMany({
            where: { driverId },
            data: { driverId: null },
          });
        }
        await prisma.vehicle.create({
          data: { vehicleNumber, ...data },
        });
        vehiclesCreated++;
      }
    } catch (err) {
      vehicleErrors++;
      console.error(`  Vehicle ${vehicleNumber} failed:`, err.message);
    }
  }

  console.log(`  Vehicles: ${vehiclesCreated} created, ${vehiclesUpdated} updated.`);
  if (vehicleErrors) console.log(`  ⚠ ${vehicleErrors} vehicle errors (see above).`);

  // ---------- Final verification ----------
  setPhase("Final verification query");
  const finalDrivers = await prisma.driver.findMany({
    select: {
      id: true,
      name: true,
      licenseNumber: true,
      shiftType: true,
      shiftLabel: true,
      maxDailyHours: true,
      maxWeeklyHours: true,
      notes: true,
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\n  Final DB drivers: ${finalDrivers.length}`);

  const withShiftType = finalDrivers.filter((d) => d.shiftType).length;
  const withMaxHours = finalDrivers.filter((d) => d.maxDailyHours).length;
  console.log(`  Drivers with shiftType set: ${withShiftType}`);
  console.log(`  Drivers with max hours set: ${withMaxHours}`);

  // ---------- Summary ----------
  console.log("\n==============================================");
  console.log("                   SUMMARY");
  console.log("==============================================");
  console.log(`  Unique JSON drivers processed : ${uniqueDrivers.length}`);
  console.log(`  Drivers created              : ${driversCreated}`);
  console.log(`  Drivers updated              : ${driversUpdated}`);
  console.log(`  Drivers skipped (CNIC conflict): ${cnicConflictSkipped}`);
  console.log(`  Drivers skipped (dup CNIC + field match): ${skippedDuplicateCnic}`);
  console.log(`  Drivers nulled CNIC (dup CNIC only): ${nulledDuplicateCnic}`);
  console.log(`  Duplicate drivers removed from DB: ${removedDuplicateDrivers}`);
  console.log(`  Users created                : ${usersCreated}`);
  console.log(`  Users linked                 : ${usersLinked}`);
  console.log(`  Users skipped (already exist): ${usersSkipped}`);
  console.log(`  QR images generated          : ${qrGenerated}`);
  console.log(`  Vehicles created             : ${vehiclesCreated}`);
  console.log(`  Vehicles updated             : ${vehiclesUpdated}`);
  console.log(`  Drivers with shiftType set  : ${withShiftType}`);
  console.log(`  Drivers with max hours set  : ${withMaxHours}`);
  if (vehicleErrors) console.log(`  ⚠ ${vehicleErrors} vehicle errors (see above).`);
  if (vendorWarnings) console.log(`  ⚠ ${vendorWarnings} drivers had unresolved vendor names.`);
  if (shiftTypeWarnings) console.log(`  ⚠ ${shiftTypeWarnings} drivers had unmapped shiftType.`);
  setPhase("done");
  console.log(`  Total time: ${Math.round((Date.now() - progress.startedAt) / 1000)}s`);
  console.log("==============================================");
  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("\n❌ Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });