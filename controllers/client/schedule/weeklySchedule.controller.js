const XLSX = require("xlsx");
const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse, okResponse } = require("../../../constants/responses");
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
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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
  const gapAToB = ((b.start - aEnd) % 1440 + 1440) % 1440;
  const gapBToA = ((a.start - bEnd) % 1440 + 1440) % 1440;
  return Math.max(gapAToB, gapBToA) >= MIN_REST_MINUTES;
};

const countWorkingDays = (entry) =>
  DAY_KEYS.filter((day) => entry[day] && entry[day] !== "OFF").length;

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
  excludeEmployeeId
) => {
  const driver = await client.driver.findUnique({ where: { id: driverId } });
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

  const others = await client.weeklySchedule.findMany({
    where: {
      driverId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
  });

  let weeklyMinutes = range.durationMinutes * (candidateWorkingDays || 5);
  for (const other of others) {
    const otherRange = parseShiftRange(other.shiftTiming);
    if (otherRange) weeklyMinutes += otherRange.durationMinutes * countWorkingDays(other);
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
const recordAssignmentHistory = async (client, action, weeklyScheduleId, before, after, changedBy) => {
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
const logScheduleException = async (client, { weekStart, employeeCode, rowNumber, reason, rawData }) => {
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
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
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
  drivers: "drivers",
  "employee id": "employeeCode",
  "user name": "name",
  "off day": "offDay",
  campaign: "campaign",
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
  const tokens = String(offDayRaw || "").toUpperCase().match(/SUN|MON|TUE|WED|THU|FRI|SAT/g) || [];
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
  const arrival = String(officeArrivalTime || "").trim().toLowerCase();
  const drop = String(dropTime || "").trim().toLowerCase();
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

const findOrCreateDriver = async (name, phone) => {
  if (!name) return { driver: null, created: false };
  let driver = await prisma.driver.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (driver) return { driver, created: false };

  driver = await prisma.driver.create({
    data: {
      name,
      contactNumber: phone || undefined,
      status: "AVAILABLE",
    },
  });
  return { driver, created: true };
};

/**
 * NOTE: assumes Vehicle has a unique-ish `vehicleNumber` field and a `status`
 * field (matching how getScheduleTableStats counts
 * `prisma.vehicle.count({ where: { status: "ACTIVE" } })`). Adjust field
 * names below if your Vehicle model differs.
 */
const findOrCreateVehicle = async (vehicleReg) => {
  if (!vehicleReg) return { vehicle: null, created: false };
  let vehicle = await prisma.vehicle.findFirst({
    where: { vehicleNumber: { equals: vehicleReg, mode: "insensitive" } },
  });
  if (vehicle) return { vehicle, created: false };

  vehicle = await prisma.vehicle.create({
    data: { vehicleNumber: vehicleReg, status: "ACTIVE" },
  });
  return { vehicle, created: true };
};

const VEHICLE_TYPES = new Set(["CAR", "VAN", "HIJET", "KARVAN", "BUS"]);

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
  excludeEmployeeId
) => {
  if (!driverId) return null;
  const others = await prisma.weeklySchedule.findMany({
    where: {
      driverId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
    include: { route: true },
  });

  const candidateRange = candidateShiftTiming ? parseShiftRange(candidateShiftTiming) : null;

  for (const other of others) {
    if (!candidateShiftTiming || !other.shiftTiming) return other; // can't prove no overlap
    if (shiftTimesOverlap(candidateShiftTiming, other.shiftTiming)) return other;
    const otherRange = parseShiftRange(other.shiftTiming);
    if (candidateRange && otherRange && !hasMinimumRest(candidateRange, otherRange)) return other;
  }
  return null;
};

/** Same idea as findDriverConflict, but for a vehicle. */
const findVehicleConflict = async (
  vehicleId,
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
  excludeEmployeeId
) => {
  if (!vehicleId) return null;
  const others = await prisma.weeklySchedule.findMany({
    where: {
      vehicleId,
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
    include: { route: true },
  });

  for (const other of others) {
    if (!candidateShiftTiming || !other.shiftTiming) return other;
    if (shiftTimesOverlap(candidateShiftTiming, other.shiftTiming)) return other;
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
const findBestAvailableDriver = async (weekStartDate, candidateShiftTiming, targetTripId, excludeEmployeeId) => {
  const others = await prisma.weeklySchedule.findMany({
    where: {
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      driverId: { not: null },
      ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
    select: { driverId: true, shiftTiming: true },
  });

  const candidateRange = candidateShiftTiming ? parseShiftRange(candidateShiftTiming) : null;
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
    if (candidateRange && otherRange && !hasMinimumRest(candidateRange, otherRange)) {
      busyIds.add(row.driverId);
    }
  }

  const eligible = await prisma.driver.findMany({
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
  excludeEmployeeId
) => {
  const others = await prisma.weeklySchedule.findMany({
    where: {
      weekStart: weekStartDate,
      status: { not: "CANCELLED" },
      vehicleId: { not: null },
      ...(targetTripId ? { tripId: { not: targetTripId } } : {}),
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
    select: { vehicleId: true, shiftTiming: true },
  });
  const busyIds = [];
  for (const row of others) {
    if (!candidateShiftTiming || !row.shiftTiming || shiftTimesOverlap(candidateShiftTiming, row.shiftTiming)) {
      busyIds.push(row.vehicleId);
    }
  }

  const baseWhere = {
    status: "ACTIVE",
    ...(busyIds.length ? { id: { notIn: busyIds } } : {}),
    ...(minCapacity ? { capacity: { gte: minCapacity } } : {}),
  };

  const typeKey = String(vehicleTypeHint || "").trim().toUpperCase();
  if (typeKey && VEHICLE_TYPES.has(typeKey)) {
    const typed = await prisma.vehicle.findFirst({
      where: { ...baseWhere, type: typeKey },
      orderBy: { capacity: "asc" },
    });
    if (typed) return typed;
  }

  return prisma.vehicle.findFirst({ where: baseWhere, orderBy: { capacity: "asc" } });
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
  excludeEmployeeId
) => {
  const driver = await findBestAvailableDriver(weekStartDate, candidateShiftTiming, targetTripId, excludeEmployeeId);
  if (!driver) return { driverId: undefined, vehicleId: undefined };

  let vehicle = driver.vehicle && driver.vehicle.status === "ACTIVE" ? driver.vehicle : null;
  if (vehicle) {
    const conflict = await findVehicleConflict(vehicle.id, weekStartDate, candidateShiftTiming, targetTripId, excludeEmployeeId);
    if (conflict) vehicle = null;
  }
  if (!vehicle) {
    vehicle = await findBestAvailableVehicle(
      weekStartDate,
      candidateShiftTiming,
      targetTripId,
      minCapacity,
      vehicleTypeHint,
      excludeEmployeeId
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
}) => {
  const notes = [];
  let driverId = proposedDriverId;
  let vehicleId = proposedVehicleId;
  let autoAssignedDriver = false;
  let autoAssignedVehicle = false;
  const shiftTiming = candidateShiftTiming || trip.shiftTiming || trip.route?.shiftTiming;

  if (driverId) {
    const conflict = await findDriverConflict(driverId, weekStartDate, shiftTiming, trip.id, excludeEmployeeId);
    if (conflict) {
      notes.push(
        `Requested driver's shift overlaps (or doesn't leave enough rest around) route "${conflict.route?.routeCode ?? conflict.routeId}" this week — auto-assigned a different available driver instead.`
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
      excludeEmployeeId
    );
    if (!hoursCheck.ok) {
      notes.push(`Requested driver was skipped — ${hoursCheck.reason} Auto-assigned a different available driver instead.`);
      driverId = undefined;
    }
  }

  if (vehicleId) {
    const conflict = await findVehicleConflict(vehicleId, weekStartDate, shiftTiming, trip.id, excludeEmployeeId);
    if (conflict) {
      notes.push(
        `Requested vehicle's shift overlaps route "${conflict.route?.routeCode ?? conflict.routeId}" this week — auto-assigned a different available vehicle instead.`
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
      excludeEmployeeId
    );
    if (best.driverId) {
      driverId = best.driverId;
      autoAssignedDriver = true;
      if (!vehicleId && best.vehicleId) {
        vehicleId = best.vehicleId;
        autoAssignedVehicle = true;
      }
    } else {
      notes.push("No available (conflict-free) driver found for this row — left unassigned; assign manually.");
    }
  }

  if (driverId && !vehicleId) {
    const vehicle = await findBestAvailableVehicle(
      weekStartDate,
      shiftTiming,
      trip.id,
      capacityFloor,
      vehicleTypeHint,
      excludeEmployeeId
    );
    if (vehicle) {
      vehicleId = vehicle.id;
      autoAssignedVehicle = true;
    } else {
      notes.push("No available (conflict-free) vehicle found for this row — left unassigned; assign manually.");
    }
  }

  if (driverId !== (trip.driverId || undefined) || vehicleId !== (trip.vehicleId || undefined)) {
    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        driverId: driverId || null,
        vehicleId: vehicleId || null,
      },
    });
    await syncRouteFromTrips(trip.routeId);
  }

  return { driverId, vehicleId, autoAssignedDriver, autoAssignedVehicle, notes };
};

/**
 * NOTE: assumes Vendor has a `name` field. Adjust if different.
 */
const findOrCreateVendor = async (name) => {
  if (!name) return { vendor: null, created: false };
  let vendor = await prisma.vendor.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (vendor) return { vendor, created: false };

  vendor = await prisma.vendor.create({ data: { name } });
  return { vendor, created: true };
};

/**
 * NOTE: assumes Employee has `employeeCode` (unique), `name`, `contactNumber`,
 * `areaId`, `entity`, `shiftTiming`, `status` fields, matching how Employee is
 * used elsewhere in this file (getScheduleTableGroupedByArea). Adjust field
 * names below if your Employee model differs.
 */
const findOrCreateEmployee = async (row) => {
  let employee = await prisma.employee.findUnique({
    where: { employeeCode: row.employeeCode },
  });
  if (employee) return { employee, created: false };

  let areaId;
  if (row.area) {
    let area = await prisma.area.findFirst({
      where: { name: { equals: row.area, mode: "insensitive" } },
    });
    if (!area) {
      area = await prisma.area.create({ data: { name: row.area } });
    }
    areaId = area.id;
  }

  employee = await prisma.employee.create({
    data: {
      employeeCode: row.employeeCode,
      name: row.name || row.employeeCode,
      contactNumber: row.contact || undefined,
      areaId,
      entity: row.entity || undefined,
      shiftTiming: row.shiftTiming || undefined,
      status: "ACTIVE",
    },
  });
  return { employee, created: true };
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
  const key = String(vehicleTypeRaw || "").trim().toUpperCase();
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
const syncRouteFromTrips = async (routeId) => {
  const trips = await prisma.trip.findMany({
    where: { routeId, status: { not: "CANCELLED" } },
    include: { vehicle: true },
    orderBy: { tripNumber: "asc" },
  });
  const totalCapacity = trips.reduce(
    (sum, t) => sum + (t.vehicle?.capacity ?? FALLBACK_ROUTE_CAPACITY),
    0
  );
  await prisma.route.update({
    where: { id: routeId },
    data: {
      maxCapacity: totalCapacity || FALLBACK_ROUTE_CAPACITY,
      driverId: trips[0]?.driverId || null,
    },
  });
};

/**
 * Resolves the Route + Trip a sheet row should be assigned to.
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
  areaName,
  vehicleType,
  shiftTiming,
  campaign,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId
) => {
  let areaRecord = null;
  if (areaName) {
    areaRecord = await prisma.area.findFirst({
      where: { name: { equals: areaName, mode: "insensitive" } },
    });
    if (!areaRecord) {
      areaRecord = await prisma.area.create({ data: { name: areaName } });
    }
  }

  let route = null;
  if (areaRecord) {
    const candidates = await prisma.route.findMany({
      where: { areaId: areaRecord.id },
      include: { area: true },
      orderBy: { routeCode: "asc" },
    });
    if (shiftTiming) {
      const shiftLower = shiftTiming.trim().toLowerCase();
      route =
        candidates.find(
          (r) =>
            (r.shiftTiming && r.shiftTiming.trim().toLowerCase() === shiftLower) ||
            String(r.routeName || "").toLowerCase().includes(shiftLower)
        ) || null;
    } else {
      route = candidates[0] || null;
    }
  }

  let routeCreated = false;
  if (!route) {
    const baseName =
      [areaName, vehicleType, shiftTiming].filter(Boolean).join(" - ") || campaign || "General Route";
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
  }

  const { trip, newTrip } = await findOrCreateTripOnRoute(
    route,
    vehicleType,
    shiftTiming,
    driverId,
    vehicleIdHint,
    weekStartDate,
    excludeEmployeeId
  );

  route = await prisma.route.findUnique({ where: { id: route.id }, include: { area: true, driver: true } });

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
  excludeEmployeeId
) => {
  const trips = await prisma.trip.findMany({
    where: { routeId: route.id, status: { not: "CANCELLED" } },
    include: { vehicle: true },
    orderBy: { tripNumber: "asc" },
  });

  let trip = null;
  for (const candidate of trips) {
    const capacity = candidate.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
    const occupancy = await countTripOccupancy(candidate.id, weekStartDate, excludeEmployeeId);
    const hasRoom = occupancy < capacity;
    const driverOk = !driverId || !candidate.driverId || candidate.driverId === driverId;
    if (hasRoom && driverOk) {
      trip = candidate;
      break;
    }
  }

  let tripCreated = false;
  if (!trip) {
    const nextTripNumber = trips.length ? Math.max(...trips.map((t) => t.tripNumber)) + 1 : 1;
    trip = await prisma.trip.create({
      data: {
        routeId: route.id,
        tripNumber: nextTripNumber,
        driverId: driverId || undefined,
        vehicleId: vehicleIdHint || undefined,
        shiftTiming: shiftTiming || undefined,
      },
      include: { vehicle: true },
    });
    tripCreated = true;
  } else {
    const patch = {};
    if (driverId && !trip.driverId) patch.driverId = driverId;
    if (vehicleIdHint && !trip.vehicleId) patch.vehicleId = vehicleIdHint;
    if (Object.keys(patch).length) {
      trip = await prisma.trip.update({ where: { id: trip.id }, data: patch, include: { vehicle: true } });
    }
  }

  await syncRouteFromTrips(route.id);
  return { trip, newTrip: tripCreated && trips.length > 0 };
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
      const response = badRequestResponse("routeId or routeCode, plus weekStart, are required.");
      return res.status(response.status.code).json(response);
    }

    const weekStartDate = toDateOnly(weekStart);

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
      where: { routeId: route.id, weekStart: weekStartDate, status: { not: "CANCELLED" } },
    });

    const routeShiftNorm = normalizeShift(route.shiftTiming);
    const mismatched = schedules.filter(
      (s) => s.shiftTiming && normalizeShift(s.shiftTiming) !== routeShiftNorm
    );

    if (!mismatched.length) {
      const response = okResponse(
        { updated: 0, routesCreated: 0, legsOpened: 0, details: [] },
        "No shift-mismatched employees found on this route — nothing to reassign."
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
      if (!groups.has(key)) groups.set(key, { shiftTiming: s.shiftTiming, entries: [] });
      groups.get(key).entries.push(s);
    });

    const areaName = route.area?.name;
    const results = { updated: 0, routesCreated: 0, legsOpened: 0, details: [] };

    for (const { shiftTiming, entries } of groups.values()) {
      for (const entry of entries) {
        const routeResult = await findOrCreateRouteAndTrip(
          areaName,
          undefined, // vehicle type unknown at this point — falls back to a safe default capacity
          shiftTiming,
          undefined,
          entry.driverId || undefined,
          entry.vehicleId || undefined,
          weekStartDate,
          entry.employeeId
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
      `Reassigned ${results.updated} employee(s) off "${route.routeCode}" onto their correct shift's route.`
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
        entry.employeeId
      );
      trip = backfilled.trip;
      await prisma.weeklySchedule.update({ where: { id: entry.id }, data: { tripId: trip.id } });
      summary.tripsBackfilled++;
    }

    let driverId = entry.driverId || undefined;
    let vehicleId = entry.vehicleId || undefined;
    const shiftTiming = entry.shiftTiming || entry.route.shiftTiming;

    if (driverId) {
      const conflict = await findDriverConflict(driverId, weekStartDate, shiftTiming, trip.id, entry.employeeId);
      if (conflict) driverId = undefined;
    }
    if (vehicleId) {
      const conflict = await findVehicleConflict(vehicleId, weekStartDate, shiftTiming, trip.id, entry.employeeId);
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

    if (driverId !== (entry.driverId || undefined) || vehicleId !== (entry.vehicleId || undefined)) {
      await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: { driverId: driverId || null, vehicleId: vehicleId || null, tripId: trip.id },
      });
      if (driverId !== (entry.driverId || undefined)) summary.driversReassigned++;
      if (vehicleId !== (entry.vehicleId || undefined)) summary.vehiclesReassigned++;
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
    const response = okResponse(summary, "Route assignments optimized for the week.");
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
      const response = badRequestResponse("employeeId and weekStart are required.");
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
        "Schedule already exists for this employee in this week."
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
    const { skip = 0, take = 10, employeeId, status, weekStart, routeId, search } = req.query;

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
        { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        { vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } } },
      ];
    }

    const options = {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
        route: {
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            area: true,
            driver: { select: { id: true, name: true } },
          },
        },
        // Trip Number / per-trip vehicle so the list view can show which
        // specific vehicle run (not just which route) an employee is on —
        // previously omitted here, so tripId was being written on every row
        // but never came back out of this endpoint.
        trip: {
          select: {
            id: true,
            tripNumber: true,
            vehicle: { select: { id: true, vehicleNumber: true, capacity: true } },
            driver: { select: { id: true, name: true } },
          },
        },
        driver: {
          select: { id: true, name: true },
        },
        vehicle: {
          select: { id: true, vehicleNumber: true },
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
    const touchesAssignment = ["routeId", "tripId", "driverId", "vehicleId"].some((f) => f in updateData);
    if (touchesAssignment) {
      try {
        await optimizeWeekAssignments(updateData.weekStart || schedule.weekStart);
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
    const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // weekStart is always a Monday (see schema). Convert Sunday=0..Saturday=6
    // into "days since Monday" so this lines up with every other Monday-based
    // weekStart in the app (e.g. the frontend's own default-week-start calc),
    // instead of the previous Sunday-based start which pointed at the wrong
    // week entirely whenever this ran on a Sunday.
    const daysSinceMonday = (utcToday.getUTCDay() + 6) % 7;
    const startOfWeek = new Date(utcToday.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);

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
      "Current week schedules retrieved successfully."
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
      "Employee schedule range retrieved successfully."
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
        { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        { vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } } },
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
            vehicle: { select: { id: true, vehicleNumber: true, capacity: true } },
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

      if (s.trip) {
        if (!routeEntry.tripMap.has(s.trip.id)) {
          routeEntry.tripMap.set(s.trip.id, {
            tripNumber: s.trip.tripNumber,
            capacity: s.trip.vehicle?.capacity ?? null,
            empIds: new Set(),
          });
        }
        routeEntry.tripMap.get(s.trip.id).empIds.add(s.employeeId);
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

    const routes = Array.from(routeMap.values()).map((r) => {
      const trips = Array.from(r.tripMap.values())
        .sort((a, b) => a.tripNumber - b.tripNumber)
        .map((t) => ({
          tripNumber: t.tripNumber,
          capacity: t.capacity,
          assignedEmployees: t.empIds.size,
          remainingSeats: t.capacity != null ? Math.max(t.capacity - t.empIds.size, 0) : null,
        }));

      return {
        code: r.code,
        name: r.name,
        area: r.area,
        shift: r.shift,
        service: r.service,
        driverBadge: r.driverBadge,
        vehicleBadge: r.vehicleBadge,
        empCount: r.empIds.size,
        // Requirement 7: Vehicle Capacity + Remaining Available Seats at the
        // route level (aggregate across trips), plus a per-trip breakdown
        // (with Trip Number) whenever the route runs more than one trip.
        capacity: r.capacity,
        remainingSeats: r.capacity != null ? Math.max(r.capacity - r.empIds.size, 0) : null,
        multiTrip: trips.length > 1,
        trips,
        weeks: Array.from(r.weekMap.values()).sort((a, b) =>
          b.weekOf.localeCompare(a.weekOf)
        ),
      };
    });

    const response = okResponse(routes, "Grouped weekly schedules retrieved successfully.");
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

    const [activeRoutesResult, weeksOnFileResult, employeesResult] = await Promise.all([
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
      "Schedule stats retrieved successfully."
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
    const [activeEmployees, areasCount, availableDrivers, activeVehicles] = await Promise.all([
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
      "Schedule table stats retrieved successfully."
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
      "Schedule table grouped by area retrieved successfully."
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
 *   1. Finds the Employee by "Employee ID" (employeeCode); auto-creates one
 *      from Name/Contact/Area if it doesn't exist yet.
 *   2. Finds/creates the Driver and Vendor by name.
 *   3. Finds/creates the Route from Area + Vehicle Type + Shift Timing (the
 *      sheet has no explicit Route column, so employees sharing all three of
 *      these are treated as riding the same route).
 *   4. Derives serviceType from the "Drop"/"Pick" text sometimes found in the
 *      time columns, and OFF days from the "Off Day" column.
 *   5. Upserts (create or update) the WeeklySchedule for that employee + week.
 *
 * Rows that repeat the header (the sheet has several duplicate header rows)
 * or have a non-numeric Employee ID are silently skipped. Rows that fail for
 * another reason (bad data, DB error) are recorded in `skipped` rather than
 * aborting the whole import.
 *
 * NOTE on vehicles: the sheet only gives a Vehicle Type (e.g. "Hiace"), never
 * a real vehicle number/plate, so we deliberately do NOT auto-create a
 * Vehicle record here — that field feeds the Route name instead. If you want
 * vehicleId populated too, the sheet needs an actual vehicle-number column.
 */
const bulkUploadWeeklySchedule = async (req, res, next) => {
  try {
    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field."
      );
      return res.status(response.status.code).json(response);
    }

    const { weekStart } = req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Monday this schedule applies to) is required."
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toDateOnly(weekStart);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });

    const headerRowIndex = rows.findIndex((r) =>
      r.some((cell) => String(cell).trim().toLowerCase() === "employee id")
    );
    if (headerRowIndex === -1) {
      const response = badRequestResponse(
        "Could not find an 'Employee ID' header column in the sheet."
      );
      return res.status(response.status.code).json(response);
    }

    const colIndex = {};
    rows[headerRowIndex].forEach((cell, i) => {
      const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
      if (key) colIndex[key] = i;
    });

    const results = {
      created: 0,
      updated: 0,
      employeesCreated: 0,
      driversCreated: 0,
      vendorsCreated: 0,
      vehiclesCreated: 0,
      routesCreated: 0,
      routeLegsOpenedForOverflow: 0,
      driversAutoAssigned: 0,
      vehiclesAutoAssigned: 0,
      conflictsResolved: 0,
      skipped: [],
      notes: [],
    };

    // Records a skipped row both in the HTTP response AND the persistent
    // exception queue — previously logScheduleException was defined but
    // never called, so skipped rows only ever lived in the transient
    // response payload and were lost the moment the request finished.
    const skipRow = async (rowNum, employeeCode, reason, rawData) => {
      results.skipped.push({ row: rowNum, employeeCode, reason });
      await logScheduleException(prisma, {
        weekStart: weekStartDate,
        employeeCode,
        rowNumber: rowNum,
        reason,
        rawData,
      });
    };

    const dataRows = rows.slice(headerRowIndex + 1);

    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i];
      const rowNum = headerRowIndex + i + 2; // 1-indexed sheet row, for error messages
      const get = (key) =>
        colIndex[key] !== undefined ? String(raw[colIndex[key]] ?? "").trim() : "";

      const employeeCode = get("employeeCode");
      // Skip blank rows and the sheet's repeated header rows (Employee ID isn't numeric there).
      if (!employeeCode || !/^\d+$/.test(employeeCode)) continue;

      try {
        const { employee, created: employeeCreated } = await findOrCreateEmployee({
          employeeCode,
          name: get("name"),
          contact: get("contact"),
          area: get("area"),
          entity: get("entity"),
          shiftTiming: get("shiftTiming"),
        });
        if (employeeCreated) results.employeesCreated++;

        // A row can list more than one driver (e.g. "Tariq 03043160572Shahrukh
        // 03192121756"). WeeklySchedule only stores a single driverId, but we
        // still create/find EVERY driver named on the row so none of them go
        // missing from the Driver table — the first one becomes the primary
        // driverId for this schedule entry.
        const driverEntries = parseDriverEntries(get("drivers"));
        let driverId;
        for (let d = 0; d < driverEntries.length; d++) {
          const { driver, created } = await findOrCreateDriver(
            driverEntries[d].name,
            driverEntries[d].phone
          );
          if (created) results.driversCreated++;
          if (d === 0) driverId = driver?.id;
        }

        const vendorName = get("vendor");
        let vendorId;
        if (vendorName) {
          const { vendor, created } = await findOrCreateVendor(vendorName);
          vendorId = vendor?.id;
          if (created) results.vendorsCreated++;
        }

        const vehicleReg = get("vehicleReg");
        let vehicleId;
        if (vehicleReg) {
          const { vehicle, created } = await findOrCreateVehicle(vehicleReg);
          vehicleId = vehicle?.id;
          if (created) results.vehiclesCreated++;
        }

        const areaName = get("area");
        const vehicleType = get("vehicleType");
        const shiftTiming = get("shiftTiming");
        const campaign = get("campaign");

        let route;
        let trip;
        let routeCreated = false;
        try {
          const routeResult = await findOrCreateRouteAndTrip(
            areaName,
            vehicleType,
            shiftTiming,
            campaign,
            driverId,
            vehicleId,
            weekStartDate,
            employee.id
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
              rowNum,
              employeeCode,
              "Route/Trip could not be created/found even with fallback — check Route/Trip model required fields.",
              raw
            );
            continue;
          }
        } catch (routeError) {
          await skipRow(rowNum, employeeCode, `Route/Trip creation failed: ${routeError.message}`, raw);
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
        });
        driverId = assignment.driverId;
        vehicleId = assignment.vehicleId;
        if (assignment.autoAssignedDriver) results.driversAutoAssigned++;
        if (assignment.autoAssignedVehicle) results.vehiclesAutoAssigned++;
        assignment.notes.forEach((note) => {
          if (note.includes("overlaps") || note.includes("was skipped")) results.conflictsResolved++;
          results.notes.push({ row: rowNum, employeeCode, note });
        });

        const offDaySet = parseOffDays(get("offDay"));
        const dayFields = {};
        DAY_KEYS.forEach((day) => {
          dayFields[day] = offDaySet.has(day) ? "OFF" : "BOTH";
        });

        const officeArrivalTime = get("officeArrivalTime");
        const dropTime = get("dropTime");

        const scheduleData = {
          weekStart: weekStartDate,
          employeeId: employee.id,
          routeId: route?.id,
          tripId: trip?.id,
          driverId,
          vendorId,
          vehicleId,
          // "Vehicle Entity" (e.g. "IBEX") is a separate column from the
          // employee's own "Entity" (e.g. "VW") — don't conflate the two.
          vehicleEntity: get("vehicleEntityName") || undefined,
          serviceType: deriveServiceType(officeArrivalTime, dropTime),
          shiftTiming: shiftTiming || undefined,
          // "Office Arrival Time" IS the pick-up time — feed both fields so
          // the UI's "Pick Time" column (which reads pickupTime) is populated,
          // while officeArrivalTime is kept too for reference.
          pickupTime: officeArrivalTime || undefined,
          officeArrivalTime: officeArrivalTime || undefined,
          dropTime: dropTime || undefined,
          offDay: get("offDay") || undefined,
          ...dayFields,
          status: "ACTIVE",
        };

        const existing = await prisma.weeklySchedule.findUnique({
          where: {
            employeeId_weekStart: { employeeId: employee.id, weekStart: weekStartDate },
          },
        });

        if (existing) {
          if (existing.isLocked) {
            await skipRow(rowNum, employeeCode, "Schedule is locked.", raw);
            continue;
          }
          await prisma.weeklySchedule.update({ where: { id: existing.id }, data: scheduleData });
          results.updated++;
        } else {
          await prisma.weeklySchedule.create({ data: scheduleData });
          results.created++;
        }
      } catch (rowError) {
        await skipRow(rowNum, employeeCode, rowError.message, raw);
      }
    }

    const response = okResponse(results, "Weekly schedule bulk upload processed.");
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
  getScheduleTableStats,          // new
  getScheduleTableGroupedByArea,
  bulkUploadWeeklySchedule,        // new
  reassignMismatchedShiftEmployees, // new
  optimizeRouteAssignments,        // new
};