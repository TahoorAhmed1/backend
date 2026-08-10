const XLSX = require("xlsx");
const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");
const {
  normalizeShift,
  parseShiftRange,
  shiftTimesOverlap,
} = require("../../../utils/shiftTime");

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// ---------- helpers ----------

const toDateOnly = (d) => {
  const date = new Date(d);
  // Normalize using UTC components, not local time. setHours(0,0,0,0) sets
  // the hour in the SERVER's local timezone, which silently shifts the
  // underlying UTC instant whenever the server isn't running in UTC. That
  // shift compounds every time a date string round-trips through
  // formatDateOnly -> frontend -> toDateOnly again (e.g. reassign/optimize
  // calls), eventually landing on a different instant than what's stored,
  // so exact-match Prisma queries silently return zero rows.
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

const formatDateOnly = (d) => new Date(d).toISOString().slice(0, 10);

// normalizeShift / parseShiftRange / shiftTimesOverlap now live in
// utils/shiftTime.js (imported above) so route_controller.js can share the
// exact same overlap logic for its own driver/vehicle conflict checks.

// ---------- Driver Rest Time / Working Hours ----------

const MIN_REST_MINUTES = 8 * 60; // minimum gap required between two shifts
const DEFAULT_MAX_DAILY_HOURS = 12;
const DEFAULT_MAX_WEEKLY_HOURS = 60;

/**
 * True if the gap between the two (possibly overnight) shift ranges is at
 * least MIN_REST_MINUTES in EITHER direction around the 24h cycle. If either
 * range failed to parse, we can't evaluate rest, so we don't block on it —
 * shiftTimesOverlap()'s exact-match fallback already caught the unambiguous
 * "identical shift" case by then.
 */
const hasMinimumRest = (a, b) => {
  if (!a || !b) return true;
  const aEnd = a.start + a.durationMinutes;
  const bEnd = b.start + b.durationMinutes;
  const gapAToB = (((b.start - aEnd) % 1440) + 1440) % 1440;
  const gapBToA = (((a.start - bEnd) % 1440) + 1440) % 1440;
  return Math.max(gapAToB, gapBToA) >= MIN_REST_MINUTES;
};

const countWorkingDays = (entry) =>
  DAY_KEYS.filter((day) => entry[day] && entry[day] !== "OFF").length;

// ---------- In-memory "week roster" cache (bulk-upload perf) ----------
//
// THE REAL BOTTLENECK: findDriverConflict / findVehicleConflict /
// findBestAvailableDriver / findBestAvailableVehicle / checkDriverWorkingHours
// each run their own `prisma.weeklySchedule.findMany(...)` scoped to "every
// live row for this week." That's fine called once. But resolveConflictFreeAssignment
// calls several of these per row, and a bulk upload calls it for EVERY row —
// and the result set they're scanning grows by one row every time the job
// itself writes a new WeeklySchedule entry. So row 1 scans ~0 rows, row 300
// scans ~300 rows, all re-fetched from the DB from scratch every time: total
// work is O(rows^2), not O(rows). THIS, not the employee/driver/vendor/vehicle
// lookups, is why a few hundred rows can take many minutes.
//
// Fix: when `caches.weekRoster` is present, these functions read/filter an
// in-memory array instead of hitting the DB, and the bulk-upload loop keeps
// that array in sync (see upsertRosterEntry) as it writes each row. Callers
// outside bulk upload (single edits, reassign-one, optimize) don't pass
// `caches`, so they keep querying the DB live — correct there, since only
// one or a handful of rows change at a time and staleness isn't a concern.
const filterRoster = (
  roster,
  { driverId, vehicleId, excludeTripId, excludeEmployeeId } = {},
) =>
  roster.filter((r) => {
    if (driverId && r.driverId !== driverId) return false;
    if (vehicleId && r.vehicleId !== vehicleId) return false;
    if (excludeTripId && r.tripId === excludeTripId) return false;
    if (excludeEmployeeId && r.employeeId === excludeEmployeeId) return false;
    return true;
  });

// Called after a row's assignment is written, so the NEXT row in the same
// job sees it immediately instead of racing a DB round trip that would
// return stale (pre-write) data anyway inside a single request.
const upsertRosterEntry = (caches, entry) => {
  if (!caches?.weekRoster) return;
  const idx = caches.weekRoster.findIndex(
    (r) => r.employeeId === entry.employeeId,
  );
  if (idx === -1) caches.weekRoster.push(entry);
  else caches.weekRoster[idx] = { ...caches.weekRoster[idx], ...entry };
};

/**
 * Driver Working Hours Limit: checks a candidate shift against the driver's
 * configured (or default) daily/weekly caps, counting every OTHER active
 * assignment already on the books for that driver this week.
 * Returns { ok: true } or { ok: false, reason }.
 */
const checkDriverWorkingHours = async (
  client,
  driverId,
  weekStartDate,
  candidateShiftTiming,
  candidateWorkingDays,
  excludeEmployeeId,
  caches,
) => {
  let driver = caches?.driverById?.get(driverId);
  if (!driver) {
    driver = await client.driver.findUnique({ where: { id: driverId } });
    if (driver) caches?.driverById?.set(driverId, driver);
  }
  if (!driver) return { ok: true };

  const maxDaily = driver.maxDailyHours || DEFAULT_MAX_DAILY_HOURS;
  const maxWeekly = driver.maxWeeklyHours || DEFAULT_MAX_WEEKLY_HOURS;

  const range = parseShiftRange(candidateShiftTiming);
  if (!range) return { ok: true }; // can't evaluate unparseable shift text

  const dailyHours = range.durationMinutes / 60;
  if (dailyHours > maxDaily) {
    return {
      ok: false,
      reason: `Shift is ${dailyHours.toFixed(1)}h, which exceeds this driver's ${maxDaily}h daily limit.`,
    };
  }

  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, { driverId, excludeEmployeeId })
    : await client.weeklySchedule.findMany({
        where: {
          driverId,
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
      });

  let weeklyMinutes = range.durationMinutes * (candidateWorkingDays || 5);
  for (const other of others) {
    const otherRange = parseShiftRange(other.shiftTiming);
    if (otherRange)
      weeklyMinutes += otherRange.durationMinutes * countWorkingDays(other);
  }

  const weeklyHours = weeklyMinutes / 60;
  if (weeklyHours > maxWeekly) {
    return {
      ok: false,
      reason: `Assigning this driver would total ${weeklyHours.toFixed(1)}h this week, exceeding their ${maxWeekly}h weekly limit.`,
    };
  }

  return { ok: true };
};

// ---------- Historical Assignment Tracking ----------

/**
 * Writes a row to the existing AuditLog model instead of a bespoke history
 * table, so every assignment change (create/update/reassign/optimize/delete)
 * is preserved for reporting even after the live WeeklySchedule row is
 * overwritten or deleted. `before`/`after` are shallow snapshots of just the
 * assignment-relevant fields.
 */
const recordAssignmentHistory = async (
  client,
  action,
  weeklyScheduleId,
  before,
  after,
  changedBy,
) => {
  try {
    await client.auditLog.create({
      data: {
        action,
        model: "WeeklySchedule",
        recordId: weeklyScheduleId,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
        after: after ? JSON.parse(JSON.stringify(after)) : undefined,
        userId: changedBy || undefined,
      },
    });
  } catch (historyError) {
    // Never let audit logging break the actual assignment operation.
  }
};

// ---------- Exception Queue ----------

/**
 * Logs an unresolved conflict (no driver, no vehicle, invalid data, a
 * duplicate employee within the same sheet, etc.) to the review queue
 * instead of only recording it in the response payload, so it isn't lost
 * once the HTTP response is gone.
 */
const logScheduleException = async (
  client,
  { weekStart, employeeCode, rowNumber, reason, rawData },
) => {
  try {
    await client.scheduleException.create({
      data: {
        weekStart,
        employeeCode: employeeCode || undefined,
        rowNumber: rowNumber ?? undefined,
        reason,
        rawData: rawData ? JSON.parse(JSON.stringify(rawData)) : undefined,
      },
    });
  } catch (exceptionLogError) {
    // Never let exception logging break the actual upload/reassign.
  }
};

// ---------- Concurrency Protection ----------

/**
 * Postgres advisory lock scoped to a (week, area) pair, held for the
 * duration of the current transaction. Two concurrent uploads/reassignments
 * touching the same week+area serialize on this instead of racing each
 * other's capacity checks and both landing an employee on the same "last"
 * open seat.
 */
const acquireWeekAreaLock = async (client, weekStartDate, areaKey) => {
  const lockKey = `weekly-schedule::${weekStartDate.toISOString()}::${areaKey || "no-area"}`;
  // FIX: pg_advisory_xact_lock() returns Postgres type `void`. $queryRaw
  // tries to deserialize whatever comes back into a typed result row/column,
  // and there's no Prisma type for `void` — hence "Failed to deserialize
  // column of type 'void'". $executeRaw runs the statement without trying
  // to parse a result set, which is the correct tool here since we only
  // care about the side effect (the lock being held), not any return value.
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
};

/**
 * Wraps acquireWeekAreaLock in its own short transaction and never lets a
 * failure here block the caller.
 *
 * This lock is explicitly a narrow, best-effort mitigation (see the comments
 * at each call site) for two jobs racing on the same week — not something
 * the rest of this file depends on for correctness. Interactive transactions
 * ($transaction) need a stable DB session, which a connection pooler running
 * in "transaction mode" (PgBouncer, Supabase's pooler on port 6543, Neon's
 * pooler, etc.) does NOT reliably provide — that combination is a common,
 * known source of "Unable to start a transaction in the given time" even
 * when the database itself is perfectly healthy. If DATABASE_URL points at
 * a pooled connection, consider using a direct (non-pooled) connection
 * string for this app, or Prisma's `directUrl` datasource option.
 *
 * A raised maxWait/timeout gives a merely-busy pool more room before giving
 * up; the try/catch means that even a hard failure (pooler incompatibility,
 * DB briefly unreachable, whatever) degrades to "proceed without the lock"
 * instead of failing the whole upload/reassign/optimize call.
 */
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

// ---------- Bulk upload (XLSX) helpers ----------

// The sheet's day abbreviations in the "Off Day" column -> our day field keys.
const DAY_ABBR_MAP = {
  SUN: "sunday",
  MON: "monday",
  TUE: "tuesday",
  WED: "wednesday",
  THU: "thursday",
  FRI: "friday",
  SAT: "saturday",
};

// Maps the sheet's (lowercased, trimmed) header text to the field we use internally.
// Add aliases here if a source sheet spells a header differently.
const HEADER_ALIASES = {
  "vehicle type": "vehicleType",
  d: "vehicleType", // NOTE: some sheet templates have this column header shortened to just "D" (seen with values like "Car") — remove this alias if "D" ever means something else in your sheets.
  vendor: "vendor",
  "vehicle entity": "vehicleEntityName", // distinct from the employee's own "Entity" column below
  "vehicle reg": "vehicleReg",
  "vehicle registration": "vehicleReg",
  // Plain "Vehicle" (as opposed to "Vehicle Type") is the sheet's vehicle
  // registration/number column on some templates (e.g. "IBEX Global INT").
  // If your sheets actually use bare "Vehicle" to mean vehicle TYPE instead,
  // swap this to "vehicleType".
  vehicle: "vehicleReg",
  drivers: "drivers",
  "employee id": "employeeCode",
  "user name": "name",
  "off day": "offDay",
  campaign: "campaign",
  // No dedicated "batch" field on WeeklySchedule/Employee. Kept as its own
  // column key (not merged into "campaign" at the alias level, so a sheet
  // that has BOTH columns doesn't have one silently overwrite the other)
  // — see the `campaign = get("campaign") || get("batch")` fallback where
  // it's actually used, a few lines below in processBulkUploadJob.
  batch: "batch",
  entity: "entity",
  "shift timings": "shiftTiming",
  // NOTE: despite the name, "Office Ar(r)ival Time" is the employee's PICK-UP
  // time (e.g. shift is 6:00 PM - 3:00 AM, arrival time is 5:00 PM — the
  // moment they're picked up/dropped at office before the shift starts).
  // It feeds BOTH officeArrivalTime (kept for reference) and pickupTime
  // (the field the Weekly Timetable UI actually reads as "Pick Time").
  "office arival time": "officeArrivalTime", // sheet has this typo (missing "r")
  "office arrival time": "officeArrivalTime",
  "drop time": "dropTime",
  contact: "contact",
  area: "area",
  address: "address",
};

/**
 * "SAT SUN", "Ttue wed", "TUE WED" -> Set of our day keys that should be OFF.
 * Any token that isn't a recognizable day abbreviation (e.g. stray campaign
 * codes like "NASTP" that sometimes end up in this column) is ignored.
 */
const parseOffDays = (offDayRaw) => {
  const tokens =
    String(offDayRaw || "")
      .toUpperCase()
      .match(/SUN|MON|TUE|WED|THU|FRI|SAT/g) || [];
  return new Set(tokens.map((t) => DAY_ABBR_MAP[t]));
};

/**
 * The sheet encodes one-way service as text in the time columns instead of a
 * real field ("Office Arrival Time" = "Drop" means pickup-only isn't running
 * that day / drop-only situation; "Drop Time" = "Pick" means no drop leg).
 * NOTE: verify these enum values ("PICK_AND_DROP", "PICK_ONLY", "DROP_ONLY")
 * match your actual ServiceType enum in schema.prisma before relying on this.
 */
const deriveServiceType = (officeArrivalTime, dropTime) => {
  const arrival = String(officeArrivalTime || "")
    .trim()
    .toLowerCase();
  const drop = String(dropTime || "")
    .trim()
    .toLowerCase();
  if (arrival.includes("drop")) return "DROP_ONLY";
  if (drop.includes("pick")) return "PICK_ONLY";
  return "PICK_AND_DROP";
};

/**
 * "Azam 03092500123" -> [{ name: "Azam", phone: "03092500123" }]
 * Rows sometimes list multiple drivers jammed together with a "/" separator
 * (e.g. "Asim 03006853754 / Azam 03092500123") OR with NO separator at all
 * (e.g. "Tariq 03043160572Shahrukh 03192121756"). Splitting on "/" alone
 * breaks on the second case and leaves the whole raw string as one "name".
 *
 * FIX: instead of splitting first, scan the whole string for
 * "<name><10-13 digit phone>" chunks directly. Regex matches don't need a
 * separator between them, so this correctly finds both drivers either way.
 */
const parseDriverEntries = (raw) => {
  if (!raw) return [];
  const str = String(raw);
  const re = /([A-Za-z][A-Za-z .]*?)\s*[-:]?\s*(\d{10,13})/g;
  const out = [];
  let match;
  while ((match = re.exec(str)) !== null) {
    const name = match[1].trim();
    const phone = match[2];
    if (name) out.push({ name, phone });
  }
  return out;
};

// Back-compat single-entry accessor: WeeklySchedule only stores one driverId,
// so we take the first parsed driver as the primary driver for the row.
const parseDriverEntry = (raw) => parseDriverEntries(raw)[0] || null;

// `cache` is an OPTIONAL Map<lowercasedName, driver> shared across every row
// of a single bulk-upload job. Sheets routinely repeat the same handful of
// drivers hundreds of times — without this cache every one of those rows
// pays a full DB round trip just to re-look-up a driver we already fetched
// two rows ago. This is the single biggest contributor to "upload takes
// forever": ~20+ sequential DB calls per row, most of them re-fetching data
// that hasn't changed since the last row.
/**
 * OPTIMIZATION: drivers now come from the seeded Driver master data (see
 * prisma/seed.js) instead of being invented on the fly from whatever name
 * happened to be typed into a weekly sheet. This is a plain lookup —
 * NEVER creates a driver. A name on the sheet that doesn't match anyone in
 * the master data is a data problem (typo, someone not onboarded yet)
 * that should be visible and fixed at the source, not silently papered
 * over with a fresh throwaway Driver row (which is exactly what used to
 * happen, and is how the master data got messy in the first place).
 *
 * Matches by name only (case-insensitive) — the master seed already
 * carries phone/CNIC/vendor, so there's nothing to fill in from the
 * sheet's row on a hit, unlike the old create path.
 */
const findDriver = async (name, cache, extraCaches) => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (cache?.has(key)) return cache.get(key);

  const driver = await prisma.driver.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
    include: { vehicle: true },
  });
  cache?.set(key, driver || null);
  if (driver) extraCaches?.driverById?.set(driver.id, driver);
  return driver;
};

/**
 * NOTE: assumes Vehicle has a unique-ish `vehicleNumber` field and a `status`
 * field (matching how getScheduleTableStats counts
 * `prisma.vehicle.count({ where: { status: "ACTIVE" } })`). Adjust field
 * names below if your Vehicle model differs.
 */
/**
 * OPTIMIZATION: vehicles now come from the seeded Vehicle master data too
 * (each already paired 1:1 to its driver — see prisma/seed.js). This is a
 * plain lookup by plate number, used only when the sheet explicitly names
 * a DIFFERENT vehicle than the one already paired to the matched driver
 * (a genuine this-week reassignment). It never creates a vehicle — an
 * unrecognized plate is a data problem to fix at the source, not a reason
 * to spin up a bare placeholder row.
 *
 * (This replaces both the old findOrCreateVehicle AND
 * findOrCreateDefaultVehicleForDriver — the latter existed specifically
 * to paper over drivers having no paired vehicle at all, which can't
 * happen anymore now that every seeded driver already has one.)
 */
const findVehicleByReg = async (vehicleReg, cache) => {
  const trimmed = String(vehicleReg || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toUpperCase();
  if (cache?.has(key)) return cache.get(key);

  const vehicle = await prisma.vehicle.findFirst({
    where: { vehicleNumber: { equals: trimmed, mode: "insensitive" } },
  });
  cache?.set(key, vehicle || null);
  return vehicle;
};

const VEHICLE_TYPES = new Set(["CAR", "VAN", "HIJET", "KARVAN", "BUS"]);

/**
 * Normalizes a raw vehicle-type cell into one of VEHICLE_TYPES' keys.
 * Source sheets are inconsistent — "Hi jet", "Hi jet " (space in the
 * middle), "HiJet", even "Hi jet/ Van " (two types jammed together) all
 * show up for what should be the single type HIJET. A plain
 * .trim().toUpperCase() only fixes case/edge-whitespace, so "Hi jet"
 * becomes "HI JET" (with an internal space) and never matches "HIJET" —
 * silently breaking type-based vehicle matching and capacity guessing for
 * every "Hi jet" row. This strips ALL whitespace before comparing, and for
 * combo values ("Hi jet/ Van") takes the first recognized type.
 */
const normalizeVehicleType = (raw) => {
  const str = String(raw || "").toUpperCase();
  const parts = str.split(/[\/,]/).map((p) => p.replace(/\s+/g, ""));
  return parts.find((p) => VEHICLE_TYPES.has(p)) || parts[0] || "";
};

/**
 * Is this driver already committed to something that ACTUALLY OVERLAPS this
 * candidate shift, this week?
 *
 * Previous version treated "any other non-cancelled row this week on a
 * different route" as a conflict, full stop — no time comparison. That
 * over-blocks (a driver working 6-2 and 10pm-6am on two different routes
 * gets refused even though there's zero real overlap) while ALSO
 * under-verifying (it never actually checks the two shifts overlap; it just
 * assumes "different route == conflict").
 *
 * Now: same-trip reuse is never a conflict (that's the same job). Otherwise
 * we pull every other live assignment this driver has this week and run
 * each one through shiftTimesOverlap() against the candidate shift, plus a
 * minimum-rest check so back-to-back shifts with no recovery time are still
 * flagged even when they don't literally overlap in minutes. If either
 * shift's timing string can't be parsed, we fall back to the old
 * conservative "any other route this week" behavior for that row only,
 * since we can't prove there's no overlap.
 */
const findDriverConflict = async (
  driverId,
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId,
  caches,
) => {
  if (!driverId) return null;
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        driverId,
        excludeTripId: targetTripId,
        excludeEmployeeId,
      })
    : await prisma.weeklySchedule.findMany({
        where: {
          driverId,
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        include: { route: true },
      });

  const candidateRange = candidateShiftTiming
    ? parseShiftRange(candidateShiftTiming)
    : null;

  for (const other of others) {
    if (!candidateShiftTiming || !other.shiftTiming) return other; // can't prove no overlap
    if (shiftTimesOverlap(candidateShiftTiming, other.shiftTiming))
      return other;
    const otherRange = parseShiftRange(other.shiftTiming);
    if (
      candidateRange &&
      otherRange &&
      !hasMinimumRest(candidateRange, otherRange)
    )
      return other;
  }
  return null;
};

/** Same idea as findDriverConflict, but for a vehicle. */
const findVehicleConflict = async (
  vehicleId,
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId,
  caches,
) => {
  if (!vehicleId) return null;
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        vehicleId,
        excludeTripId: targetTripId,
        excludeEmployeeId,
      })
    : await prisma.weeklySchedule.findMany({
        where: {
          vehicleId,
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        include: { route: true },
      });

  for (const other of others) {
    if (!candidateShiftTiming || !other.shiftTiming) return other;
    if (shiftTimesOverlap(candidateShiftTiming, other.shiftTiming))
      return other;
    // Vehicles don't need rest time the way drivers do — overlap alone is
    // the disqualifying condition (a van can go straight from one run into
    // the next), so no hasMinimumRest check here.
  }
  return null;
};

/**
 * Picks the "best" driver for a shift/week: must be AVAILABLE, and must not
 * have any OTHER live assignment this week whose shift actually overlaps
 * (or leaves less than the minimum rest gap around) the candidate shift.
 *
 * Previously this excluded any driver with ANY other assignment this week
 * at all, regardless of time — so a driver fully free except for one
 * non-overlapping morning shift was wrongly taken out of the pool for an
 * unrelated evening shift, artificially starving the "available" list and
 * pushing more rows than necessary into "no driver found."
 */
const findBestAvailableDriver = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId,
  caches,
) => {
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        excludeTripId: targetTripId,
        excludeEmployeeId,
      }).filter((r) => r.driverId)
    : await prisma.weeklySchedule.findMany({
        where: {
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          driverId: { not: null },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        select: { driverId: true, shiftTiming: true },
      });

  const candidateRange = candidateShiftTiming
    ? parseShiftRange(candidateShiftTiming)
    : null;
  const busyIds = new Set();
  const loadMap = new Map();
  for (const row of others) {
    loadMap.set(row.driverId, (loadMap.get(row.driverId) || 0) + 1);
    if (!candidateShiftTiming || !row.shiftTiming) {
      busyIds.add(row.driverId); // unparseable — can't prove no overlap, stay conservative
      continue;
    }
    if (shiftTimesOverlap(candidateShiftTiming, row.shiftTiming)) {
      busyIds.add(row.driverId);
      continue;
    }
    const otherRange = parseShiftRange(row.shiftTiming);
    if (
      candidateRange &&
      otherRange &&
      !hasMinimumRest(candidateRange, otherRange)
    ) {
      busyIds.add(row.driverId);
    }
  }

  const eligible = caches?.availableDrivers
    ? caches.availableDrivers.filter((d) => !busyIds.size || !busyIds.has(d.id))
    : await prisma.driver.findMany({
        where: {
          status: "AVAILABLE",
          ...(busyIds.size ? { id: { notIn: Array.from(busyIds) } } : {}),
        },
        include: { vehicle: true },
        orderBy: { createdAt: "asc" },
      });
  if (!eligible.length) return null;
  if (eligible.length === 1) return eligible[0];

  // Smart Driver Balancing: prefer whoever is carrying the fewest
  // assignments this week (counting ALL their assignments, not just
  // overlapping ones, so load stays spread out even across non-overlapping
  // shifts). Ties fall back to createdAt order for determinism.
  let best = eligible[0];
  let bestLoad = loadMap.get(best.id) || 0;
  for (const driver of eligible.slice(1)) {
    const load = loadMap.get(driver.id) || 0;
    if (load < bestLoad) {
      best = driver;
      bestLoad = load;
    }
  }
  return best;
};

/**
 * Picks the "best" vehicle for a route/week: must be ACTIVE, must not
 * already be booked on a DIFFERENT route this week, and should meet the
 * route's capacity if we know it. Prefers a type match (e.g. sheet said
 * "Hiace"/"Van") when a valid VehicleType hint is available, falling back to
 * any qualifying vehicle otherwise (smallest-capacity-first, so big vehicles
 * stay free for routes that actually need them).
 */
const findBestAvailableVehicle = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  minCapacity,
  vehicleTypeHint,
  excludeEmployeeId,
  caches,
) => {
  const others = caches?.weekRoster
    ? filterRoster(caches.weekRoster, {
        excludeTripId: targetTripId,
        excludeEmployeeId,
      }).filter((r) => r.vehicleId)
    : await prisma.weeklySchedule.findMany({
        where: {
          weekStart: weekStartDate,
          status: { not: "CANCELLED" },
          vehicleId: { not: null },
          ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
          ...(excludeEmployeeId
            ? { employeeId: { not: excludeEmployeeId } }
            : {}),
        },
        select: { vehicleId: true, shiftTiming: true },
      });
  const busyIds = [];
  for (const row of others) {
    if (
      !candidateShiftTiming ||
      !row.shiftTiming ||
      shiftTimesOverlap(candidateShiftTiming, row.shiftTiming)
    ) {
      busyIds.push(row.vehicleId);
    }
  }

  const typeKey = normalizeVehicleType(vehicleTypeHint);

  if (caches?.activeVehicles) {
    // In-memory equivalent of the two DB queries below: filter by
    // ACTIVE + not-busy + capacity, sorted smallest-capacity-first so a
    // right-sized vehicle is preferred over an oversized one.
    const candidates = caches.activeVehicles
      .filter(
        (v) =>
          (!busyIds.length || !busyIds.includes(v.id)) &&
          (!minCapacity || (v.capacity ?? 0) >= minCapacity),
      )
      .sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0));

    if (typeKey && VEHICLE_TYPES.has(typeKey)) {
      const typed = candidates.find((v) => v.type === typeKey);
      if (typed) return typed;
    }
    return candidates[0] || null;
  }

  const baseWhere = {
    status: "ACTIVE",
    ...(busyIds.length ? { id: { notIn: busyIds } } : {}),
    ...(minCapacity ? { capacity: { gte: minCapacity } } : {}),
  };

  if (typeKey && VEHICLE_TYPES.has(typeKey)) {
    const typed = await prisma.vehicle.findFirst({
      where: { ...baseWhere, type: typeKey },
      orderBy: { capacity: "asc" },
    });
    if (typed) return typed;
  }

  return prisma.vehicle.findFirst({
    where: baseWhere,
    orderBy: { capacity: "asc" },
  });
};

/**
 * Smart Auto Assignment: finds a conflict-free driver, then prefers that
 * driver's own paired vehicle (Vehicle.driverId is a 1:1 relation in the
 * schema) if it's free this week, otherwise finds any other free,
 * right-sized vehicle.
 */
const autoAssignDriverAndVehicle = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  minCapacity,
  vehicleTypeHint,
  excludeEmployeeId,
  caches,
) => {
  const driver = await findBestAvailableDriver(
    weekStartDate,
    candidateShiftTiming,
    targetTripId,
    excludeEmployeeId,
    caches,
  );
  if (!driver) return { driverId: undefined, vehicleId: undefined };

  let vehicle =
    driver.vehicle && driver.vehicle.status === "ACTIVE"
      ? driver.vehicle
      : null;
  if (vehicle) {
    const conflict = await findVehicleConflict(
      vehicle.id,
      weekStartDate,
      candidateShiftTiming,
      targetTripId,
      excludeEmployeeId,
      caches,
    );
    if (conflict) vehicle = null;
  }
  if (!vehicle) {
    vehicle = await findBestAvailableVehicle(
      weekStartDate,
      candidateShiftTiming,
      targetTripId,
      minCapacity,
      vehicleTypeHint,
      excludeEmployeeId,
      caches,
    );
  }

  return { driverId: driver.id, vehicleId: vehicle?.id };
};

/**
 * Conflict Prevention + Smart Auto Assignment, combined into one call site
 * used by bulk upload, bulk reassign, and optimize:
 *   1. If a driver/vehicle was proposed (e.g. named in the sheet, or carried
 *      over from a prior assignment) but its shift ACTUALLY OVERLAPS (or
 *      leaves too little rest around) something it's already booked for
 *      this week, drop it and note why instead of silently double-booking.
 *   2. If there's still no driver, auto-assign the best available
 *      (AVAILABLE status + conflict-free + working-hours-compliant) one,
 *      and try to bring along its own paired vehicle.
 *   3. If there's still no vehicle, auto-assign the best available
 *      (ACTIVE status + conflict-free + capacity-fitting) one.
 *   4. Writes the result onto the Trip (driverId/vehicleId), which is the
 *      source of truth per-vehicle-run; Route.driverId is then re-derived
 *      from trips by syncRouteFromTrips (called by the trip resolver), not
 *      set directly here.
 *
 * `trip` must include `.route` (for shiftTiming fallback) or the caller
 * must pass `candidateShiftTiming` explicitly.
 */
const resolveConflictFreeAssignment = async ({
  trip,
  weekStartDate,
  candidateShiftTiming,
  proposedDriverId,
  proposedVehicleId,
  vehicleTypeHint,
  minCapacity,
  excludeEmployeeId,
  caches,
}) => {
  const notes = [];
  let driverId = proposedDriverId;
  let vehicleId = proposedVehicleId;
  let autoAssignedDriver = false;
  let autoAssignedVehicle = false;
  const shiftTiming =
    candidateShiftTiming || trip.shiftTiming || trip.route?.shiftTiming;

  if (driverId) {
    const conflict = await findDriverConflict(
      driverId,
      weekStartDate,
      shiftTiming,
      trip.id,
      excludeEmployeeId,
      caches,
    );
    if (conflict) {
      notes.push(
        `Requested driver's shift overlaps (or doesn't leave enough rest around) route "${conflict.route?.routeCode ?? conflict.routeId}" this week — auto-assigned a different available driver instead.`,
      );
      driverId = undefined;
    }
  }

  if (driverId) {
    const hoursCheck = await checkDriverWorkingHours(
      prisma,
      driverId,
      weekStartDate,
      shiftTiming,
      undefined,
      excludeEmployeeId,
      caches,
    );
    if (!hoursCheck.ok) {
      notes.push(
        `Requested driver was skipped — ${hoursCheck.reason} Auto-assigned a different available driver instead.`,
      );
      driverId = undefined;
    }
  }

  if (vehicleId) {
    const conflict = await findVehicleConflict(
      vehicleId,
      weekStartDate,
      shiftTiming,
      trip.id,
      excludeEmployeeId,
      caches,
    );
    if (conflict) {
      notes.push(
        `Requested vehicle's shift overlaps route "${conflict.route?.routeCode ?? conflict.routeId}" this week — auto-assigned a different available vehicle instead.`,
      );
      vehicleId = undefined;
    }
  }

  const capacityFloor = minCapacity ?? trip.vehicle?.capacity;

  if (!driverId) {
    const best = await autoAssignDriverAndVehicle(
      weekStartDate,
      shiftTiming,
      trip.id,
      capacityFloor,
      vehicleTypeHint,
      excludeEmployeeId,
      caches,
    );
    if (best.driverId) {
      driverId = best.driverId;
      autoAssignedDriver = true;
      if (!vehicleId && best.vehicleId) {
        vehicleId = best.vehicleId;
        autoAssignedVehicle = true;
      }
    } else {
      notes.push(
        "No available (conflict-free) driver found for this row — left unassigned; assign manually.",
      );
    }
  }

  if (driverId && !vehicleId) {
    const vehicle = await findBestAvailableVehicle(
      weekStartDate,
      shiftTiming,
      trip.id,
      capacityFloor,
      vehicleTypeHint,
      excludeEmployeeId,
      caches,
    );
    if (vehicle) {
      vehicleId = vehicle.id;
      autoAssignedVehicle = true;
    } else {
      notes.push(
        "No available (conflict-free) vehicle found for this row — left unassigned; assign manually.",
      );
    }
  }

  if (
    driverId !== (trip.driverId || undefined) ||
    vehicleId !== (trip.vehicleId || undefined)
  ) {
    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        driverId: driverId || null,
        vehicleId: vehicleId || null,
      },
    });
    await syncRouteFromTrips(trip.routeId, caches);
    // The trip we just patched, and the route's cached trip list, are now
    // both stale — drop the cached list for this route so the NEXT row
    // that resolves a trip on it re-reads real data instead of acting on
    // driver/vehicle info from before this reassignment.
    caches?.tripsByRoute?.delete(trip.routeId);
  }

  return {
    driverId,
    vehicleId,
    autoAssignedDriver,
    autoAssignedVehicle,
    notes,
  };
};

/**
 * NOTE: assumes Vendor has a `name` field. Adjust if different.
 */
/**
 * OPTIMIZATION: vendors now come from the seeded Vendor master data
 * (prisma/seed.js). Find-only, same reasoning as findDriver/
 * findVehicleByReg above — an unrecognized vendor name on a sheet is a
 * typo or a genuinely new vendor that should be added deliberately
 * (there are only a handful of these; it's cheap to add for real), not
 * something to silently fork into a near-duplicate Vendor row.
 */
const findVendor = async (name, cache) => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (cache?.has(key)) return cache.get(key);

  const vendor = await prisma.vendor.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
  });
  cache?.set(key, vendor || null);
  return vendor;
};

/**
 * OPTIMIZATION: employees now come from the seeded Employee master data
 * (prisma/seed-employees.js), which already carries the canonical
 * area/subArea/block for each employee (from the real HR address data,
 * not whatever text happened to be typed into this week's sheet). This is
 * a plain lookup by employeeCode — it NEVER creates an employee. Someone
 * appearing on a weekly sheet who isn't in the master data needs to be
 * added there first (or the code column has a typo) — that's a data
 * problem to surface, not something to paper over with a bare-bones
 * Employee row missing gender/CNIC/department/etc.
 *
 * Returns the employee with area/subArea/block already attached, since
 * the caller uses them for route grouping instead of re-parsing the
 * sheet's own (less reliable) Area/Sub Area/Block columns — see the call
 * site in processBulkUploadJob.
 */
const findEmployee = async (employeeCode, caches) => {
  if (caches?.employee?.has(employeeCode)) {
    return caches.employee.get(employeeCode) || null;
  }
  const employee = await prisma.employee.findUnique({
    where: { employeeCode },
    include: { area: true, subArea: true, block: true },
  });
  caches?.employee?.set(employeeCode, employee || null);
  return employee;
};

/**
 * Builds a stable, human-readable slug for auto-generated route codes, e.g.
 * "Gulshan-e-Iqbal", "Hiace", "12:00 AM - 8:00 AM" -> "GULSHAN-E-IQBAL-HIACE-1200-AM-800-AM"
 */
const slugify = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Default capacity used when auto-creating a Route, since the source sheet
 * has no "capacity" column. Route.maxCapacity is a REQUIRED Int with no
 * schema default — omitting it throws a Prisma validation error, which was
 * silently sending every freshly-created route to `skipped`. Adjust these
 * numbers to your fleet's real seating if they don't match.
 */
const DEFAULT_CAPACITY_BY_VEHICLE_TYPE = {
  CAR: 4,
  VAN: 12,
  HIJET: 10,
  KARVAN: 15,
  BUS: 40,
};
const FALLBACK_ROUTE_CAPACITY = 10;

const guessMaxCapacity = (vehicleTypeRaw) => {
  const key = normalizeVehicleType(vehicleTypeRaw);
  return DEFAULT_CAPACITY_BY_VEHICLE_TYPE[key] || FALLBACK_ROUTE_CAPACITY;
};

/**
 * How many employees are already riding a given Trip (one vehicle run) for
 * a given week. This is the per-trip occupancy count — the actual source of
 * truth for "is this specific vehicle run full" — as opposed to the
 * route-level rollup, which only tells you the corridor's aggregate.
 * Excludes the row currently being processed's own employee (re-saving
 * their own row shouldn't count them twice) and excludes CANCELLED rows.
 */
const countTripOccupancy = async (tripId, weekStartDate, excludeEmployeeId) => {
  return prisma.weeklySchedule.count({
    where: {
      tripId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
  });
};

/**
 * Route.routeCode is UNIQUE. Used both for brand-new routes and (rarely) if
 * two sheets race to create the same corridor.
 */
const generateUniqueRouteCode = async (baseCode) => {
  let candidate = baseCode;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.route.findUnique({ where: { routeCode: candidate } })) {
    n += 1;
    candidate = `${baseCode}-L${n}`;
  }
  return candidate;
};

/**
 * Route.maxCapacity is a denormalized rollup, NOT the source of truth (see
 * schema comment on Route.maxCapacity). This recomputes it as the sum of
 * every ACTIVE trip's vehicle capacity on the route (falling back to a
 * guessed capacity for trips with no vehicle attached yet), and mirrors
 * trip #1's driver onto Route.driverId for the legacy single-driver reads
 * elsewhere in the app. Call this any time a trip on the route is created,
 * or its driver/vehicle changes.
 */
const syncRouteFromTrips = async (routeId, caches, tripsHint) => {
  // FIX: Trip.status uses the RouteStatus enum (ACTIVE | INACTIVE only —
  // see schema.prisma). "CANCELLED" is not a member of that enum, so this
  // filter previously made every call throw a PrismaClientValidationError
  // ("Invalid value for argument `status`"). Since syncRouteFromTrips runs
  // after every trip create/update, that exception propagated straight up
  // through findOrCreateTripOnRoute -> findOrCreateRouteAndTrip and was
  // caught by bulk upload's per-row try/catch as "Route/Trip creation
  // failed" — meaning EVERY row's route/trip step was failing, not just
  // capacity-overflow ones. "Not cancelled" for a Trip means status ACTIVE.
  //
  // FIX (perf): this used to unconditionally re-query every ACTIVE trip on
  // the route AND write route.update, on every single call — and it was
  // being called on EVERY bulk-upload row (see findOrCreateTripOnRoute),
  // even rows that reused an already-correct trip with nothing to sync.
  // `tripsHint` lets a caller that already has the route's trips in memory
  // (bulk upload's caches.tripsByRoute) skip the re-fetch, and the write
  // itself is now skipped when the computed values match what's already
  // cached — a route that's already in sync no longer costs a DB round
  // trip just because another row happened to touch it.
  const trips =
    tripsHint ||
    (await prisma.trip.findMany({
      where: { routeId, status: "ACTIVE" },
      include: { vehicle: true },
      orderBy: { tripNumber: "asc" },
    }));
  const totalCapacity = trips.reduce(
    (sum, t) => sum + (t.vehicle?.capacity ?? FALLBACK_ROUTE_CAPACITY),
    0,
  );
  const newMaxCapacity = totalCapacity || FALLBACK_ROUTE_CAPACITY;
  const newDriverId = trips[0]?.driverId || null;

  const cachedRoute = caches?.routeById?.get(routeId);
  if (
    cachedRoute &&
    cachedRoute.maxCapacity === newMaxCapacity &&
    cachedRoute.driverId === newDriverId
  ) {
    return cachedRoute;
  }

  const updated = await prisma.route.update({
    where: { id: routeId },
    data: {
      maxCapacity: newMaxCapacity,
      driverId: newDriverId,
    },
    include: { area: true, driver: true },
  });
  caches?.routeById?.set(routeId, updated);
  return updated;
};

/**
 * Resolves the Route + Trip a sheet row should be assigned to.
 *
 * Takes an already-resolved `areaRecord` (the matched Employee's own
 * area — see findEmployee/processBulkUploadJob) rather than an area name
 * string to look up. Routes/Trips still get created on the fly here (that
 * part is legitimately dynamic — shift timings and capacity needs change
 * week to week), but Area no longer does: it comes from the employee
 * master data now, so a sheet's own "Area" column text (which can vary
 * week to week for the same person — typos, alternate spellings) no
 * longer risks fragmenting into duplicate Area rows or misrouting someone
 * away from their usual corridor.
 *
 * Area + Shift together define a "corridor" — exactly ONE Route row per
 * corridor (no more routeCode-L2/-L3 route "legs"; that pre-Trip pattern is
 * retired). Capacity overflow within a corridor is handled by opening
 * additional Trip rows (tripNumber 2, 3, ...) UNDER that same route, which
 * is what the Trip model exists for.
 *
 * Strategy, in order:
 *   1. Find (or create) the single Route for this Area (+ shiftTiming, if
 *      given — matched against Route.shiftTiming, with a routeName
 *      substring fallback for older data).
 *   2. Walk that route's trips in tripNumber order and take the FIRST one
 *      that has free seats (occupancy < trip's vehicle capacity, or a
 *      guessed default if no vehicle is attached yet) AND either no driver
 *      yet or the SAME driver as this row.
 *   3. If it had no driver yet, claim it now for this row's driver.
 *   4. If no existing trip qualifies (all full, or all claimed by other
 *      drivers), open a new Trip: tripNumber = max(existing) + 1, its own
 *      driver/vehicle.
 *   5. Always finish with syncRouteFromTrips so Route.maxCapacity/driverId
 *      stay a correct rollup of the trips underneath it.
 */
const findOrCreateRouteAndTrip = async (
  areaRecord, // already-resolved Area object (or null) — no lookup/creation done here anymore
  vehicleType,
  shiftTiming,
  campaign,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId,
  caches,
) => {
  let route = null;
  if (areaRecord) {
    // Routes-per-area are also cached per job: once we've loaded a given
    // area's routes we reuse that list rather than re-querying it for
    // every row that shares the area (very common — a sheet's rows are
    // usually clustered by area/shift). The cache is invalidated (deleted)
    // whenever this job creates or mutates a route/trip in that area, so
    // capacity/overflow decisions never read stale data.
    let candidates = caches?.routesByArea?.get(areaRecord.id);
    if (!candidates) {
      candidates = await prisma.route.findMany({
        where: { areaId: areaRecord.id },
        include: { area: true },
        orderBy: { routeCode: "asc" },
      });
      caches?.routesByArea?.set(areaRecord.id, candidates);
    }
    if (shiftTiming) {
      const shiftLower = shiftTiming.trim().toLowerCase();
      route =
        candidates.find(
          (r) =>
            (r.shiftTiming &&
              r.shiftTiming.trim().toLowerCase() === shiftLower) ||
            String(r.routeName || "")
              .toLowerCase()
              .includes(shiftLower),
        ) || null;
    } else {
      route = candidates[0] || null;
    }
  }

  let routeCreated = false;
  if (!route) {
    const baseName =
      [areaRecord?.name, vehicleType, shiftTiming].filter(Boolean).join(" - ") ||
      campaign ||
      "General Route";
    const baseCode = slugify(baseName) || `ROUTE-${Date.now()}`;
    const routeCode = await generateUniqueRouteCode(baseCode);
    route = await prisma.route.create({
      data: {
        routeName: baseName,
        routeCode,
        shiftTiming: shiftTiming || undefined,
        maxCapacity: guessMaxCapacity(vehicleType), // placeholder; syncRouteFromTrips corrects it below
        areaId: areaRecord?.id,
      },
      include: { area: true },
    });
    routeCreated = true;
    // Invalidate the cached route list for this area so the NEXT row that
    // needs this area (very likely, later in the same sheet) sees the route
    // we just created instead of an empty/stale list from before it existed.
    if (areaRecord) caches?.routesByArea?.delete(areaRecord.id);
  }

  const { trip, newTrip } = await findOrCreateTripOnRoute(
    route,
    vehicleType,
    shiftTiming,
    driverId,
    vehicleIdHint,
    weekStartDate,
    excludeEmployeeId,
    caches,
  );

  // FIX (perf): this used to unconditionally re-fetch the route from the
  // DB on EVERY row just to attach area/driver — one more guaranteed round
  // trip per row on top of everything above. syncRouteFromTrips (inside
  // findOrCreateTripOnRoute) already writes the freshest copy into
  // caches.routeById whenever it actually changes anything; reuse that
  // instead of asking the DB again for data we very likely already have.
  route = caches?.routeById?.get(route.id) || route;

  return { route, trip, created: routeCreated, newTrip };
};

/**
 * Given an already-resolved Route, finds the first Trip on it with room for
 * this driver (or opens a new one — tripNumber = max existing + 1 — if none
 * qualify), then re-syncs Route.maxCapacity/driverId from all its trips.
 * Shared by findOrCreateRouteAndTrip (new sheet rows) and by
 * optimize/reassign (existing rows that only have a routeId and need a
 * tripId backfilled onto them).
 */
const findOrCreateTripOnRoute = async (
  route,
  vehicleType,
  shiftTiming,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId,
  caches,
) => {
  // FIX (perf — this is the main reason bulk upload was taking forever /
  // never finishing on real-size workbooks): this used to run
  // `prisma.trip.findMany` fresh on EVERY row, and then — worse — ran a
  // separate `prisma.weeklySchedule.count` (countTripOccupancy) for EVERY
  // candidate trip on the route, on EVERY row, even though rows are
  // normally clustered by area/shift and hit the exact same handful of
  // routes/trips hundreds of times over. On a route with 2-3 trips that
  // alone was 3-4 extra DB round trips per row, on top of everything else.
  // The job already preloads the whole week's live roster into
  // caches.weekRoster up front specifically so per-row checks like this
  // don't need to hit the DB (see the big comment in processBulkUploadJob
  // and how checkDriverWorkingHours/findDriverConflict/etc. already use
  // it) — this just brings trip lookup and occupancy counting in line with
  // that same pattern instead of being the one place still doing it the
  // slow way.
  let trips = caches?.tripsByRoute?.get(route.id);
  if (!trips) {
    // FIX: same invalid-enum issue as syncRouteFromTrips below — Trip.status
    // is RouteStatus (ACTIVE | INACTIVE), not "CANCELLED".
    trips = await prisma.trip.findMany({
      where: { routeId: route.id, status: "ACTIVE" },
      include: { vehicle: true },
      orderBy: { tripNumber: "asc" },
    });
    caches?.tripsByRoute?.set(route.id, trips);
  }
  const hadExistingTrips = trips.length > 0;

  let trip = null;
  for (const candidate of trips) {
    const capacity =
      candidate.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
    const occupancy = caches?.weekRoster
      ? caches.weekRoster.filter(
          (r) =>
            r.tripId === candidate.id &&
            (!excludeEmployeeId || r.employeeId !== excludeEmployeeId),
        ).length
      : await countTripOccupancy(candidate.id, weekStartDate, excludeEmployeeId);
    const hasRoom = occupancy < capacity;
    const driverOk =
      !driverId || !candidate.driverId || candidate.driverId === driverId;
    if (hasRoom && driverOk) {
      trip = candidate;
      break;
    }
  }

  // FIX (real-world bug): previously this attached `driverId`/`vehicleIdHint`
  // straight onto a brand-new trip (or patched them onto an existing one)
  // with NO conflict check at all — a driver already booked on a DIFFERENT
  // route at an overlapping time this week would get written here first,
  // and only get silently corrected afterward by resolveConflictFreeAssignment
  // (which then has to issue a second `trip.update` to undo it). That's a
  // real window where "same driver, same timing, two routes" gets persisted,
  // even if briefly. Checking BEFORE the write means a conflicting
  // driver/vehicle is never attached to a trip in the first place — if
  // there's a conflict we just leave it off this trip and let
  // resolveConflictFreeAssignment (the single source of truth for
  // conflict-free auto-assignment) pick a real replacement, instead of
  // handing it something to undo.
  let safeDriverId = driverId || undefined;
  if (safeDriverId) {
    const driverConflict = await findDriverConflict(
      safeDriverId,
      weekStartDate,
      shiftTiming,
      trip?.id, // exclude the trip we're about to reuse, if any
      excludeEmployeeId,
      caches,
    );
    if (driverConflict) safeDriverId = undefined;
  }
  let safeVehicleId = vehicleIdHint || undefined;
  if (safeVehicleId) {
    const vehicleConflict = await findVehicleConflict(
      safeVehicleId,
      weekStartDate,
      shiftTiming,
      trip?.id,
      excludeEmployeeId,
      caches,
    );
    if (vehicleConflict) safeVehicleId = undefined;
  }

  let tripCreated = false;
  let tripChanged = false;
  if (!trip) {
    const nextTripNumber = trips.length
      ? Math.max(...trips.map((t) => t.tripNumber)) + 1
      : 1;
    trip = await prisma.trip.create({
      data: {
        routeId: route.id,
        tripNumber: nextTripNumber,
        driverId: safeDriverId,
        vehicleId: safeVehicleId,
        shiftTiming: shiftTiming || undefined,
      },
      include: { vehicle: true },
    });
    tripCreated = true;
    tripChanged = true;
    // Keep the cached list current so the NEXT row that hits this route
    // sees the trip we just created instead of re-fetching or missing it.
    trips.push(trip);
  } else {
    const patch = {};
    if (safeDriverId && !trip.driverId) patch.driverId = safeDriverId;
    if (safeVehicleId && !trip.vehicleId) patch.vehicleId = safeVehicleId;
    if (Object.keys(patch).length) {
      trip = await prisma.trip.update({
        where: { id: trip.id },
        data: patch,
        include: { vehicle: true },
      });
      tripChanged = true;
      const idx = trips.findIndex((t) => t.id === trip.id);
      if (idx !== -1) trips[idx] = trip;
    }
  }

  // FIX (perf): previously ran unconditionally on EVERY row (a
  // trip.findMany + a route.update), even when this row reused an
  // existing trip with no driver/vehicle/capacity change at all. Only
  // worth doing when something about this route's trips actually changed.
  if (tripChanged) {
    await syncRouteFromTrips(route.id, caches, trips);
  }
  return { trip, newTrip: tripCreated && hadExistingTrips };
};

// ---------- Bulk reassign: shift-mismatched employees, one click ----------

/**
 * A route's employees are supposed to all share its Area + Shift. When an
 * employee's own shiftTiming changes and no longer matches the route, they
 * need to move to a route that actually runs their new shift.
 *
 * This does it for EVERY mismatched employee on the route in one call —
 * no per-employee modal. Employees who now share the same new shift timing
 * are grouped and sent through the same capacity-aware leg resolver used by
 * bulk upload, so:
 *   - if an existing route already covers that Area + new Shift and has
 *     room, they land on it (and get its driver/vehicle), and
 *   - capacity is ALWAYS checked (maxCapacity vs current occupancy) before
 *     anyone is placed — a route is never overbooked, and
 *   - only when every matching route/leg is full does a brand-new route +
 *     leg get created, with an available driver attached if one was passed.
 *
 * Body: { routeId?: string, routeCode?: string, weekStart: string }
 * (accepts either — the frontend's grouped-schedule view only carries
 * routeCode, not the raw Route.id, so routeCode works standalone.)
 */
const reassignMismatchedShiftEmployees = async (req, res, next) => {
  try {
    const { routeId, routeCode, weekStart } = req.body;
    if ((!routeId && !routeCode) || !weekStart) {
      const response = badRequestResponse(
        "routeId or routeCode, plus weekStart, are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toDateOnly(weekStart);

    // See the matching comment in processBulkUploadJob: this narrows, but
    // doesn't eliminate, the window where this call and a concurrent bulk
    // upload/optimize for the same week each act on their own stale
    // snapshot of the roster.
    await prisma.$transaction((tx) => acquireWeekAreaLock(tx, weekStartDate));

    const route = await prisma.route.findUnique({
      where: routeId ? { id: routeId } : { routeCode },
      include: { area: true },
    });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    // Only pull schedules actually riding THIS route. The previous version
    // queried every non-cancelled schedule for the week across every route,
    // so a single reassign call would sweep up and move mismatched employees
    // that had nothing to do with this route — corrupting unrelated
    // assignments and creating duplicate/incorrect route legs.
    const schedules = await prisma.weeklySchedule.findMany({
      where: {
        routeId: route.id,
        weekStart: weekStartDate,
        status: { not: "CANCELLED" },
      },
    });

    const routeShiftNorm = normalizeShift(route.shiftTiming);
    const mismatched = schedules.filter(
      (s) => s.shiftTiming && normalizeShift(s.shiftTiming) !== routeShiftNorm,
    );

    if (!mismatched.length) {
      const response = okResponse(
        { updated: 0, routesCreated: 0, legsOpened: 0, details: [] },
        "No shift-mismatched employees found on this route — nothing to reassign.",
      );
      return res.status(response.status.code).json(response);
    }

    // Group by their (normalized) new shift timing — everyone on the same
    // new shift gets funneled through the same leg-resolution calls, so
    // they land together on one driver/route (or overflow legs of it)
    // instead of each spinning up their own route.
    const groups = new Map();
    mismatched.forEach((s) => {
      const key = normalizeShift(s.shiftTiming);
      if (!groups.has(key))
        groups.set(key, { shiftTiming: s.shiftTiming, entries: [] });
      groups.get(key).entries.push(s);
    });

    const areaRecord = route.area || null;
    const results = {
      updated: 0,
      routesCreated: 0,
      legsOpened: 0,
      details: [],
    };

    for (const { shiftTiming, entries } of groups.values()) {
      for (const entry of entries) {
        const routeResult = await findOrCreateRouteAndTrip(
          areaRecord,
          undefined, // vehicle type unknown at this point — falls back to a safe default capacity
          shiftTiming,
          undefined,
          entry.driverId || undefined,
          entry.vehicleId || undefined,
          weekStartDate,
          entry.employeeId,
        );

        if (routeResult.created) results.routesCreated++;
        if (routeResult.newTrip) results.legsOpened++;

        await prisma.weeklySchedule.update({
          where: { id: entry.id },
          data: {
            routeId: routeResult.route.id,
            tripId: routeResult.trip.id,
            driverId: routeResult.trip.driverId || entry.driverId,
            vehicleId: routeResult.trip.vehicleId || entry.vehicleId,
          },
        });

        results.updated++;
        results.details.push({
          employeeId: entry.employeeId,
          weeklyScheduleId: entry.id,
          shiftTiming,
          newRouteId: routeResult.route.id,
          newRouteCode: routeResult.route.routeCode,
          newTripId: routeResult.trip.id,
          newTripNumber: routeResult.trip.tripNumber,
        });
      }
    }

    const response = okResponse(
      results,
      `Reassigned ${results.updated} employee(s) off "${route.routeCode}" onto their correct shift's route.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Real-Time Route Optimization ----------

/**
 * Scans every ACTIVE (non-cancelled) WeeklySchedule row for a given week and
 * self-heals anything out of order:
 *   - a schedule whose driver (or vehicle) is now double-booked on a
 *     DIFFERENT route this week (e.g. because that route's driver changed
 *     underneath it) gets bumped off that resource
 *   - any schedule left without a driver and/or vehicle — whether from the
 *     above, a manual edit, or a partial bulk upload — gets one assigned
 *     through the same conflict-free + load-balanced logic used everywhere
 *     else (resolveConflictFreeAssignment / findBestAvailableDriver)
 * This is what lets assignments stay correct as data changes throughout the
 * week, instead of only being fixed the next time someone re-runs a bulk
 * upload.
 */
const optimizeWeekAssignments = async (weekStartDate) => {
  // See the matching comment in processBulkUploadJob: narrows, doesn't
  // eliminate, the window where this and a concurrent bulk upload/reassign
  // for the same week each act on their own stale snapshot of the roster.
  await prisma.$transaction((tx) => acquireWeekAreaLock(tx, weekStartDate));

  const schedules = await prisma.weeklySchedule.findMany({
    where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
    include: { route: true, trip: { include: { vehicle: true } } },
  });

  const summary = {
    scanned: schedules.length,
    driversReassigned: 0,
    vehiclesReassigned: 0,
    tripsBackfilled: 0,
    details: [],
  };

  for (const entry of schedules) {
    if (!entry.route) continue; // nothing to optimize against without a route

    // Back-compat: rows created before Trips existed have routeId but no
    // tripId. Backfill one now (reusing an existing trip on the route if it
    // has room, else opening a new one) so per-trip capacity stays accurate
    // going forward instead of these rows silently sitting outside it.
    let trip = entry.trip;
    if (!trip) {
      const backfilled = await findOrCreateTripOnRoute(
        entry.route,
        undefined,
        entry.shiftTiming || entry.route.shiftTiming,
        entry.driverId || undefined,
        entry.vehicleId || undefined,
        weekStartDate,
        entry.employeeId,
      );
      trip = backfilled.trip;
      await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: { tripId: trip.id },
      });
      summary.tripsBackfilled++;
    }

    let driverId = entry.driverId || undefined;
    let vehicleId = entry.vehicleId || undefined;
    const shiftTiming = entry.shiftTiming || entry.route.shiftTiming;

    if (driverId) {
      const conflict = await findDriverConflict(
        driverId,
        weekStartDate,
        shiftTiming,
        trip.id,
        entry.employeeId,
      );
      if (conflict) driverId = undefined;
    }
    if (vehicleId) {
      const conflict = await findVehicleConflict(
        vehicleId,
        weekStartDate,
        shiftTiming,
        trip.id,
        entry.employeeId,
      );
      if (conflict) vehicleId = undefined;
    }

    if (!driverId || !vehicleId) {
      const resolved = await resolveConflictFreeAssignment({
        trip,
        weekStartDate,
        candidateShiftTiming: shiftTiming,
        proposedDriverId: driverId,
        proposedVehicleId: vehicleId,
        vehicleTypeHint: undefined,
        excludeEmployeeId: entry.employeeId,
      });
      driverId = resolved.driverId;
      vehicleId = resolved.vehicleId;
    }

    if (
      driverId !== (entry.driverId || undefined) ||
      vehicleId !== (entry.vehicleId || undefined)
    ) {
      await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: {
          driverId: driverId || null,
          vehicleId: vehicleId || null,
          tripId: trip.id,
        },
      });
      if (driverId !== (entry.driverId || undefined))
        summary.driversReassigned++;
      if (vehicleId !== (entry.vehicleId || undefined))
        summary.vehiclesReassigned++;
      summary.details.push({
        weeklyScheduleId: entry.id,
        employeeId: entry.employeeId,
        routeId: entry.routeId,
        tripId: trip.id,
        driverId,
        vehicleId,
      });
    }
  }

  return summary;
};

/**
 * Endpoint wrapper for optimizeWeekAssignments — wire this to an "Optimize
 * now" button and/or a periodic job (cron, queue worker, etc.) for
 * continuous optimization. It's also called inline from create/update below
 * so a single edit self-heals immediately rather than waiting for the next
 * scheduled run.
 * Body: { weekStart: string }
 */
const optimizeRouteAssignments = async (req, res, next) => {
  try {
    const { weekStart } = req.body;
    if (!weekStart) {
      const response = badRequestResponse("weekStart is required.");
      return res.status(response.status.code).json(response);
    }
    const summary = await optimizeWeekAssignments(toDateOnly(weekStart));
    const response = okResponse(
      summary,
      "Route assignments optimized for the week.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- CRUD ----------

const createWeeklySchedule = async (req, res, next) => {
  try {
    const {
      weekStart,
      employeeId,
      routeId,
      tripId,
      driverId,
      vehicleId,
      serviceType,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
      pickupTime,
      shiftTiming,
      officeArrivalTime,
      dropTime,
      status,
    } = req.body;

    if (!employeeId || !weekStart) {
      const response = badRequestResponse(
        "employeeId and weekStart are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const existingSchedule = await prisma.weeklySchedule.findUnique({
      where: {
        employeeId_weekStart: {
          employeeId,
          weekStart: toDateOnly(weekStart),
        },
      },
    });

    if (existingSchedule) {
      const response = badRequestResponse(
        "Schedule already exists for this employee in this week.",
      );
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.weeklySchedule, {
      weekStart: toDateOnly(weekStart),
      employeeId,
      routeId,
      tripId,
      driverId,
      vehicleId,
      serviceType: serviceType || "PICK_AND_DROP",
      monday: monday || "BOTH",
      tuesday: tuesday || "BOTH",
      wednesday: wednesday || "BOTH",
      thursday: thursday || "BOTH",
      friday: friday || "BOTH",
      saturday: saturday || "OFF",
      sunday: sunday || "OFF",
      pickupTime,
      shiftTiming,
      officeArrivalTime,
      dropTime,
      status: status || "ACTIVE",
    });

    // Real-Time Route Optimization: don't wait for the next bulk upload to
    // fill in / fix driver-vehicle assignments touched by this change.
    if (routeId) {
      try {
        await optimizeWeekAssignments(toDateOnly(weekStart));
      } catch (optimizeError) {
        // Optimization is best-effort — a failure here shouldn't fail the
        // create that already succeeded.
      }
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllWeeklySchedules = async (req, res, next) => {
  try {
    const {
      skip = 0,
      take = 10,
      employeeId,
      status,
      weekStart,
      routeId,
      search,
    } = req.query;

    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (routeId) where.routeId = routeId;
    if (status) where.status = status;

    // FIX: exact-timestamp match silently returned nothing whenever weekStart
    // carried any time component. Use a day range instead.
    if (weekStart) {
      const startDate = toDateOnly(weekStart);
      const nextDay = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      where.weekStart = { gte: startDate, lt: nextDay };
    }

    if (search) {
      where.OR = [
        { employee: { name: { contains: search, mode: "insensitive" } } },
        {
          employee: { employeeCode: { contains: search, mode: "insensitive" } },
        },
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        {
          vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } },
        },
      ];
    }

    const options = {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            contactNumber: true,
          },
        },
        // FIX: previously selected only a handful of route fields (no
        // shiftTiming/serviceType/status/officeLocation), so the list view
        // had a routeId but nothing to actually display for "Route" beyond
        // its name/code. Now returns the full route record.
        route: {
          include: {
            area: true,
            subArea: true,
            driver: { select: { id: true, name: true, phone: true } },
          },
        },
        // Trip Number / per-trip vehicle so the list view can show which
        // specific vehicle run (not just which route) an employee is on —
        // previously omitted here, so tripId was being written on every row
        // but never came back out of this endpoint. Also now returns the
        // trip's own shiftTiming/status (it can override the route's).
        trip: {
          include: {
            vehicle: {
              select: {
                id: true,
                vehicleNumber: true,
                type: true,
                capacity: true,
                status: true,
              },
            },
            driver: {
              select: { id: true, name: true, phone: true, status: true },
            },
          },
        },
        // Denormalized driver/vehicle directly on the schedule row (see
        // schema comment on WeeklySchedule.driverId/vehicleId) — kept as a
        // fallback for rows saved before tripId existed, or wherever the
        // trip's own driver/vehicle wasn't carried over.
        driver: {
          select: { id: true, name: true, phone: true, status: true },
        },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
            type: true,
            capacity: true,
            status: true,
          },
        },
        vendor: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ weekStart: "desc" }, { route: { routeCode: "asc" } }],
    };

    const response = await getRecords(prisma.weeklySchedule, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getWeeklyScheduleById = async (req, res, next) => {
  try {
    const { id } = req.params;

    // FIX: getRecordById returns a wrapped { status, data } object rather
    // than null on a miss, so `if (!response)` never triggered. Check the
    // raw record first instead, matching the pattern used below.
    const schedule = await prisma.weeklySchedule.findUnique({ where: { id } });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await getRecordById(prisma.weeklySchedule, id, {
      employee: true,
      route: true,
      trip: { include: { vehicle: true, driver: true } },
      driver: true,
      vehicle: true,
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateWeeklySchedule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    if (updateData.weekStart) {
      updateData.weekStart = toDateOnly(updateData.weekStart);
    }

    const schedule = await prisma.weeklySchedule.findUnique({ where: { id } });
    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await updateRecord(prisma.weeklySchedule, id, updateData, {
      employee: true,
      route: true,
      trip: { include: { vehicle: true, driver: true } },
      driver: true,
      vehicle: true,
    });

    // Real-Time Route Optimization: a route/driver/vehicle change on one
    // schedule can free up or double-book a resource for others on the same
    // week, so re-scan the week whenever one of those fields moved.
    const touchesAssignment = [
      "routeId",
      "tripId",
      "driverId",
      "vehicleId",
    ].some((f) => f in updateData);
    if (touchesAssignment) {
      try {
        await optimizeWeekAssignments(
          updateData.weekStart || schedule.weekStart,
        );
      } catch (optimizeError) {
        // Best-effort — don't fail an already-successful update.
      }
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteWeeklySchedule = async (req, res, next) => {
  try {
    const { id } = req.params;

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { id },
    });

    if (!schedule) {
      const errorResponse = badRequestResponse("Weekly schedule not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.weeklySchedule, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getCurrentWeekSchedules = async (req, res, next) => {
  try {
    const now = new Date();
    const utcToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // weekStart is always a Monday (see schema). Convert Sunday=0..Saturday=6
    // into "days since Monday" so this lines up with every other Monday-based
    // weekStart in the app (e.g. the frontend's own default-week-start calc),
    // instead of the previous Sunday-based start which pointed at the wrong
    // week entirely whenever this ran on a Sunday.
    const daysSinceMonday = (utcToday.getUTCDay() + 6) % 7;
    const startOfWeek = new Date(
      utcToday.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000,
    );

    const schedules = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: {
          gte: startOfWeek,
          lt: new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
        status: "ACTIVE",
      },
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
        route: true,
        trip: { include: { vehicle: true, driver: true } },
        driver: true,
        vehicle: true,
      },
    });

    const response = okResponse(
      schedules,
      "Current week schedules retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeScheduleRange = async (req, res, next) => {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;

    const where = { employeeId };

    if (startDate && endDate) {
      where.weekStart = {
        gte: toDateOnly(startDate),
        lte: toDateOnly(endDate),
      };
    }

    const schedules = await prisma.weeklySchedule.findMany({
      where,
      include: {
        route: true,
        trip: { include: { vehicle: true, driver: true } },
        driver: true,
        vehicle: true,
      },
      orderBy: { weekStart: "desc" },
    });

    const response = okResponse(
      schedules,
      "Employee schedule range retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- New: grouped view + stats to power the Weekly Timetable UI ----------

/**
 * Returns schedules grouped as: route -> weeks -> employee rows.
 * This is the shape the Weekly Timetable frontend renders directly.
 *
 * Query params:
 *   weeks   - how many distinct recent weeks to include (default 3)
 *   search  - filters employee/route/driver/vehicle by name/code
 *   routeId - restrict to a single route
 */
const getGroupedSchedules = async (req, res, next) => {
  try {
    const { weeks = 3, search, routeId } = req.query;

    const where = {};
    if (routeId) where.routeId = routeId;
    if (search) {
      where.OR = [
        { employee: { name: { contains: search, mode: "insensitive" } } },
        {
          employee: { employeeCode: { contains: search, mode: "insensitive" } },
        },
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        {
          vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } },
        },
      ];
    }

    // Pull only the N most recent distinct weekStarts, then filter to those.
    const distinctWeeks = await prisma.weeklySchedule.findMany({
      where,
      distinct: ["weekStart"],
      orderBy: { weekStart: "desc" },
      take: parseInt(weeks),
      select: { weekStart: true },
    });
    const weekStarts = distinctWeeks.map((w) => w.weekStart);

    const schedules = await prisma.weeklySchedule.findMany({
      where: { ...where, weekStart: { in: weekStarts } },
      include: {
        employee: { select: { id: true, name: true, employeeCode: true } },
        route: {
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            area: true,
            shiftTiming: true,
            maxCapacity: true,
            driver: { select: { id: true, name: true } },
          },
        },
        // Trip Number / per-trip capacity for the weekly schedule display
        // (requirement 7). Rows created before Trips existed simply have no
        // trip, and fall back to route-level capacity below.
        trip: {
          select: {
            id: true,
            tripNumber: true,
            vehicle: {
              select: { id: true, vehicleNumber: true, capacity: true },
            },
          },
        },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
      orderBy: [{ weekStart: "desc" }, { employee: { name: "asc" } }],
    });

    // route -> week -> rows
    const routeMap = new Map();

    for (const s of schedules) {
      const routeKey = s.route?.id ?? "unassigned";
      if (!routeMap.has(routeKey)) {
        routeMap.set(routeKey, {
          code: s.route?.routeCode ?? "—",
          name: s.route?.routeName ?? "Unassigned Route",
          area: s.route?.area ?? "",
          // Use the ROUTE's own canonical shiftTiming — the same field
          // reassignMismatchedShiftEmployees compares against — not an
          // arbitrary schedule row's shiftTiming. Using a schedule row's
          // value here caused the frontend to flag/clear "mismatches" that
          // didn't agree with what the reassign endpoint actually checks,
          // so reassign would report 0 updates even when the UI showed
          // mismatched employees.
          shift: s.route?.shiftTiming ?? s.shiftTiming ?? "",
          service: s.serviceType,
          // Prefer the driver assigned to the ROUTE itself (Route.driverId)
          // since that's the actual source of truth per-route; fall back to
          // this particular schedule row's driver if the route has none.
          driverBadge: s.route?.driver?.name ?? s.driver?.name ?? "—",
          vehicleBadge: s.vehicle?.vehicleNumber ?? "—",
          // Route.maxCapacity is the aggregate across all trips (kept in
          // sync by route_controller.syncRouteFromTrips). Falls back to 0
          // (displayed as "—") for legacy routes with no capacity set.
          capacity: s.route?.maxCapacity ?? null,
          // tripId -> { tripNumber, capacity, empIds } so multi-trip routes
          // can show per-trip assigned/remaining, not just a route total.
          tripMap: new Map(),
          empIds: new Set(),
          weekMap: new Map(),
        });
      }
      const routeEntry = routeMap.get(routeKey);
      routeEntry.empIds.add(s.employeeId);

      if (s.tripId) {
        // Just count riders per trip here — the Trip's own existence,
        // driver, vehicle, and capacity come authoritatively from the
        // direct Trip query below (tripsByRoute), not from this row.
        if (!routeEntry.tripMap.has(s.tripId)) {
          routeEntry.tripMap.set(s.tripId, { empIds: new Set() });
        }
        routeEntry.tripMap.get(s.tripId).empIds.add(s.employeeId);
      }

      const weekKey = formatDateOnly(s.weekStart);
      if (!routeEntry.weekMap.has(weekKey)) {
        routeEntry.weekMap.set(weekKey, { weekOf: weekKey, rows: [] });
      }

      routeEntry.weekMap.get(weekKey).rows.push({
        id: s.id,
        empId: s.employee?.employeeCode ?? s.employeeId,
        name: s.employee?.name ?? "Unknown",
        area: s.route?.area ?? "",
        shift: s.shiftTiming ?? "",
        service: s.serviceType,
        pick: s.pickupTime ?? "-",
        arrival: s.officeArrivalTime ?? "-",
        drop: s.dropTime ?? "-",
        driver: s.driver?.name ?? "-",
        vehicle: s.vehicle?.vehicleNumber ?? "-",
        // Trip Number, shown only for routes running more than one trip —
        // requirement 7 ("Trip Number (if multiple trips exist)").
        tripNumber: s.trip?.tripNumber ?? null,
        pattern: DAY_KEYS.map((day) => s[day] ?? "OFF"),
        status: (s.status ?? "ACTIVE").toLowerCase(),
      });
    }

    // FIX: previously every route's `trips` list here was built ONLY from
    // WeeklySchedule rows that happened to carry a non-null tripId (see the
    // `if (s.trip)` block below). A Route + Trip can be created correctly
    // by bulk upload — with a real driver/vehicle on the Trip — and STILL
    // show up as "no trip configured" on the frontend if any of its
    // schedule rows lack a tripId (locked rows, legacy rows, manual
    // creates via createWeeklySchedule where the caller didn't pass one).
    // Trip is the source of truth for "does this route have a configured
    // trip", not WeeklySchedule.tripId, so we now query Trip directly for
    // every route in this response and seed tripMap from that — a trip
    // with zero riders still shows up, with its real driver/vehicle.
    const routeIdsForTrips = Array.from(routeMap.keys()).filter(
      (k) => k !== "unassigned",
    );
    const tripsByRoute = routeIdsForTrips.length
      ? await prisma.trip.findMany({
          // Same enum fix as syncRouteFromTrips/findOrCreateTripOnRoute —
          // Trip.status is RouteStatus (ACTIVE | INACTIVE), no CANCELLED.
          where: { routeId: { in: routeIdsForTrips }, status: "ACTIVE" },
          include: {
            vehicle: {
              select: { id: true, vehicleNumber: true, capacity: true },
            },
            driver: { select: { id: true, name: true } }, // NOTE: verify Trip.driver relation name matches schema.prisma
          },
          orderBy: { tripNumber: "asc" },
        })
      : [];
    for (const t of tripsByRoute) {
      const routeEntry = routeMap.get(t.routeId);
      if (!routeEntry) continue;
      // Merge onto whatever rider-count entry the schedule-row pass already
      // created for this tripId (if any) — Trip data always overwrites the
      // metadata fields, riders (empIds) are kept as already counted.
      const existingRiders = routeEntry.tripMap.get(t.id)?.empIds ?? new Set();
      routeEntry.tripMap.set(t.id, {
        tripNumber: t.tripNumber,
        capacity: t.vehicle?.capacity ?? null,
        driverName: t.driver?.name ?? null,
        vehicleNumber: t.vehicle?.vehicleNumber ?? null,
        empIds: existingRiders,
      });
    }

    const routes = Array.from(routeMap.values()).map((r) => {
      const trips = Array.from(r.tripMap.values())
        .filter((t) => t.tripNumber != null) // drop placeholders whose Trip is missing/cancelled
        .sort((a, b) => a.tripNumber - b.tripNumber)
        .map((t) => ({
          tripNumber: t.tripNumber,
          capacity: t.capacity,
          driver: t.driverName ?? "—",
          vehicle: t.vehicleNumber ?? "—",
          assignedEmployees: t.empIds.size,
          remainingSeats:
            t.capacity != null ? Math.max(t.capacity - t.empIds.size, 0) : null,
        }));

      // Route.driverId can be stale/unset on legacy rows; fall back to the
      // first real trip's driver/vehicle so the badge matches what
      // bulk-upload actually configured, instead of showing "—" even when
      // trip 1 has a driver assigned.
      const firstTrip = Array.from(r.tripMap.values())
        .filter((t) => t.tripNumber != null)
        .sort((a, b) => a.tripNumber - b.tripNumber)[0];

      return {
        code: r.code,
        name: r.name,
        area: r.area,
        shift: r.shift,
        service: r.service,
        driverBadge:
          r.driverBadge !== "—"
            ? r.driverBadge
            : (firstTrip?.driverName ?? "—"),
        vehicleBadge:
          r.vehicleBadge !== "—"
            ? r.vehicleBadge
            : (firstTrip?.vehicleNumber ?? "—"),
        empCount: r.empIds.size,
        // Requirement 7: Vehicle Capacity + Remaining Available Seats at the
        // route level (aggregate across trips), plus a per-trip breakdown
        // (with Trip Number) whenever the route runs more than one trip.
        capacity: r.capacity,
        remainingSeats:
          r.capacity != null ? Math.max(r.capacity - r.empIds.size, 0) : null,
        multiTrip: trips.length > 1,
        trips,
        weeks: Array.from(r.weekMap.values()).sort((a, b) =>
          b.weekOf.localeCompare(a.weekOf),
        ),
      };
    });

    const response = okResponse(
      routes,
      "Grouped weekly schedules retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * Returns the four stat-card figures the Weekly Timetable header shows:
 * total entries, active routes, distinct weeks on file, distinct employees.
 */
const getScheduleStats = async (req, res, next) => {
  try {
    const totalEntries = await prisma.weeklySchedule.count();

    const [activeRoutesResult, weeksOnFileResult, employeesResult] =
      await Promise.all([
        prisma.$queryRaw`SELECT COUNT(DISTINCT "routeId") as count FROM "WeeklySchedule" WHERE "status" = 'ACTIVE'`,
        prisma.$queryRaw`SELECT COUNT(DISTINCT "weekStart") as count FROM "WeeklySchedule"`,
        prisma.$queryRaw`SELECT COUNT(DISTINCT "employeeId") as count FROM "WeeklySchedule"`,
      ]);

    const activeRoutes = Number(activeRoutesResult[0]?.count ?? 0);
    const weeksOnFile = Number(weeksOnFileResult[0]?.count ?? 0);
    const employees = Number(employeesResult[0]?.count ?? 0);

    const response = okResponse(
      {
        totalEntries,
        activeRoutes,
        weeksOnFile,
        employees,
      },
      "Schedule stats retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- New: Schedule Table (grouped by Area) to power the Schedule UI ----------

/**
 * Returns the four stat-card figures the Schedule page header shows:
 * active employees, total areas, available drivers, active vehicles.
 */
const getScheduleTableStats = async (req, res, next) => {
  try {
    const [activeEmployees, areasCount, availableDrivers, activeVehicles] =
      await Promise.all([
        prisma.employee.count({ where: { status: "ACTIVE" } }),
        prisma.area.count(),
        prisma.driver.count({ where: { status: "AVAILABLE" } }),
        prisma.vehicle.count({ where: { status: "ACTIVE" } }),
      ]);

    const response = okResponse(
      {
        activeEmployees,
        areas: areasCount,
        availableDrivers,
        activeVehicles,
      },
      "Schedule table stats retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * Returns active employees grouped by Area, shaped exactly for the
 * Schedule Table UI: area -> { employeeCount, rows[] }.
 *
 * Query params:
 *   search - filters by employee name/code, area name, or department name
 *   areaId - restrict to a single area
 */
const getScheduleTableGroupedByArea = async (req, res, next) => {
  try {
    const { search, areaId } = req.query;

    const where = { status: "ACTIVE" };
    if (areaId) where.areaId = areaId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { employeeCode: { contains: search, mode: "insensitive" } },
        { area: { name: { contains: search, mode: "insensitive" } } },
        { department: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const employees = await prisma.employee.findMany({
      where,
      include: {
        area: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
    });

    // group employees by area
    const areaMap = new Map();

    for (const emp of employees) {
      const areaKey = emp.area?.id ?? "unassigned";
      if (!areaMap.has(areaKey)) {
        areaMap.set(areaKey, {
          areaId: emp.area?.id ?? null,
          area: emp.area?.name ?? "Unassigned",
          rows: [],
        });
      }

      areaMap.get(areaKey).rows.push({
        id: emp.id,
        empId: emp.employeeCode,
        name: emp.name,
        department: emp.department?.name ?? "-",
        location: emp.officeLocation ?? "-",
        entity: emp.entity ?? "-",
        shift: emp.shiftTiming ?? null,
        service: emp.serviceType,
        contact: emp.contactNumber ?? "-",
      });
    }

    const groups = Array.from(areaMap.values()).map((g) => ({
      ...g,
      employeeCount: g.rows.length,
    }));

    const response = okResponse(
      groups,
      "Schedule table grouped by area retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- New: Bulk upload weekly schedule from an XLSX sheet ----------

/**
 * Accepts a multipart/form-data upload:
 *   - file:      the .xlsx file (field name "file", parsed into req.file by multer)
 *   - weekStart: the Monday this schedule applies to (the sheet itself doesn't
 *                encode a date per row — the whole sheet represents one week)
 *
 * For each data row:
 *   1. Finds the Employee by "Employee ID" (employeeCode) in the seeded
 *      master employee data — never creates one. Not found = row skipped
 *      and counted in results.employeesNotFound.
 *   2. Finds the Driver and Vendor by name in their own seeded master
 *      data — never created either. A row can still be saved without a
 *      match (as DRAFT, missing driver/vendor); see below.
 *   3. Finds/creates the Route from the matched employee's own Area
 *      (master data, not the sheet's Area column) + Vehicle Type + Shift
 *      Timing (the sheet has no explicit Route column, so employees
 *      sharing all three of these are treated as riding the same route).
 *      Route/Trip are the only things this job still creates on the fly
 *      — they're genuinely dynamic week to week, unlike Employee/Driver/
 *      Vehicle/Vendor.
 *   4. Derives serviceType from the "Drop"/"Pick" text sometimes found in the
 *      time columns, and OFF days from the "Off Day" column.
 *   5. Upserts (create or update) the WeeklySchedule for that employee + week.
 *
 * Rows that repeat the header (the sheet has several duplicate header rows)
 * or have a non-numeric Employee ID are silently skipped. Rows that fail for
 * another reason (bad data, DB error) are recorded in `skipped` rather than
 * aborting the whole import.
 *
 * NOTE on vehicles: every seeded Driver already has a Vehicle paired 1:1
 * to it (prisma/seed.js) — this job just reads that pairing
 * (driver.vehicle) instead of ever creating a vehicle itself. If the
 * sheet's Vehicle Reg column names a DIFFERENT plate than the driver's
 * own (a genuine this-week reassignment), that plate is looked up — but
 * only used if it's found in the master data; otherwise the driver's own
 * vehicle is kept and a note is left on the row.
 */
// ---------- Bulk Upload Job Tracking (progress + status polling) ----------
//
// WHY THIS EXISTS: a bulk upload used to be one long synchronous HTTP
// request. For a few hundred rows, each with ~15-25 sequential DB round
// trips (employee/driver/vendor/vehicle lookups, route/trip resolution,
// conflict checks, working-hours checks), that request could easily run
// past a minute — often past the browser/proxy's request timeout. The
// caller then saw a generic network error with NO indication of whether
// anything actually got written, because the server kept processing rows
// after the client had already given up and closed the connection.
//
// FIX: the HTTP handler now only PARSES the file and hands the row
// processing off to a background job. It responds immediately with a
// jobId, and the frontend polls GET /bulk-upload-status/:jobId for
// progress (rows processed / total) and, once done, the final
// created/updated/skipped summary — so the user always knows whether it
// succeeded, is still running, or failed, and roughly how far along it is.
//
// NOTE: this job store is in-memory (a plain Map), which is fine for a
// single server instance. If this API ever runs multiple instances behind
// a load balancer, move this to Redis (or similar) so a status poll can't
// land on an instance that never processed the job.
const bulkUploadJobs = new Map();
const BULK_UPLOAD_JOB_TTL_MS = 30 * 60 * 1000; // sweep finished jobs after 30 min

// Row-count bounds for the `batchSize` API param — keeps a caller from
// passing 1 (near-infinite yields) or 100000 (defeats the point of
// batching) on a very large workbook.
const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 100;

const createBulkUploadJob = (totalRows, batchSize, weekStartDate) => {
  // Sweep old finished jobs opportunistically so the Map doesn't grow
  // unbounded on a long-running server.
  const cutoff = Date.now() - BULK_UPLOAD_JOB_TTL_MS;
  for (const [id, job] of bulkUploadJobs) {
    if (job.status !== "processing" && job.startedAt < cutoff) {
      bulkUploadJobs.delete(id);
    }
  }

  // GUARD: refuse to start a second concurrent upload for the SAME week.
  // Two jobs racing on the same weekStart both load "what's already
  // scheduled this week" into their own in-memory cache at ~the same
  // moment, both see nothing there yet for a given employee, and both try
  // to write/create the same WeeklySchedule (and sometimes the same new
  // Route) at once — one write wins, the other throws a duplicate-key
  // error and that row ends up in `skipped`. Rejecting the second request
  // outright (rather than letting them race) is what actually prevents
  // this, instead of just making it less likely.
  const weekKey = weekStartDate.toISOString();
  const conflicting = Array.from(bulkUploadJobs.values()).find(
    (job) => job.status === "processing" && job.weekKey === weekKey,
  );
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.jobId };
  }

  const jobId = `bulkupload_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  bulkUploadJobs.set(jobId, {
    jobId,
    weekKey,
    status: "processing", // "processing" | "done" | "failed"
    totalRows,
    processedRows: 0,
    batchSize,
    totalBatches: totalRows ? Math.ceil(totalRows / batchSize) : 0,
    batchesCompleted: 0,
    startedAt: Date.now(),
    // Snapshot of the results-so-far, refreshed after every batch (not just
    // at the end) so a client polling mid-run can show live counts —
    // "312 assigned, 4 skipped" while it's still going — instead of only
    // finding out anything at all once status flips to "done".
    partialResult: null,
    result: null,
    error: null,
  });
  return { conflict: false, jobId };
};

const updateBulkUploadJob = (jobId, patch) => {
  const job = bulkUploadJobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
};

/**
 * GET /weekly-schedule/bulk-upload-status/:jobId
 * Polled by the frontend's progress bar. Returns 0-100 percent plus the
 * final result payload once status is "done" (or the error once "failed"),
 * so the UI can always show an accurate success/failure state instead of
 * guessing from a dropped connection. While still "processing", `result`
 * carries the same-shaped partial tally accumulated so far (see
 * partialResult on the job), so the UI isn't blind until the very end.
 */
const getBulkUploadStatus = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const job = bulkUploadJobs.get(jobId);
    if (!job) {
      const response = badRequestResponse(
        "Unknown or expired upload job id. If the upload was large, it may still be worth checking the schedule directly.",
      );
      return res.status(response.status.code).json(response);
    }

    const percent = job.totalRows
      ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100))
      : job.status === "done"
        ? 100
        : 0;

    const response = okResponse(
      {
        jobId,
        status: job.status,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
        batchSize: job.batchSize,
        totalBatches: job.totalBatches,
        batchesCompleted: job.batchesCompleted,
        percent,
        result: job.status === "done" ? job.result : job.partialResult,
        error: job.status === "failed" ? job.error : null,
      },
      "Bulk upload job status.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * Does the actual row-by-row processing for a bulk upload, running AFTER
 * the HTTP response has already gone back to the client with a jobId. Every
 * lookup that's likely to repeat across rows (employee, driver, vendor,
 * vehicle, a given area's routes) goes through the `caches` object so a
 * sheet with, say, 300 rows but only 8 distinct drivers doesn't pay for
 * 300 driver lookups — see findEmployee/findDriver/findVendor/
 * findVehicleByReg and findOrCreateRouteAndTrip above.
 *
 * OPTIMIZATION: Employee/Driver/Vehicle/Vendor are all seeded master data
 * now (prisma/seed.js, prisma/seed-employees.js) — this job only ever
 * LOOKS UP those four, it never creates them anymore. Only Route/Trip
 * (which are legitimately dynamic week to week) still get created here.
 * A row whose employee code, driver name, or vendor name doesn't match
 * the master data is counted in results.employeesNotFound/driversNotFound/
 * vendorsNotFound and (for employee) skipped outright — see below.
 */
const processBulkUploadJob = async (
  jobId,
  workbook,
  weekStartDate,
  batchSize = DEFAULT_BATCH_SIZE,
) => {
  const results = {
    created: 0,
    updated: 0,
    // Rows whose employeeCode / driver name / vehicle plate didn't match
    // anything in the seeded master data — surfaced explicitly instead of
    // silently creating throwaway records for them (see findEmployee/
    // findDriver/findVehicleByReg above). Fix these at the source (master
    // data or the sheet) rather than re-uploading and hoping.
    employeesNotFound: 0,
    driversNotFound: 0,
    vendorsNotFound: 0,
    routesCreated: 0,
    routeLegsOpenedForOverflow: 0,
    driversAutoAssigned: 0,
    vehiclesAutoAssigned: 0,
    conflictsResolved: 0,
    // Rows saved as DRAFT because no conflict-free driver and/or vehicle
    // could be found — see the missingDriver/missingVehicle check below.
    // Surfaced separately from `created`/`updated` so a batch that "succeeded"
    // but left people unstaffed is obvious in the summary, not hidden inside
    // a generic success count.
    pendingAssignment: 0,
    skipped: [],
    notes: [],
    sheetsProcessed: [],
    sheetsSkipped: [],
  };

  // Pre-load everything the per-row conflict/assignment checks need ONCE,
  // up front, instead of letting findDriverConflict / findVehicleConflict /
  // findBestAvailableDriver / findBestAvailableVehicle / checkDriverWorkingHours
  // each hit the DB fresh for every row (see the big comment above on why
  // that made the whole job O(rows^2)). weekRoster/availableDrivers/
  // activeVehicles/driverById below are exactly the caches those functions
  // already know how to use — they just weren't being built or passed in.
  // FIX: acquireWeekAreaLock existed in this file but was never actually
  // called anywhere — a lock defined for exactly this situation (two
  // concurrent writers targeting the same week) sitting unused. Without
  // it, two bulk-upload jobs kicked off for the same weekStart at close to
  // the same instant each build their OWN in-memory snapshot of
  // roster/driver/vehicle state (caches.weekRoster etc. below) from
  // whatever the DB looked like at that moment, then run their
  // capacity/conflict checks against that private snapshot for the rest of
  // the job — neither one sees the other's writes. That's how a trip ends
  // up overbooked or a driver double-booked despite the per-row conflict
  // checks: the checks are correct, but they're checking against a
  // snapshot the other job has already invalidated.
  //
  // IMPORTANT — what this DOES and DOESN'T fix: this acquires and releases
  // the lock in a short transaction right here, before the snapshot reads
  // below. That serializes job STARTS for the same week — two jobs can no
  // longer build their initial snapshots at the literal same instant — but
  // it does NOT hold the lock for the rest of this (potentially
  // multi-minute) job. A second job could still start seconds later, once
  // this one has released the lock, and run concurrently with it for the
  // remainder. Deliberately not holding the lock for the whole job: doing
  // that would mean keeping one DB connection checked out for the job's
  // entire duration, which trades this race for a worse, guaranteed
  // problem (starving the connection pool, holding locks against
  // unrelated requests). The real fix for FULL concurrent-upload safety is
  // serializing job execution per weekStart at the queue level (e.g. a
  // job-queue concurrency limit), not a longer-held DB lock — this line is
  // a cheap, safe narrowing of the window, not a complete guarantee.
  await prisma.$transaction((tx) => acquireWeekAreaLock(tx, weekStartDate));

  const [existingWeekRoster, availableDriversList, activeVehiclesList] =
    await Promise.all([
      prisma.weeklySchedule.findMany({
        where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
        include: { route: true },
      }),
      prisma.driver.findMany({
        where: { status: "AVAILABLE" },
        include: { vehicle: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.vehicle.findMany({ where: { status: "ACTIVE" } }),
    ]);

  const caches = {
    employee: new Map(),
    driver: new Map(),
    vendor: new Map(),
    vehicle: new Map(),
    routesByArea: new Map(),
    // FIX (perf): trips-per-route and the route record itself were being
    // re-fetched from the DB on every single row that touched a given
    // route (see findOrCreateTripOnRoute / findOrCreateRouteAndTrip) —
    // these two caches let a route hit hundreds of times in one workbook
    // (the normal case; rows are usually clustered by area/shift) pay for
    // that lookup once instead of once per row.
    tripsByRoute: new Map(),
    routeById: new Map(),
    weekRoster: existingWeekRoster,
    availableDrivers: availableDriversList,
    activeVehicles: activeVehiclesList,
    driverById: new Map(availableDriversList.map((d) => [d.id, d])),
    // O(1) "does this employee already have a schedule row this week"
    // lookup, seeded from the same existingWeekRoster query above and kept
    // current as rows are written (see the create/update block below).
    // Previously this was a fresh `prisma.weeklySchedule.findUnique` PER
    // ROW — on a 1,600-row workbook that's 1,600 extra round trips on top
    // of everything else, for data we'd already pulled once at job start.
    scheduleByEmployeeId: new Map(
      existingWeekRoster.map((r) => [r.employeeId, r]),
    ),
  };

  // Cumulative across every sheet — this is what the status endpoint's
  // "processedRows" reflects, matched against the "totalRows" the outer
  // handler pre-counted before responding with the jobId.
  let processedCount = 0;
  let batchesCompleted = 0;

  // Records a skipped row both in the result payload AND the persistent
  // exception queue — previously logScheduleException was defined but
  // never called, so skipped rows only ever lived in the transient
  // response payload and were lost the moment the request finished.
  const skipRow = async (sheetName, rowNum, employeeCode, reason, rawData) => {
    results.skipped.push({
      sheet: sheetName,
      row: rowNum,
      employeeCode,
      reason,
    });
    await logScheduleException(prisma, {
      weekStart: weekStartDate,
      employeeCode,
      rowNumber: rowNum,
      reason: `[${sheetName}] ${reason}`,
      rawData,
    });
  };

  // ---------- Pass 1: parse every sheet ONCE, and bulk-prefetch employees ----------
  //
  // Previously each row triggered its OWN `prisma.employee.findUnique` —
  // for a sheet with 1,600 distinct employee codes (the normal case; codes
  // are rarely repeated) that's 1,600 more round trips. Parse every sheet
  // up front, collect every candidate Employee ID across ALL sheets, and
  // fetch them in a SINGLE `findMany(... in: [...])` call instead. Sheets
  // are only ~1-2MB of JSON in memory even at 1,600+ rows, so doing this
  // parse pass twice (once here, once implicitly via the cached
  // `parsedSheets` below) costs nothing compared to the DB round trips it
  // removes.
  const parsedSheets = [];
  const allEmployeeCodes = new Set();
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const headerRowIndex = rows.findIndex((r) =>
      r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
    );
    if (headerRowIndex === -1) {
      results.sheetsSkipped.push({
        sheet: sheetName,
        reason: "No 'Employee ID' header found.",
      });
      continue;
    }
    results.sheetsProcessed.push(sheetName);

    const colIndex = {};
    rows[headerRowIndex].forEach((cell, i) => {
      const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
      if (key) colIndex[key] = i;
    });

    const dataRows = rows.slice(headerRowIndex + 1);
    const empCodeCol = colIndex.employeeCode;
    for (const raw of dataRows) {
      const code =
        empCodeCol !== undefined ? String(raw[empCodeCol] ?? "").trim() : "";
      if (code && /^\d+$/.test(code)) allEmployeeCodes.add(code);
    }

    parsedSheets.push({ sheetName, colIndex, dataRows, headerRowIndex });
  }

  if (allEmployeeCodes.size) {
    // include area/subArea/block: this job now sources routing area from
    // the employee's own master-data address instead of re-deriving it
    // from the sheet's Area column — see findEmployee's doc comment.
    const existingEmployees = await prisma.employee.findMany({
      where: { employeeCode: { in: Array.from(allEmployeeCodes) } },
      include: { area: true, subArea: true, block: true },
    });
    for (const emp of existingEmployees)
      caches.employee.set(emp.employeeCode, emp);
  }

  // ---------- Pass 2: process each row (creates/writes only from here on) ----------
  for (const {
    sheetName,
    colIndex,
    dataRows,
    headerRowIndex,
  } of parsedSheets) {
    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i];
      const rowNum = headerRowIndex + i + 2; // 1-indexed sheet row, for error messages
      const get = (key) =>
        colIndex[key] !== undefined
          ? String(raw[colIndex[key]] ?? "").trim()
          : "";

      const employeeCode = get("employeeCode");
      // Skip blank rows and the sheet's repeated header rows (Employee ID isn't numeric there).
      if (!employeeCode || !/^\d+$/.test(employeeCode)) continue;

      try {
        // OPTIMIZATION: employee/driver/vendor/vehicle are seeded master
        // data now — find-only, never created here. See findEmployee/
        // findDriver/findVendor/findVehicleByReg above for why.
        const employee = await findEmployee(employeeCode, caches);
        if (!employee) {
          results.employeesNotFound++;
          await skipRow(
            sheetName,
            rowNum,
            employeeCode,
            `Employee code ${employeeCode} not found in the master employee data — add them via the employee seed first, or check for a typo in this sheet.`,
            raw,
          );
          continue;
        }

        // A row can list more than one driver (e.g. "Tariq 03043160572Shahrukh
        // 03192121756"). WeeklySchedule only stores a single driverId, so
        // only the first NAMED driver that actually matches the master
        // Driver data is used; any name on the row that doesn't match
        // anyone is reported, not silently dropped.
        const driverEntries = parseDriverEntries(get("drivers"));
        let driverId;
        let driverRecord;
        for (let d = 0; d < driverEntries.length; d++) {
          const driver = await findDriver(
            driverEntries[d].name,
            caches.driver,
            caches,
          );
          if (!driver) {
            results.driversNotFound++;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Driver "${driverEntries[d].name}" not found in the master driver data — not assigned. Add them via the driver seed, or fix the name if it's a typo.`,
            });
            continue;
          }
          if (!driverId) {
            driverId = driver.id;
            driverRecord = driver;
          }
        }

        const vendorName = get("vendor");
        let vendorId;
        if (vendorName) {
          const vendor = await findVendor(vendorName, caches.vendor);
          if (vendor) {
            vendorId = vendor.id;
          } else {
            results.vendorsNotFound++;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Vendor "${vendorName}" not found in the master vendor data — left unassigned.`,
            });
          }
        }

        // Area now comes from the employee's own master-data address
        // (already loaded via findEmployee's include) rather than the
        // sheet's own Area column — see findOrCreateRouteAndTrip's doc
        // comment for why. The sheet's Area/Vehicle Type/Shift Timing
        // columns are still used for vehicle-type/shift matching, which
        // genuinely can vary week to week.
        const areaRecord = employee.area || null;
        const vehicleType = get("vehicleType");
        const shiftTiming = get("shiftTiming");

        // Vehicle: prefer whatever's already paired to the matched driver
        // (seeded 1:1 — see prisma/seed.js) since that's the normal case.
        // Only look up a DIFFERENT vehicle when the sheet explicitly names
        // a plate that isn't the driver's own — a genuine this-week
        // reassignment — and only if that plate actually exists in the
        // master data.
        const vehicleReg = get("vehicleReg");
        let vehicleId = driverRecord?.vehicle?.id;
        if (vehicleReg) {
          const vehicle = await findVehicleByReg(vehicleReg, caches.vehicle);
          if (vehicle) {
            vehicleId = vehicle.id;
          } else {
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Vehicle "${vehicleReg}" not found in the master vehicle data — kept this driver's own paired vehicle instead.`,
            });
          }
        }
        const campaign = get("campaign") || get("batch");

        let route;
        let trip;
        let routeCreated = false;
        try {
          const routeResult = await findOrCreateRouteAndTrip(
            areaRecord,
            vehicleType,
            shiftTiming,
            campaign,
            driverId,
            vehicleId,
            weekStartDate,
            employee.id,
            caches,
          );
          route = routeResult.route;
          trip = routeResult.trip;
          routeCreated = routeResult.created;
          if (routeCreated) results.routesCreated++;
          if (routeResult.newTrip) {
            results.routeLegsOpenedForOverflow++;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Area/shift was at capacity — opened Trip #${trip.tripNumber} on route "${route.routeCode}" for this driver.`,
            });
          }
          // Verification: a routeId AND tripId must exist on every row from here on.
          if (!route?.id || !trip?.id) {
            await skipRow(
              sheetName,
              rowNum,
              employeeCode,
              "Route/Trip could not be created/found even with fallback — check Route/Trip model required fields.",
              raw,
            );
            continue;
          }
        } catch (routeError) {
          await skipRow(
            sheetName,
            rowNum,
            employeeCode,
            `Route/Trip creation failed: ${routeError.message}`,
            raw,
          );
          continue;
        }

        // Conflict-free assignment: previously this step was skipped for bulk
        // uploads entirely, so a sheet naming a driver already double-booked
        // on another route this week (or exceeding their working-hours
        // limit) would silently write that conflict straight into the DB.
        // This is the same resolver used by reassign/optimize, so bulk
        // upload now gets the identical conflict/auto-assign/hours guarantees,
        // and it checks REAL shift-time overlap (+ minimum rest) rather than
        // just "any other route this week."
        const assignment = await resolveConflictFreeAssignment({
          trip,
          weekStartDate,
          candidateShiftTiming: shiftTiming,
          proposedDriverId: driverId,
          proposedVehicleId: vehicleId,
          vehicleTypeHint: vehicleType,
          minCapacity: undefined,
          excludeEmployeeId: employee.id,
          caches,
        });
        driverId = assignment.driverId;
        vehicleId = assignment.vehicleId;
        if (assignment.autoAssignedDriver) results.driversAutoAssigned++;
        if (assignment.autoAssignedVehicle) results.vehiclesAutoAssigned++;
        assignment.notes.forEach((note) => {
          if (note.includes("overlaps") || note.includes("was skipped"))
            results.conflictsResolved++;
          results.notes.push({ row: rowNum, employeeCode, note });
        });

        const offDaySet = parseOffDays(get("offDay"));
        const dayFields = {};
        DAY_KEYS.forEach((day) => {
          dayFields[day] = offDaySet.has(day) ? "OFF" : "BOTH";
        });

        const officeArrivalTime = get("officeArrivalTime");
        const dropTime = get("dropTime");

        // FIX (real-world bug): a route/trip with no driver and/or no
        // vehicle was previously still saved as a fully "ACTIVE" schedule
        // row — indistinguishable in the UI/reports from a properly
        // staffed one, even though nobody is actually assigned to drive or
        // carry this employee. A transport schedule with a missing driver
        // or vehicle isn't a usable assignment yet, so it's saved as
        // "DRAFT" (pending manual assignment) instead of "ACTIVE", and
        // counted separately so it's visible in the upload summary rather
        // than silently blending in with successful rows.
        const missingDriver = !driverId;
        const missingVehicle = !vehicleId;
        if (missingDriver || missingVehicle) {
          results.pendingAssignment += 1;
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Saved as DRAFT — missing ${[
              missingDriver ? "driver" : null,
              missingVehicle ? "vehicle" : null,
            ]
              .filter(Boolean)
              .join(" and ")}. Assign manually to activate.`,
          });
        }

        const scheduleData = {
          weekStart: weekStartDate,
          employeeId: employee.id,
          routeId: route?.id,
          tripId: trip?.id,
          driverId,
          vendorId,
          vehicleId,

          vehicleEntity: get("vehicleEntityName") || undefined,
          serviceType: deriveServiceType(officeArrivalTime, dropTime),
          shiftTiming: shiftTiming || undefined,

          pickupTime: officeArrivalTime || undefined,
          officeArrivalTime: officeArrivalTime || undefined,
          dropTime: dropTime || undefined,
          offDay: get("offDay") || undefined,
          ...dayFields,
          status: missingDriver || missingVehicle ? "DRAFT" : "ACTIVE",
        };

        // FIX: previously a fresh prisma.weeklySchedule.findUnique PER
        // ROW just to check "does this employee already have a row this
        // week" — that's 1 extra round trip x every row in the sheet.
        // The answer is already sitting in scheduleByEmployeeId (seeded
        // from the same week-roster query the conflict checks use, and
        // kept current below as each row writes), so read it from memory
        // instead.
        const existing = caches.scheduleByEmployeeId.get(employee.id) || null;

        let savedSchedule;
        if (existing) {
          if (existing.isLocked) {
            await skipRow(
              sheetName,
              rowNum,
              employeeCode,
              "Schedule is locked.",
              raw,
            );
            continue;
          }
          savedSchedule = await prisma.weeklySchedule.update({
            where: { id: existing.id },
            data: scheduleData,
          });
          results.updated++;
        } else {
          savedSchedule = await prisma.weeklySchedule.create({
            data: scheduleData,
          });
          results.created++;
        }
        // Keep the O(1) existing-row cache current with the row we just
        // wrote (full record, so a LATER duplicate employeeCode in this
        // same workbook — or the isLocked check above — still has
        // everything it needs without another DB round trip).
        caches.scheduleByEmployeeId.set(employee.id, savedSchedule);

        // Keep the in-memory week roster in sync so the NEXT row in this
        // same job sees this assignment immediately (no DB round trip),
        // which is what keeps driver/vehicle conflict + working-hours
        // checks fast and accurate as the job progresses.
        upsertRosterEntry(caches, {
          employeeId: employee.id,
          tripId: scheduleData.tripId,
          routeId: scheduleData.routeId,
          driverId: scheduleData.driverId || null,
          vehicleId: scheduleData.vehicleId || null,
          shiftTiming: scheduleData.shiftTiming,
          route,
          ...dayFields,
        });
      } catch (rowError) {
        await skipRow(sheetName, rowNum, employeeCode, rowError.message, raw);
      } finally {
        // Runs on every exit path for this row — success, skip via
        // `continue`, or caught error — so the progress bar always keeps
        // moving and never stalls partway through a sheet.
        processedCount += 1;
        updateBulkUploadJob(jobId, { processedRows: processedCount });

        // Batch boundary: every `batchSize` rows, publish a snapshot of
        // the results-so-far (so a client polling mid-run sees live
        // counts, not just a percent) and yield the event loop. On a very
        // large workbook this keeps the server responsive to OTHER
        // requests (including the status poll itself) between batches,
        // instead of one giant unbroken run of row processing.
        if (processedCount % batchSize === 0) {
          batchesCompleted += 1;
          updateBulkUploadJob(jobId, {
            batchesCompleted,
            partialResult: JSON.parse(JSON.stringify(results)),
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
  } // end per-sheet loop

  // Final partial snapshot for any rows since the last batch boundary,
  // plus whatever fraction of a batch the job ended on.
  if (processedCount % batchSize !== 0) {
    batchesCompleted += 1;
  }
  updateBulkUploadJob(jobId, {
    batchesCompleted,
    partialResult: JSON.parse(JSON.stringify(results)),
  });

  return results;
};

/**
 * POST /weekly-schedule/bulk-upload
 *
 * Body (multipart/form-data):
 *   file       - the .xlsx/.xls workbook (required)
 *   weekStart  - Monday the schedule applies to (required)
 *   batchSize  - optional rows-per-batch (default 100, clamped to
 *                10-1000). Rows are still processed one at a time in
 *                order — this doesn't parallelize anything — but every
 *                `batchSize` rows the job publishes a partial-result
 *                snapshot (see partialResult in getBulkUploadStatus) and
 *                yields the event loop, so a large workbook shows live
 *                progress in chunks instead of going quiet until the very
 *                end. Smaller batchSize = more frequent updates but more
 *                overhead; larger = fewer updates, slightly less overhead.
 *
 * Returns almost immediately with a jobId + totalRows instead of blocking
 * on the whole file. The actual row processing (see processBulkUploadJob)
 * runs in the background; poll GET /bulk-upload-status/:jobId for progress
 * and the final result. This is what fixes the "waiting with no idea if it
 * failed or succeeded" problem — the client can no longer lose track of a
 * long-running upload just because its own HTTP request timed out, since
 * the job keeps running server-side and the status endpoint reflects that.
 *
 * NOTE on vehicles: every seeded Driver already has its Vehicle paired —
 * see the NOTE on vehicles above processBulkUploadJob for details.
 */
/**
 * POST /weekly-schedule/validate-upload
 *
 * Read-only format check for a bulk-upload .xlsx BEFORE committing to the
 * (potentially long-running) real import. Parses every sheet the same way
 * processBulkUploadJob does, but writes nothing to the DB — it just reports,
 * per sheet:
 *   - whether an "Employee ID" header row was found at all
 *   - which recognized columns (HEADER_ALIASES) it mapped
 *   - which raw header cells it did NOT recognize (so a renamed/misspelled
 *     column shows up immediately instead of silently importing as blank)
 *   - how many data rows look valid (numeric Employee ID) vs total rows seen
 *   - how many of those valid rows are missing fields the row needs to be
 *     useful (name, shift timing) — these still import (skipRow logic in the
 *     real job decides row-by-row) but are surfaced here as a warning so the
 *     count doesn't come as a surprise after a multi-minute job finishes.
 *
 * Response.data.canProceed is false only when NOTHING in the workbook is
 * usable (no sheet has a recognizable header, or zero valid rows anywhere)
 * — the frontend uses this to block the real upload; everything else is a
 * warning the user can proceed past.
 */
const validateBulkUploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field.",
      );
      return res.status(response.status.code).json(response);
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (parseError) {
      const response = badRequestResponse(
        "Couldn't read that file as an .xlsx/.xls workbook. Verify it isn't corrupted and try again.",
      );
      return res.status(response.status.code).json(response);
    }

    const REQUIRED_FIELD_LABELS = {
      employeeCode: "Employee ID",
      name: "User Name",
      shiftTiming: "Shift Timings",
    };
    // Fields we'd like to see but don't hard-require, since real rows in the
    // wild sometimes omit them without the row being useless.
    const RECOMMENDED_FIELD_LABELS = {
      area: "Area",
      vehicleReg: "Vehicle Reg",
      drivers: "Drivers",
    };

    const sheetsReport = [];
    const errors = [];
    let anyValidRows = false;

    if (!workbook.SheetNames.length) {
      errors.push("The workbook has no sheets.");
    }

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      });

      const headerRowIndex = rows.findIndex((r) =>
        r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
      );

      if (headerRowIndex === -1) {
        sheetsReport.push({
          sheet: sheetName,
          headerFound: false,
          totalDataRows: 0,
          validRows: 0,
          mappedFields: [],
          unmappedHeaders: [],
          missingRequiredFields: [],
          warnings: [
            "No 'Employee ID' header found — this sheet will be skipped entirely on upload.",
          ],
        });
        continue;
      }

      const headerRow = rows[headerRowIndex];
      const mappedFields = [];
      const unmappedHeaders = [];
      const colIndexByField = {};
      headerRow.forEach((cell, i) => {
        const raw = String(cell).trim();
        if (!raw) return;
        const key = HEADER_ALIASES[raw.toLowerCase()];
        if (key) {
          colIndexByField[key] = i;
          if (!mappedFields.includes(`${raw} → ${key}`)) {
            mappedFields.push(`${raw} → ${key}`);
          }
        } else {
          unmappedHeaders.push(raw);
        }
      });

      const dataRows = rows.slice(headerRowIndex + 1);
      const get = (raw, key) =>
        colIndexByField[key] !== undefined
          ? String(raw[colIndexByField[key]] ?? "").trim()
          : "";

      let validRows = 0;
      let missingName = 0;
      let missingShift = 0;
      for (const raw of dataRows) {
        const employeeCode = get(raw, "employeeCode");
        if (!employeeCode || !/^\d+$/.test(employeeCode)) continue; // blank/header-repeat row
        validRows++;
        if (!get(raw, "name")) missingName++;
        if (!get(raw, "shiftTiming")) missingShift++;
      }
      if (validRows > 0) anyValidRows = true;

      const missingRequiredFields = Object.entries(REQUIRED_FIELD_LABELS)
        .filter(([field]) => colIndexByField[field] === undefined)
        .map(([, label]) => label);
      const missingRecommendedFields = Object.entries(RECOMMENDED_FIELD_LABELS)
        .filter(([field]) => colIndexByField[field] === undefined)
        .map(([, label]) => label);

      const warnings = [];
      if (validRows === 0) {
        warnings.push(
          "No valid data rows found under the header (Employee ID column is blank/non-numeric throughout).",
        );
      }
      if (missingName > 0)
        warnings.push(`${missingName} row(s) missing a User Name.`);
      if (missingShift > 0)
        warnings.push(`${missingShift} row(s) missing Shift Timings.`);
      if (missingRecommendedFields.length) {
        warnings.push(
          `Missing recommended column(s): ${missingRecommendedFields.join(", ")}.`,
        );
      }
      if (unmappedHeaders.length) {
        warnings.push(
          `Unrecognized column(s), will be ignored: ${unmappedHeaders.join(", ")}.`,
        );
      }

      sheetsReport.push({
        sheet: sheetName,
        headerFound: true,
        totalDataRows: dataRows.filter(
          (r) => String(r[0] ?? "").trim().length > 0,
        ).length,
        validRows,
        mappedFields,
        unmappedHeaders,
        missingRequiredFields,
        warnings,
      });
    }

    if (!anyValidRows) {
      errors.push(
        "None of the sheets in this workbook have any usable rows — check that at least one sheet has an 'Employee ID' header with numeric IDs beneath it.",
      );
    }

    const result = {
      canProceed: errors.length === 0,
      errors,
      sheets: sheetsReport,
    };

    const response = okResponse(result, "Workbook format checked.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const bulkUploadWeeklySchedule = async (req, res, next) => {
  try {
    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field.",
      );
      return res.status(response.status.code).json(response);
    }

    const { weekStart, batchSize: batchSizeRaw } = req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Monday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toDateOnly(weekStart);

    // Optional caller-supplied rows-per-batch. A large sheet (many hundreds
    // of rows) can be processed in smaller chunks so progress/partial
    // results update more often and the server yields between chunks —
    // useful when a workbook is big enough that a single unbroken run feels
    // like it's hung. Falls back to DEFAULT_BATCH_SIZE if omitted, and is
    // clamped to [MIN_BATCH_SIZE, MAX_BATCH_SIZE] so a bad value (0, a
    // negative number, "abc", or something absurdly large/small) can't
    // break the job.
    let batchSize = DEFAULT_BATCH_SIZE;
    if (batchSizeRaw !== undefined && batchSizeRaw !== "") {
      const parsed = parseInt(batchSizeRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const response = badRequestResponse(
          `batchSize must be a positive whole number (between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}).`,
        );
        return res.status(response.status.code).json(response);
      }
      batchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, parsed));
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (parseError) {
      const response = badRequestResponse(
        "Couldn't read that file as an .xlsx/.xls workbook. Verify it isn't corrupted and try again.",
      );
      return res.status(response.status.code).json(response);
    }

    // Pre-count data rows across every sheet that has an "Employee ID"
    // header, so the status endpoint has a real denominator for percent
    // complete. Cheap — this is pure in-memory parsing, no DB calls.
    let totalRows = 0;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      });
      const headerRowIndex = rows.findIndex((r) =>
        r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
      );
      if (headerRowIndex === -1) continue;
      totalRows += rows.slice(headerRowIndex + 1).filter((r) => {
        const first = String(r[0] ?? "").trim();
        return first.length > 0;
      }).length;
    }

    const jobResult = createBulkUploadJob(totalRows, batchSize, weekStartDate);
    if (jobResult.conflict) {
      const response = {
        status: { code: 409, status: false },
        message:
          `A bulk upload for the week of ${weekStart} is already running (job ` +
          `${jobResult.existingJobId}). Wait for it to finish before starting another — ` +
          `uploading the same week twice at once can cause some rows to fail with a ` +
          `duplicate-schedule error, since both uploads race to write the same employees' ` +
          `schedules. Poll GET /weekly-schedule/bulk-upload-status/${jobResult.existingJobId} ` +
          `for its progress, then re-upload once it's done if you still need to.`,
        data: { existingJobId: jobResult.existingJobId },
      };
      return res.status(response.status.code).json(response);
    }
    const jobId = jobResult.jobId;

    // Fire-and-forget: intentionally not awaited. Any error the worker
    // throws is caught here so the job is always marked "failed" rather
    // than left stuck at "processing" forever.
    processBulkUploadJob(jobId, workbook, weekStartDate, batchSize)
      .then((results) => {
        updateBulkUploadJob(jobId, { status: "done", result: results });
      })
      .catch((error) => {
        updateBulkUploadJob(jobId, {
          status: "failed",
          error: error.message || "Bulk upload failed unexpectedly.",
        });
      });

    const response = okResponse(
      {
        jobId,
        totalRows,
        batchSize,
        totalBatches: totalRows ? Math.ceil(totalRows / batchSize) : 0,
      },
      "Bulk upload started. Poll bulk-upload-status/:jobId for progress.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWeeklySchedule,
  getAllWeeklySchedules,
  getWeeklyScheduleById,
  updateWeeklySchedule,
  deleteWeeklySchedule,
  getCurrentWeekSchedules,
  getEmployeeScheduleRange,
  getGroupedSchedules,
  getScheduleStats,
  getScheduleTableStats, // new
  getScheduleTableGroupedByArea,
  bulkUploadWeeklySchedule, // new
  validateBulkUploadFile, // new — read-only format/header check, run before bulkUploadWeeklySchedule
  getBulkUploadStatus, // new — poll for progress/result of a bulk-upload job
  reassignMismatchedShiftEmployees, // new
  optimizeRouteAssignments, // new
};