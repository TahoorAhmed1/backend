const XLSX = require("xlsx");
const pLimit = require("p-limit");
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
const {
  syncPendingRidesForWeek,
  syncPendingRidesForWeekBestEffort,
} = require("../../../lib/rideplaing");

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
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

const formatDateOnly = (d) => new Date(d).toISOString().slice(0, 10);

const mondayOfCurrentWeek = () => {
  const now = new Date();
  const utcToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const daysSinceMonday = (utcToday.getUTCDay() + 6) % 7;
  return new Date(utcToday.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
};

const DAY_FIELD_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// ---------- Driver Rest Time / Working Hours ----------

const MIN_REST_MINUTES = 8 * 60;
const DEFAULT_MAX_DAILY_HOURS = 12;
const DEFAULT_MAX_WEEKLY_HOURS = 60;

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

// ---------- In-memory "week roster" cache ----------

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

const upsertRosterEntry = (caches, entry) => {
  if (!caches?.weekRoster) return;
  const idx = caches.weekRoster.findIndex(
    (r) => r.employeeId === entry.employeeId,
  );
  if (idx === -1) caches.weekRoster.push(entry);
  else caches.weekRoster[idx] = { ...caches.weekRoster[idx], ...entry };
};

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
  if (!range) return { ok: true };

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

const acquireWeekAreaLock = async (client, weekStartDate, areaKey) => {
  const lockKey = `weekly-schedule::${weekStartDate.toISOString()}::${areaKey || "no-area"}`;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
};

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

const DAY_ABBR_MAP = {
  SUN: "sunday",
  MON: "monday",
  TUE: "tuesday",
  WED: "wednesday",
  THU: "thursday",
  FRI: "friday",
  SAT: "saturday",
};

const HEADER_ALIASES = {
  "vehicle type": "vehicleType",
  d: "vehicleType",
  vehicle: "vehicleType",
  vendor: "vendor",
  "vehicle entity": "vehicleEntityName",
  "vehicle reg": "vehicleReg",
  "vehicle registration": "vehicleReg",
  drivers: "drivers",
  "employee id": "employeeCode",
  "user name": "name",
  "off day": "offDay",
  campaign: "campaign",
  batch: "batch",
  entity: "entity",
  "shift timings": "shiftTiming",
  "office arival time": "officeArrivalTime",
  "office arrival time": "officeArrivalTime",
  "drop time": "dropTime",
  contact: "contact",
  area: "area",
  address: "address",
};

const parseOffDays = (offDayRaw) => {
  const tokens =
    String(offDayRaw || "")
      .toUpperCase()
      .match(/SUN|MON|TUE|WED|THU|FRI|SAT/g) || [];
  return new Set(tokens.map((t) => DAY_ABBR_MAP[t]));
};

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

const normalizeShiftForCompare = (raw) =>
  String(raw || "")
    .replace(/\s+/g, "")
    .toUpperCase();

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

const parseDriverEntry = (raw) => parseDriverEntries(raw)[0] || null;

const normalizeMatch = (str) => {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

// ============================================================
// findDriver - Matches Name + Vendor + Vehicle Type (ALL 3)
// ============================================================
const findDriver = async (
  driverName,
  vendorNameFromSheet,
  vehicleTypeFromSheet,
  cache,
  extraCaches,
) => {
  const trimmedName = String(driverName || "").trim();
  if (!trimmedName) return null;

  const normalizedName = trimmedName.replace(/\s+/g, " ");
  const normalizedVendor = normalizeMatch(vendorNameFromSheet);
  const normalizedVehicleType = normalizeMatch(vehicleTypeFromSheet);

  const cacheKey = `${normalizedName.toLowerCase()}::${normalizedVendor}::${normalizedVehicleType}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const candidates = await prisma.driver.findMany({
    where: {
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
    },
    include: {
      vehicle: {
        include: { vendor: true },
      },
      vendor: true,
    },
  });

  if (candidates.length === 0) {
    cache?.set(cacheKey, null);
    return null;
  }

  let result = null;

  if (candidates.length === 1) {
    const driver = candidates[0];
    const driverVendor = normalizeMatch(driver.vendor?.name);
    const vehicleVendor = normalizeMatch(driver.vehicle?.vendor?.name);
    const driverVehicleType = normalizeMatch(driver.vehicle?.type);

    let vendorMatches = true;
    if (normalizedVendor) {
      vendorMatches =
        driverVendor === normalizedVendor || vehicleVendor === normalizedVendor;
    }

    let vehicleTypeMatches = true;
    if (normalizedVehicleType) {
      vehicleTypeMatches = driverVehicleType === normalizedVehicleType;
    }

    if (vendorMatches && vehicleTypeMatches) {
      result = driver;
      if (!normalizedVendor || !normalizedVehicleType) {
        result.__matchWarning = true;
      }
    }
  } else {
    let filtered = candidates;

    if (normalizedVendor) {
      filtered = filtered.filter((d) => {
        const driverVendor = normalizeMatch(d.vendor?.name);
        const vehicleVendor = normalizeMatch(d.vehicle?.vendor?.name);
        return (
          driverVendor === normalizedVendor ||
          vehicleVendor === normalizedVendor
        );
      });
    }

    if (normalizedVehicleType) {
      filtered = filtered.filter((d) => {
        const driverVehicleType = normalizeMatch(d.vehicle?.type);
        return driverVehicleType === normalizedVehicleType;
      });
    }

    if (filtered.length === 1) {
      result = filtered[0];
    } else if (filtered.length > 1) {
      result = filtered[0];
      result.__matchWarning = true;
    } else {
      result = null;
    }
  }

  cache?.set(cacheKey, result);
  if (result) extraCaches?.driverById?.set(result.id, result);
  return result;
};

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

const normalizeVehicleType = (raw) => {
  const str = String(raw || "").toUpperCase();
  const parts = str.split(/[\/,]/).map((p) => p.replace(/\s+/g, ""));
  return parts.find((p) => VEHICLE_TYPES.has(p)) || parts[0] || "";
};

const routeNameHasVehicleType = (routeName, vehicleTypeNorm) => {
  if (!routeName || !vehicleTypeNorm) return false;
  const tokens = String(routeName)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  return tokens.includes(vehicleTypeNorm);
};

// ---------- Address Cross-Check ----------

const ADDRESS_STOPWORDS = new Set([
  "flat",
  "floor",
  "house",
  "street",
  "st",
  "no",
  "number",
  "near",
  "phase",
  "block",
  "society",
  "road",
  "karachi",
  "apartment",
  "apartments",
  "building",
  "plot",
  "the",
  "of",
  "and",
  "view",
  "town",
  "city",
  "sector",
  "area",
  "opposite",
  "behind",
  "infront",
  "front",
  "gali",
  "commercial",
]);

const normalizeAddressTokens = (raw) =>
  new Set(
    String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !ADDRESS_STOPWORDS.has(t)),
  );

const ADDRESS_MATCH_THRESHOLD = 0.15;

const analyzeAddressMatch = (sheetAddress, employee) => {
  const sheetTokens = normalizeAddressTokens(sheetAddress);
  if (sheetTokens.size === 0) {
    return { isMatch: true, score: null, reason: null };
  }

  const taxonomyTokens = normalizeAddressTokens(
    [employee.area?.name, employee.subArea?.name, employee.block?.name]
      .filter(Boolean)
      .join(" "),
  );
  const masterTokens = normalizeAddressTokens(employee.address);
  const compareTokens = new Set([...masterTokens, ...taxonomyTokens]);
  if (compareTokens.size === 0) {
    return { isMatch: true, score: null, reason: null };
  }

  const intersection = [...sheetTokens].filter((t) => compareTokens.has(t));
  const union = new Set([...sheetTokens, ...compareTokens]);
  const score = intersection.length / union.size;
  if (score >= ADDRESS_MATCH_THRESHOLD) {
    return { isMatch: true, score, reason: null };
  }

  const masterAreaLabel =
    [employee.area?.name, employee.subArea?.name, employee.block?.name]
      .filter(Boolean)
      .join(" > ") || "no area on file";
  return {
    isMatch: false,
    score,
    reason: `Sheet address ("${sheetAddress}") shares almost nothing with this employee's master-data address/area`,
  };
};

// ---------- Conflict detection ----------

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
    if (!candidateShiftTiming || !other.shiftTiming) return other;
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
  }
  return null;
};

// ---------- Auto-assignment (only for rows without sheet driver) ----------

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
      busyIds.add(row.driverId);
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

// ============================================================
// findOrCreateVehicleForDriver - Creates placeholder vehicle
// using sheet vendor + vehicle type + driver name
// ============================================================
const findOrCreateVehicleForDriver = async (
  driverId,
  vendorName,
  vehicleType,
  caches,
) => {
  if (!driverId) return null;

  // 1. First check if this driver already has a vehicle linked
  let driver = caches?.driverById?.get(driverId);
  if (!driver) {
    driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { vehicle: true },
    });
    if (driver) caches?.driverById?.set(driverId, driver);
  }

  if (driver?.vehicleId) {
    const vehicle = caches?.vehicle?.get(driver.vehicleId);
    if (vehicle) return vehicle;
    const existingVehicle = await prisma.vehicle.findUnique({
      where: { id: driver.vehicleId },
    });
    if (existingVehicle) {
      caches?.vehicle?.set(existingVehicle.id, existingVehicle);
      return existingVehicle;
    }
  }

  // 2. Try to find an existing vehicle with matching vendor + type
  // that is either unassigned or assigned to this driver
  const vendor = await findVendor(vendorName, caches?.vendor);
  const vehicleTypeNorm = normalizeVehicleType(vehicleType);

  if (vendor && vehicleTypeNorm && VEHICLE_TYPES.has(vehicleTypeNorm)) {
    const existingVehicle = await prisma.vehicle.findFirst({
      where: {
        vendorId: vendor.id,
        type: vehicleTypeNorm,
        OR: [{ driverId: driverId }, { driverId: null }],
        status: "ACTIVE",
      },
      orderBy: { driverId: { sort: "desc", nulls: "last" } },
    });

    if (existingVehicle) {
      if (!existingVehicle.driverId) {
        await prisma.vehicle.update({
          where: { id: existingVehicle.id },
          data: { driverId: driverId },
        });
        existingVehicle.driverId = driverId;
      }
      caches?.vehicle?.set(existingVehicle.id, existingVehicle);
      return existingVehicle;
    }
  }

  // 3. No existing vehicle found — CREATE A PLACEHOLDER
  const driverName = driver?.name || "UNKNOWN";
  const timestamp = Date.now().toString().slice(-6);
  const vehicleNumber = `TEMP-${driverName.toUpperCase().replace(/\s+/g, "-")}-${timestamp}`;

  const DEFAULT_CAPACITY = {
    CAR: 4,
    VAN: 12,
    HIJET: 10,
    KARVAN: 15,
    BUS: 40,
  };

  const newVehicle = await prisma.vehicle.create({
    data: {
      vehicleNumber: vehicleNumber,
      type: vehicleTypeNorm || "CAR",
      capacity: DEFAULT_CAPACITY[vehicleTypeNorm] || 4,
      status: "ACTIVE",
      vendorId: vendor?.id || null,
      driverId: driverId,
      notes: `Placeholder vehicle created from sheet upload. Original vendor: ${vendorName || "N/A"}, Type: ${vehicleType || "N/A"}. Replace with actual vehicle when available.`,
    },
  });

  caches?.vehicle?.set(newVehicle.id, newVehicle);
  if (driver) {
    driver.vehicleId = newVehicle.id;
    caches?.driverById?.set(driverId, driver);
  }

  return newVehicle;
};

// ============================================================
// resolveConflictFreeAssignment - NEVER replaces sheet driver
// ============================================================
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
  options,
}) => {
  const notes = [];

  let driverId = trip.driverId || proposedDriverId || undefined;
  let vehicleId = trip.vehicleId || proposedVehicleId || undefined;

  if (proposedDriverId && trip.driverId && proposedDriverId !== trip.driverId) {
    notes.push(
      `This row named a different driver than the one already assigned to Trip #${trip.tripNumber ?? ""} on this route — kept the trip's assigned driver.`,
    );
  }
  if (
    proposedVehicleId &&
    trip.vehicleId &&
    proposedVehicleId !== trip.vehicleId
  ) {
    notes.push(
      `This row named a different vehicle than the one already assigned to Trip #${trip.tripNumber ?? ""} on this route — kept the trip's assigned vehicle.`,
    );
  }

  let autoAssignedDriver = false;
  let autoAssignedVehicle = false;
  const shiftTiming =
    candidateShiftTiming || trip.shiftTiming || trip.route?.shiftTiming;

  // If sheet provided a driver, KEEP THEM — never replace
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
        `Driver's shift may overlap route "${conflict.route?.routeCode ?? conflict.routeId}" this week — kept as assigned in the sheet; please double-check manually.`,
      );
    }

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
        `Driver may exceed working-hours limits this week — ${hoursCheck.reason} Kept as assigned in the sheet; please double-check manually.`,
      );
    }
  } else {
    // Only auto-assign if NO driver was proposed (sheet had no driver)
    const best = await autoAssignDriverAndVehicle(
      weekStartDate,
      shiftTiming,
      trip.id,
      minCapacity ?? trip.vehicle?.capacity,
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
      notes.push("No available driver found for this row — left unassigned.");
    }
  }

  // Vehicle handling
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
        `Vehicle's shift may overlap route "${conflict.route?.routeCode ?? conflict.routeId}" this week — kept as assigned in the sheet; please double-check manually.`,
      );
    }
  } else if (driverId) {
    // Driver has no vehicle — find or create one
    const vehicle = await findOrCreateVehicleForDriver(
      driverId,
      null, // vendor will be looked up from driver
      vehicleTypeHint,
      caches,
    );
    if (vehicle) {
      vehicleId = vehicle.id;
      autoAssignedVehicle = true;
      if (vehicle.notes?.includes("Placeholder")) {
        notes.push(
          `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver. Replace with actual vehicle when available.`,
        );
      }
    } else {
      notes.push(
        "No vehicle found for this driver and unable to create placeholder — left unassigned.",
      );
    }
  }

  if (
    driverId !== (trip.driverId || undefined) ||
    vehicleId !== (trip.vehicleId || undefined)
  ) {
    const updatedTrip = await prisma.trip.update({
      where: { id: trip.id },
      data: {
        driverId: driverId || null,
        vehicleId: vehicleId || null,
      },
      include: { vehicle: true, route: true },
    });
    await syncRouteFromTrips(trip.routeId, caches);
    caches?.tripsByRoute?.delete(trip.routeId);

    if (driverId) caches?.tripIdByDriver?.set(driverId, trip.id);
    caches?.tripById?.set(trip.id, updatedTrip);
  } else {
    if (driverId) caches?.tripIdByDriver?.set(driverId, trip.id);
  }

  return {
    driverId,
    vehicleId,
    autoAssignedDriver,
    autoAssignedVehicle,
    notes,
  };
};

// ---------- Lookup functions ----------

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

// ---------- Route / Trip creation ----------

const slugify = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

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

const generateUniqueRouteCode = async (baseCode) => {
  let candidate = baseCode;
  let n = 1;
  while (await prisma.route.findUnique({ where: { routeCode: candidate } })) {
    n += 1;
    candidate = `${baseCode}-L${n}`;
  }
  return candidate;
};

const syncRouteFromTrips = async (routeId, caches, tripsHint) => {
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

// ============================================================
// findExistingTripForDriverThisWeek - driver-first reuse with vendor + vehicle type check
// ============================================================
const findExistingTripForDriverThisWeek = async (
  driverId,
  shiftTiming,
  vehicleType,
  weekStartDate,
  excludeEmployeeId,
  caches,
  options = {},
  areaRecord,
  vendorName,
) => {
  if (!driverId || !caches?.tripIdByDriver) return null;
  const tripId = caches.tripIdByDriver.get(driverId);
  if (!tripId) return null;

  let trip = caches?.tripById?.get(tripId);
  if (!trip) {
    trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        vehicle: { include: { vendor: true } },
        route: { include: { area: true } },
      },
    });
    if (trip) caches?.tripById?.set(tripId, trip);
  }
  if (!trip || trip.status !== "ACTIVE" || trip.driverId !== driverId) {
    return null;
  }

  if (areaRecord && trip.route?.areaId && trip.route.areaId !== areaRecord.id) {
    return null;
  }

  const vehicleTypeNorm = normalizeVehicleType(vehicleType);
  const tripVehicleType = trip.vehicle?.type
    ? normalizeVehicleType(trip.vehicle.type)
    : null;
  if (
    vehicleTypeNorm &&
    tripVehicleType &&
    tripVehicleType !== vehicleTypeNorm
  ) {
    return null;
  }

  const vendorNorm = normalizeMatch(vendorName);
  const tripVendorNorm = normalizeMatch(trip.vehicle?.vendor?.name);
  if (vendorNorm && tripVendorNorm && tripVendorNorm !== vendorNorm) {
    return null;
  }

  const tripShiftTiming = trip.shiftTiming || trip.route?.shiftTiming;
  const candidateRange = parseShiftRange(shiftTiming);
  const tripRange = parseShiftRange(tripShiftTiming);
  const sameShift =
    candidateRange && tripRange
      ? candidateRange.start === tripRange.start &&
        candidateRange.durationMinutes === tripRange.durationMinutes
      : normalizeShift(shiftTiming) === normalizeShift(tripShiftTiming);
  if (!sameShift) return null;

  const capacity = trip.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
  const occupancy = caches?.weekRoster
    ? caches.weekRoster.filter(
        (r) =>
          r.tripId === trip.id &&
          (!excludeEmployeeId || r.employeeId !== excludeEmployeeId),
      ).length
    : await countTripOccupancy(trip.id, weekStartDate, excludeEmployeeId);
  const overCapacity = occupancy >= capacity;

  if (overCapacity && !options.disableMultiTrip) return null;

  return { trip, route: trip.route, overCapacity };
};

// ============================================================
// findOrCreateRouteAndTrip - FIXED: Respects Vehicle Type and Area
// ============================================================
const findOrCreateRouteAndTrip = async (
  areaRecord,
  vehicleType,
  shiftTiming,
  campaign,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId,
  caches,
  options = {},
  vendorName,
) => {
  // Step 0: driver-first reuse (with vendor + vehicle type check)
  if (driverId) {
    const existingTrip = await findExistingTripForDriverThisWeek(
      driverId,
      shiftTiming,
      vehicleType,
      weekStartDate,
      excludeEmployeeId,
      caches,
      options,
      areaRecord,
      vendorName,
    );
    if (existingTrip) {
      return {
        route: existingTrip.route,
        trip: existingTrip.trip,
        created: false,
        newTrip: false,
        overCapacity: existingTrip.overCapacity || false,
        notes: existingTrip.overCapacity
          ? [
              `Trip #${existingTrip.trip.tripNumber} (driver already on it this week/shift) is at/over its vehicle's capacity — added anyway per current settings; needs manual review.`,
            ]
          : [],
      };
    }
  }

  let route = null;
  let routeCreated = false;
  const vehicleTypeNorm = normalizeVehicleType(vehicleType);

  // Step 1: Find existing route - MUST match area + shift + vehicle type
  if (areaRecord) {
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
      const shiftNorm = normalizeShift(shiftTiming);

      // MUST match BOTH shift AND vehicle type
      route = candidates.find((r) => {
        const rShiftNorm = normalizeShift(r.shiftTiming);
        if (rShiftNorm !== shiftNorm) return false;

        if (vehicleTypeNorm) {
          return routeNameHasVehicleType(r.routeName, vehicleTypeNorm);
        }
        return true;
      });

      // FIX: DO NOT reuse route if vehicle type doesn't match
      if (!route) {
        const shiftMatch = candidates.find(
          (r) => normalizeShift(r.shiftTiming) === shiftNorm,
        );
        if (shiftMatch) {
          console.warn(
            `[weeklySchedule] Found route by shift only (no vehicle type match): ` +
              `route "${shiftMatch.routeCode}" (${shiftMatch.routeName}) for vehicle type "${vehicleTypeNorm}" - creating new route instead.`,
          );
          route = null;
        }
      }
    } else {
      if (vehicleTypeNorm) {
        route =
          candidates.find((r) =>
            routeNameHasVehicleType(r.routeName, vehicleTypeNorm),
          ) || null;
      }
      if (!route) {
        route = candidates[0] || null;
      }
    }
  }

  // Step 2: Create new route if none found
  if (!route) {
    const baseName =
      [areaRecord?.name, vehicleType, shiftTiming]
        .filter(Boolean)
        .join(" - ") ||
      campaign ||
      "General Route";
    const baseCode = slugify(baseName) || `ROUTE-${Date.now()}`;
    const routeCode = await generateUniqueRouteCode(baseCode);
    route = await prisma.route.create({
      data: {
        routeName: baseName,
        routeCode,
        shiftTiming: shiftTiming || undefined,
        maxCapacity: guessMaxCapacity(vehicleType),
        areaId: areaRecord?.id,
      },
      include: { area: true },
    });
    routeCreated = true;
    if (areaRecord) caches?.routesByArea?.delete(areaRecord.id);
    console.log(
      `[weeklySchedule] Created new route: "${route.routeCode}" ` +
        `for vehicle type "${vehicleTypeNorm}" in area "${areaRecord?.name || "unknown"}"`,
    );
  }

  // Step 3: Find or create trip on the route
  const {
    trip,
    newTrip,
    overCapacity,
    notes: tripNotes,
  } = await findOrCreateTripOnRoute(
    route,
    vehicleType,
    shiftTiming,
    driverId,
    vehicleIdHint,
    weekStartDate,
    excludeEmployeeId,
    caches,
    options,
    vendorName,
  );

  route = caches?.routeById?.get(route.id) || route;

  return {
    route,
    trip,
    created: routeCreated,
    newTrip,
    overCapacity,
    notes: tripNotes || [],
  };
};

// ============================================================
// findOrCreateTripOnRoute - FIXED: Keeps sheet driver, creates vehicle if missing
// ============================================================
const findOrCreateTripOnRoute = async (
  route,
  vehicleType,
  shiftTiming,
  driverId,
  vehicleIdHint,
  weekStartDate,
  excludeEmployeeId,
  caches,
  options = {},
  vendorName,
) => {
  let trips = caches?.tripsByRoute?.get(route.id);
  if (!trips) {
    trips = await prisma.trip.findMany({
      where: { routeId: route.id, status: "ACTIVE" },
      include: { vehicle: { include: { vendor: true } } },
      orderBy: { tripNumber: "asc" },
    });
    caches?.tripsByRoute?.set(route.id, trips);
  }
  const hadExistingTrips = trips.length > 0;

  let trip = null;
  let overCapacity = false;
  const notes = [];

  const vehicleTypeNorm = normalizeVehicleType(vehicleType);
  const vendorNorm = normalizeMatch(vendorName);

  const tripMatchesRow = (candidate) => {
    if (!candidate?.vehicle) return true;
    const tripVehicleType = candidate.vehicle.type
      ? normalizeVehicleType(candidate.vehicle.type)
      : null;
    if (
      vehicleTypeNorm &&
      tripVehicleType &&
      tripVehicleType !== vehicleTypeNorm
    ) {
      return false;
    }
    const tripVendorNorm = normalizeMatch(candidate.vehicle.vendor?.name);
    if (vendorNorm && tripVendorNorm && tripVendorNorm !== vendorNorm) {
      return false;
    }
    return true;
  };

  if (options.disableMultiTrip) {
    const candidate = trips[0] || null;
    if (candidate && !tripMatchesRow(candidate)) {
      notes.push(
        `Trip #${candidate.tripNumber} on route "${route.routeCode}" is for a different vendor/vehicle type than this row's sheet data — opened a new trip instead of reusing it.`,
      );
      trip = null;
    } else {
      trip = candidate;
    }
    if (trip) {
      const capacity = trip.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
      const occupancy = caches?.weekRoster
        ? caches.weekRoster.filter(
            (r) =>
              r.tripId === trip.id &&
              (!excludeEmployeeId || r.employeeId !== excludeEmployeeId),
          ).length
        : await countTripOccupancy(trip.id, weekStartDate, excludeEmployeeId);
      if (occupancy >= capacity) {
        overCapacity = true;
        notes.push(
          `Trip #${trip.tripNumber} on route "${route.routeCode}" is at/over its vehicle's capacity (${capacity} seats) — added anyway per current settings; needs manual review.`,
        );
      }
    }
  } else {
    for (const candidate of trips) {
      if (!tripMatchesRow(candidate)) continue;
      const capacity =
        candidate.vehicle?.capacity ?? guessMaxCapacity(vehicleType);
      const occupancy = caches?.weekRoster
        ? caches.weekRoster.filter(
            (r) =>
              r.tripId === candidate.id &&
              (!excludeEmployeeId || r.employeeId !== excludeEmployeeId),
          ).length
        : await countTripOccupancy(
            candidate.id,
            weekStartDate,
            excludeEmployeeId,
          );
      const hasRoom = occupancy < capacity;
      if (hasRoom) {
        trip = candidate;
        break;
      }
    }
  }

  // FIX: KEEP sheet driver — never replace
  let safeDriverId = driverId || undefined;
  if (safeDriverId) {
    const driverConflict = await findDriverConflict(
      safeDriverId,
      weekStartDate,
      shiftTiming,
      trip?.id,
      excludeEmployeeId,
      caches,
    );
    if (driverConflict) {
      notes.push(
        `Driver's shift may overlap route "${driverConflict.route?.routeCode ?? driverConflict.routeId}" this week — kept as named in the sheet; please double-check manually.`,
      );
    }
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
    if (vehicleConflict) {
      notes.push(
        `Vehicle's shift may overlap route "${vehicleConflict.route?.routeCode ?? vehicleConflict.routeId}" this week — kept as named in the sheet; please double-check manually.`,
      );
    }
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
    trips.push(trip);
  } else {
    const patch = {};
    // FIX: If sheet named a driver, UPDATE the trip to match (don't just fill empty)
    if (safeDriverId && (!trip.driverId || safeDriverId !== trip.driverId)) {
      if (trip.driverId && trip.driverId !== safeDriverId) {
        notes.push(
          `Trip #${trip.tripNumber} on route "${route.routeCode}" had a different driver on file — updated to match the sheet.`,
        );
      }
      patch.driverId = safeDriverId;
    }
    if (safeVehicleId && !trip.vehicleId) patch.vehicleId = safeVehicleId;

    // FIX: If driver has no vehicle, create placeholder
    if (safeDriverId && !trip.vehicleId && !safeVehicleId) {
      const vehicle = await findOrCreateVehicleForDriver(
        safeDriverId,
        vendorName,
        vehicleType,
        caches,
      );
      if (vehicle) {
        patch.vehicleId = vehicle.id;
        safeVehicleId = vehicle.id;
        if (vehicle.notes?.includes("Placeholder")) {
          notes.push(
            `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver "${safeDriverId}". Replace with actual vehicle when available.`,
          );
        }
      }
    }

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

  if (tripChanged) {
    await syncRouteFromTrips(route.id, caches, trips);
  }
  if (trip.driverId) {
    caches?.tripIdByDriver?.set(trip.driverId, trip.id);
  }
  caches?.tripById?.set(trip.id, trip);

  return {
    trip,
    newTrip: tripCreated && hadExistingTrips,
    overCapacity,
    notes,
  };
};

// ---------- Bulk reassign ----------

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

    await prisma.$transaction((tx) => acquireWeekAreaLock(tx, weekStartDate));

    const route = await prisma.route.findUnique({
      where: routeId ? { id: routeId } : { routeCode },
      include: { area: true },
    });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

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
        "No shift-mismatched employees found on this route.",
      );
      return res.status(response.status.code).json(response);
    }

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
          undefined,
          shiftTiming,
          undefined,
          entry.driverId || undefined,
          entry.vehicleId || undefined,
          weekStartDate,
          entry.employeeId,
          undefined,
          {
            trustProposedDriver: true,
            disableMultiTrip: false,
          },
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

    if (results.updated > 0) {
      await syncPendingRidesForWeekBestEffort(weekStartDate);
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

// ============================================================
// resolvePendingVehicleAssignments - Links vehicles to DRAFT rows
// ============================================================
const resolvePendingVehicleAssignments = async (req, res, next) => {
  try {
    const { weekStart, routeId, routeCode, employeeId, employeeCode } =
      req.body;
    if (!weekStart) {
      const response = badRequestResponse(
        "weekStart (the Monday this schedule applies to) is required.",
      );
      return res.status(response.status.code).json(response);
    }
    const weekStartDate = toDateOnly(weekStart);

    let route = null;
    if (routeId || routeCode) {
      route = await prisma.route.findUnique({
        where: routeId ? { id: routeId } : { routeCode },
      });
      if (!route) {
        const response = badRequestResponse("Route not found.");
        return res.status(response.status.code).json(response);
      }
    }

    let targetEmployee = null;
    if (employeeId || employeeCode) {
      targetEmployee = employeeId
        ? await prisma.employee.findUnique({ where: { id: employeeId } })
        : await prisma.employee.findFirst({
            where: { employeeCode: String(employeeCode) },
          });
      if (!targetEmployee) {
        const response = badRequestResponse(
          "Employee not found for the given employeeId/employeeCode.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    await prisma.$transaction((tx) => acquireWeekAreaLock(tx, weekStartDate));

    const candidates = await prisma.weeklySchedule.findMany({
      where: {
        weekStart: weekStartDate,
        status: "DRAFT",
        driverId: { not: null },
        vehicleId: null,
        ...(route ? { routeId: route.id } : {}),
        ...(targetEmployee ? { employeeId: targetEmployee.id } : {}),
      },
      include: { trip: true, route: true },
    });

    const summary = {
      scanned: candidates.length,
      vehiclesLinked: 0,
      stillMissingVehicle: 0,
      conflicts: 0,
      details: [],
    };

    const driverCache = new Map();

    for (const entry of candidates) {
      const before = { ...entry };
      const shiftTiming = entry.shiftTiming || entry.route?.shiftTiming;

      let driver = driverCache.get(entry.driverId);
      if (!driver) {
        driver = await prisma.driver.findUnique({
          where: { id: entry.driverId },
          include: { vehicle: true },
        });
        driverCache.set(entry.driverId, driver);
      }

      if (!driver?.vehicle || driver.vehicle.status !== "ACTIVE") {
        // Try to create a placeholder vehicle for this driver
        const vehicleType = entry.route?.routeName
          ? normalizeVehicleType(entry.route.routeName.split("-").pop())
          : "CAR";

        const vendorName = entry.vendor?.name || "MTS";

        const newVehicle = await findOrCreateVehicleForDriver(
          entry.driverId,
          vendorName,
          vehicleType,
          { driverById: driverCache, vehicle: new Map() },
        );

        if (newVehicle) {
          summary.details.push({
            weeklyScheduleId: entry.id,
            employeeId: entry.employeeId,
            driverId: entry.driverId,
            note: `Created placeholder vehicle "${newVehicle.vehicleNumber}" for driver.`,
          });
          // Continue to link it below
          driver = await prisma.driver.findUnique({
            where: { id: entry.driverId },
            include: { vehicle: true },
          });
          driverCache.set(entry.driverId, driver);
        } else {
          summary.stillMissingVehicle++;
          summary.details.push({
            weeklyScheduleId: entry.id,
            employeeId: entry.employeeId,
            driverId: entry.driverId,
            note: driver?.vehicle
              ? `Driver's linked vehicle is not ACTIVE (status: ${driver.vehicle.status}) - left DRAFT.`
              : "Driver still has no vehicle linked - left DRAFT.",
          });
          continue;
        }
      }

      const conflict = await findVehicleConflict(
        driver.vehicle.id,
        weekStartDate,
        shiftTiming,
        entry.tripId || undefined,
        entry.employeeId,
      );
      if (conflict) {
        summary.conflicts++;
        summary.details.push({
          weeklyScheduleId: entry.id,
          employeeId: entry.employeeId,
          driverId: entry.driverId,
          note: `Driver's vehicle overlaps route "${conflict.route?.routeCode ?? conflict.routeId}" this week - left DRAFT, please check manually.`,
        });
        continue;
      }

      const updatedSchedule = await prisma.weeklySchedule.update({
        where: { id: entry.id },
        data: { vehicleId: driver.vehicle.id, status: "ACTIVE" },
      });

      if (entry.tripId && !entry.trip?.vehicleId) {
        await prisma.trip.update({
          where: { id: entry.tripId },
          data: { vehicleId: driver.vehicle.id },
        });
      }

      await recordAssignmentHistory(
        prisma,
        "VEHICLE_LINKED_FROM_DRIVER",
        entry.id,
        before,
        updatedSchedule,
        req.user?.id,
      );

      summary.vehiclesLinked++;
      summary.details.push({
        weeklyScheduleId: entry.id,
        employeeId: entry.employeeId,
        driverId: entry.driverId,
        vehicleId: driver.vehicle.id,
        note: "Vehicle linked from driver's current vehicle - status set to ACTIVE.",
      });
    }

    if (summary.vehiclesLinked > 0) {
      await syncPendingRidesForWeekBestEffort(weekStartDate);
    }

    const response = okResponse(
      summary,
      `Linked ${summary.vehiclesLinked} vehicle(s) from driver records. ${summary.stillMissingVehicle} still missing a vehicle, ${summary.conflicts} had conflicts.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Real-Time Route Optimization ----------

const optimizeWeekAssignments = async (weekStartDate) => {
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
    if (!entry.route) continue;

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
        {
          trustProposedDriver: true,
          disableMultiTrip: false,
        },
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

    // FIX: NEVER replace a driver that came from the sheet
    if (driverId) {
      const conflict = await findDriverConflict(
        driverId,
        weekStartDate,
        shiftTiming,
        trip.id,
        entry.employeeId,
      );
      if (conflict) {
        summary.details.push({
          weeklyScheduleId: entry.id,
          note: `Driver ${driverId} has conflict but kept per sheet`,
        });
      }
    } else {
      // Only auto-assign if no driver was set
      const best = await autoAssignDriverAndVehicle(
        weekStartDate,
        shiftTiming,
        trip.id,
        undefined,
        undefined,
        entry.employeeId,
      );
      if (best.driverId) {
        driverId = best.driverId;
        summary.driversReassigned++;
      }
    }

    // Vehicle handling
    if (vehicleId) {
      const conflict = await findVehicleConflict(
        vehicleId,
        weekStartDate,
        shiftTiming,
        trip.id,
        entry.employeeId,
      );
      if (conflict) {
        summary.details.push({
          weeklyScheduleId: entry.id,
          note: `Vehicle ${vehicleId} has conflict but kept per sheet`,
        });
      }
    } else if (driverId) {
      // Try to find or create vehicle for this driver
      const vehicle = await findOrCreateVehicleForDriver(
        driverId,
        null,
        entry.route?.routeName
          ? normalizeVehicleType(entry.route.routeName.split("-").pop())
          : "CAR",
        { driverById: new Map() },
      );
      if (vehicle) {
        vehicleId = vehicle.id;
        summary.vehiclesReassigned++;
        summary.details.push({
          weeklyScheduleId: entry.id,
          note: `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver.`,
        });
      }
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

  await syncPendingRidesForWeekBestEffort(weekStartDate);

  return summary;
};

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

const resyncPendingRides = async (req, res, next) => {
  try {
    const { weekStart } = req.body;
    if (!weekStart) {
      const response = badRequestResponse("weekStart is required.");
      return res.status(response.status.code).json(response);
    }
    const results = await syncPendingRidesForWeek(toDateOnly(weekStart));
    const created = results.filter((r) => r.rideId && !r.skipped).length;
    const cancelled = results.filter((r) => r.cancelled).length;
    const skipped = results.filter((r) => r.skipped).length;
    const response = okResponse(
      { results, created, cancelled, skipped },
      `Synced PENDING rides for the week: ${created} created/refreshed, ${cancelled} cancelled, ${skipped} skipped.`,
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

    if (routeId) {
      try {
        await optimizeWeekAssignments(toDateOnly(weekStart));
      } catch (optimizeError) {
        // Best-effort
      }
    }

    await syncPendingRidesForWeekBestEffort(toDateOnly(weekStart));

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
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            contactNumber: true,
          },
        },
        route: {
          include: {
            area: true,
            subArea: true,
          },
        },
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
        // Best-effort
      }
    }

    await syncPendingRidesForWeekBestEffort(
      updateData.weekStart || schedule.weekStart,
    );

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

    await syncPendingRidesForWeekBestEffort(schedule.weekStart);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getCurrentWeekSchedules = async (req, res, next) => {
  try {
    const startOfWeek = mondayOfCurrentWeek();

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

// ---------- Grouped view ----------

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

    const routeMap = new Map();

    for (const s of schedules) {
      const routeKey = s.route?.id ?? "unassigned";
      if (!routeMap.has(routeKey)) {
        routeMap.set(routeKey, {
          code: s.route?.routeCode ?? "—",
          name: s.route?.routeName ?? "Unassigned Route",
          area: s.route?.area ?? "",
          shift: s.route?.shiftTiming ?? s.shiftTiming ?? "",
          service: s.serviceType,
          driverBadge: s.route?.driver?.name ?? s.driver?.name ?? "—",
          vehicleBadge: s.vehicle?.vehicleNumber ?? "—",
          capacity: s.route?.maxCapacity ?? null,
          tripMap: new Map(),
          empIds: new Set(),
          weekMap: new Map(),
        });
      }
      const routeEntry = routeMap.get(routeKey);
      routeEntry.empIds.add(s.employeeId);

      if (s.tripId) {
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
        tripNumber: s.trip?.tripNumber ?? null,
        pattern: DAY_KEYS.map((day) => s[day] ?? "OFF"),
        status: (s.status ?? "ACTIVE").toLowerCase(),
      });
    }

    const routeIdsForTrips = Array.from(routeMap.keys()).filter(
      (k) => k !== "unassigned",
    );
    const tripsByRoute = routeIdsForTrips.length
      ? await prisma.trip.findMany({
          where: { routeId: { in: routeIdsForTrips }, status: "ACTIVE" },
          include: {
            vehicle: {
              select: { id: true, vehicleNumber: true, capacity: true },
            },
            driver: { select: { id: true, name: true } },
          },
          orderBy: { tripNumber: "asc" },
        })
      : [];
    for (const t of tripsByRoute) {
      const routeEntry = routeMap.get(t.routeId);
      if (!routeEntry) continue;
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
        .filter((t) => t.tripNumber != null)
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

// ---------- Stats ----------

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

// ---------- Schedule Table ----------

const getScheduleTableStats = async (req, res, next) => {
  try {
    const weekStartDate = req.query.weekStart
      ? toDateOnly(req.query.weekStart)
      : mondayOfCurrentWeek();

    const [
      activeEmployees,
      areasCount,
      availableDrivers,
      activeVehicles,
      scheduledThisWeek,
    ] = await Promise.all([
      prisma.employee.count({ where: { status: "ACTIVE" } }),
      prisma.area.count(),
      prisma.driver.count({ where: { status: "AVAILABLE" } }),
      prisma.vehicle.count({ where: { status: "ACTIVE" } }),
      prisma.weeklySchedule.count({
        where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
      }),
    ]);

    const response = okResponse(
      {
        activeEmployees,
        areas: areasCount,
        availableDrivers,
        activeVehicles,
        scheduledThisWeek,
        weekStart: weekStartDate.toISOString().slice(0, 10),
      },
      "Schedule table stats retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getScheduleTableGroupedByArea = async (req, res, next) => {
  try {
    const { search, areaId } = req.query;
    const weekStartDate = req.query.weekStart
      ? toDateOnly(req.query.weekStart)
      : mondayOfCurrentWeek();

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
        weeklySchedules: {
          where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
          take: 1,
          include: {
            route: { select: { id: true, routeName: true, routeCode: true } },
            trip: { select: { id: true, tripNumber: true } },
            driver: { select: { id: true, name: true, phone: true } },
            vehicle: { select: { id: true, vehicleNumber: true, type: true } },
          },
        },
      },
      orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
    });

    const groupMap = new Map();

    for (const emp of employees) {
      const schedule = emp.weeklySchedules[0] || null;

      const groupKey = schedule
        ? `trip:${schedule.tripId ?? schedule.routeId ?? schedule.id}`
        : `area:${emp.area?.id ?? "unassigned"}`;

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          areaId: emp.area?.id ?? null,
          area: emp.area?.name ?? "Unassigned",
          route: schedule?.route
            ? {
                id: schedule.route.id,
                name: schedule.route.routeName,
                code: schedule.route.routeCode,
              }
            : null,
          tripNumber: schedule?.trip?.tripNumber ?? null,
          driver: schedule?.driver
            ? {
                id: schedule.driver.id,
                name: schedule.driver.name,
                phone: schedule.driver.phone,
              }
            : null,
          vehicle: schedule?.vehicle
            ? {
                id: schedule.vehicle.id,
                number: schedule.vehicle.vehicleNumber,
                type: schedule.vehicle.type,
              }
            : null,
          shift: schedule?.shiftTiming ?? null,
          areas: new Set(),
          rows: [],
        });
      }

      const group = groupMap.get(groupKey);
      group.areas.add(emp.area?.name ?? "Unassigned");

      group.rows.push({
        id: schedule?.id ?? emp.id,
        empId: emp.employeeCode,
        name: emp.name,
        department: emp.department?.name ?? "-",
        location: emp.officeLocation ?? "-",
        entity: emp.entity ?? "-",
        contact: emp.contactNumber ?? "-",
        area: emp.area?.name ?? "Unassigned",
        scheduled: Boolean(schedule),
        scheduleStatus: schedule?.status ?? null,
        service: schedule?.serviceType ?? emp.serviceType,
        shift: schedule?.shiftTiming ?? null,
        pickupTime: schedule?.pickupTime ?? null,
        dropTime: schedule?.dropTime ?? null,
        offDay: schedule?.offDay ?? null,
        route: schedule?.route
          ? {
              id: schedule.route.id,
              name: schedule.route.routeName,
              code: schedule.route.routeCode,
            }
          : null,
        tripNumber: schedule?.trip?.tripNumber ?? null,
        driver: schedule?.driver
          ? {
              id: schedule.driver.id,
              name: schedule.driver.name,
              phone: schedule.driver.phone,
            }
          : null,
        vehicle: schedule?.vehicle
          ? {
              id: schedule.vehicle.id,
              number: schedule.vehicle.vehicleNumber,
              type: schedule.vehicle.type,
            }
          : null,
        pattern: schedule ? DAY_FIELD_KEYS.map((day) => schedule[day]) : null,
      });
    }

    const groups = Array.from(groupMap.values()).map((g) => ({
      ...g,
      areas: Array.from(g.areas),
      employeeCount: g.rows.length,
      scheduledCount: g.rows.filter((r) => r.scheduled).length,
    }));

    const response = okResponse(
      { weekStart: weekStartDate.toISOString().slice(0, 10), groups },
      "Schedule table grouped by area retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Bulk Upload ----------

const bulkUploadJobs = new Map();
const BULK_UPLOAD_JOB_TTL_MS = 30 * 60 * 1000;

const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 100;

const createBulkUploadJob = (totalRows, batchSize, weekStartDate) => {
  const cutoff = Date.now() - BULK_UPLOAD_JOB_TTL_MS;
  for (const [id, job] of bulkUploadJobs) {
    if (job.status !== "processing" && job.startedAt < cutoff) {
      bulkUploadJobs.delete(id);
    }
  }

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
    status: "processing",
    totalRows,
    processedRows: 0,
    batchSize,
    totalBatches: totalRows ? Math.ceil(totalRows / batchSize) : 0,
    batchesCompleted: 0,
    startedAt: Date.now(),
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

const getBulkUploadStatus = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const job = bulkUploadJobs.get(jobId);
    if (!job) {
      const response = badRequestResponse("Unknown or expired upload job id.");
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

// ============================================================
// processBulkUploadJob - MAIN BULK UPLOAD LOGIC (FIXED)
// ============================================================
const processBulkUploadJob = async (
  jobId,
  workbook,
  weekStartDate,
  batchSize = DEFAULT_BATCH_SIZE,
) => {
  const results = {
    created: 0,
    updated: 0,
    employeesNotFound: 0,
    driversNotFound: 0,
    driversAmbiguous: 0,
    driversUnverified: 0,
    vehicleTypeMismatch: 0,
    addressMismatch: 0,
    driversPhoneBackfilled: 0,
    vendorsNotFound: 0,
    routesCreated: 0,
    routeLegsOpenedForOverflow: 0,
    driversAutoAssigned: 0,
    vehiclesAutoAssigned: 0,
    vehiclesCreated: 0,
    conflictsResolved: 0,
    pendingAssignment: 0,
    pickDropLegsMerged: 0,
    conflictingDuplicatesSkipped: 0,
    duplicateDriverConflicts: 0,
    capacityExceeded: 0,
    skipped: [],
    notes: [],
    unmatchedDriverNames: [],
    sheetsProcessed: [],
    sheetsSkipped: [],
  };

  const unmatchedDriverNameMap = new Map();
  const recordUnmatchedDriverName = (
    rawName,
    rowNum,
    employeeCode,
    vendorName,
    reason,
  ) => {
    const key = String(rawName || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (!key) return;
    if (!unmatchedDriverNameMap.has(key)) {
      unmatchedDriverNameMap.set(key, {
        name: String(rawName || "")
          .trim()
          .replace(/\s+/g, " "),
        reason,
        occurrences: 0,
        rows: [],
        employeeCodes: [],
        vendorsSeen: [],
      });
    }
    const entry = unmatchedDriverNameMap.get(key);
    entry.occurrences += 1;
    if (entry.rows.length < 50) entry.rows.push(rowNum);
    if (employeeCode && !entry.employeeCodes.includes(employeeCode)) {
      entry.employeeCodes.push(employeeCode);
    }
    const vendorTrimmed = String(vendorName || "").trim();
    if (vendorTrimmed && !entry.vendorsSeen.includes(vendorTrimmed)) {
      entry.vendorsSeen.push(vendorTrimmed);
    }
  };

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
    tripsByRoute: new Map(),
    routeById: new Map(),
    tripIdByDriver: new Map(
      existingWeekRoster
        .filter((r) => r.driverId && r.tripId)
        .map((r) => [r.driverId, r.tripId]),
    ),
    tripById: new Map(),
    weekRoster: existingWeekRoster,
    availableDrivers: availableDriversList,
    activeVehicles: activeVehiclesList,
    driverById: new Map(availableDriversList.map((d) => [d.id, d])),
    scheduleByEmployeeId: new Map(
      existingWeekRoster.map((r) => [r.employeeId, r]),
    ),
    driverPhoneBackfills: new Map(),
  };

  let processedCount = 0;
  let batchesCompleted = 0;

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

  // Pass 1: Parse sheets and collect employee codes
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
    const existingEmployees = await prisma.employee.findMany({
      where: { employeeCode: { in: Array.from(allEmployeeCodes) } },
      include: { area: true, subArea: true, block: true },
    });
    for (const emp of existingEmployees)
      caches.employee.set(emp.employeeCode, emp);
  }

  // Batched writes
  const PENDING_WRITE_FLUSH_SIZE = 25;
  const pendingWrites = [];
  const pendingByEmployeeId = new Map();

  const applyCacheEffects = (
    savedSchedule,
    { employee, scheduleData, dayFields, route },
  ) => {
    caches.scheduleByEmployeeId.set(employee.id, savedSchedule);
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
  };

  const flushPendingWrites = async () => {
    if (!pendingWrites.length) return;
    const batch = pendingWrites.splice(0, pendingWrites.length);
    pendingByEmployeeId.clear();
    try {
      const saved = await prisma.$transaction(
        batch.map((item) =>
          item.existing
            ? prisma.weeklySchedule.update({
                where: { id: item.existing.id },
                data: item.scheduleData,
              })
            : prisma.weeklySchedule.create({ data: item.scheduleData }),
        ),
      );
      saved.forEach((savedSchedule, i) =>
        applyCacheEffects(savedSchedule, batch[i]),
      );
    } catch (batchError) {
      for (const item of batch) {
        const {
          employee,
          existing,
          scheduleData,
          sheetName,
          rowNum,
          employeeCode,
          raw,
        } = item;
        try {
          const savedSchedule = existing
            ? await prisma.weeklySchedule.update({
                where: { id: existing.id },
                data: scheduleData,
              })
            : await prisma.weeklySchedule.create({ data: scheduleData });
          applyCacheEffects(savedSchedule, item);
        } catch (rowError) {
          if (existing) results.updated--;
          else results.created--;
          await skipRow(sheetName, rowNum, employeeCode, rowError.message, raw);
        }
      }
    }
  };

  // Row grouping by area
  const rowGroups = new Map();
  for (const {
    sheetName,
    colIndex,
    dataRows,
    headerRowIndex,
  } of parsedSheets) {
    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i];
      const rowNum = headerRowIndex + i + 2;
      const empCodeCol = colIndex.employeeCode;
      const employeeCode =
        empCodeCol !== undefined ? String(raw[empCodeCol] ?? "").trim() : "";
      if (!employeeCode || !/^\d+$/.test(employeeCode)) continue;

      const areaKey =
        caches.employee.get(employeeCode)?.area?.id || "__no_area__";
      if (!rowGroups.has(areaKey)) rowGroups.set(areaKey, []);
      rowGroups.get(areaKey).push({ sheetName, raw, rowNum, colIndex });
    }
  }

  const ROW_GROUP_CONCURRENCY = 24;
  const limit = pLimit(ROW_GROUP_CONCURRENCY);

  // ============================================================
  // processRow - CRITICAL: Driver from sheet is PRIORITY
  // Matches: Driver Name + Vendor + Vehicle Type (ALL 3)
  // FIX: Creates placeholder vehicle if driver has none
  // ============================================================
  const processRow = async (sheetName, raw, rowNum, colIndex) => {
    const get = (key) =>
      colIndex[key] !== undefined
        ? String(raw[colIndex[key]] ?? "").trim()
        : "";

    const employeeCode = get("employeeCode");
    if (!employeeCode || !/^\d+$/.test(employeeCode)) return;

    try {
      const employee = await findEmployee(employeeCode, caches);
      if (!employee) {
        results.employeesNotFound++;
        await skipRow(
          sheetName,
          rowNum,
          employeeCode,
          `Employee code ${employeeCode} not found in master data.`,
          raw,
        );
        return;
      }

      const vendorName = get("vendor");
      const vehicleType = get("vehicleType");
      const shiftTiming = get("shiftTiming");

      const driverEntries = parseDriverEntries(get("drivers"));
      let driverId = null;
      let driverRecord = null;
      let driverSheetPhone = null;
      let vehicleId = null;
      let resolvedVehicleType = null;

      for (let d = 0; d < driverEntries.length; d++) {
        const driver = await findDriver(
          driverEntries[d].name,
          vendorName,
          vehicleType,
          caches.driver,
          caches,
        );

        if (driver) {
          driverId = driver.id;
          driverRecord = driver;
          driverSheetPhone = driverEntries[d].phone;

          if (driver.vehicle) {
            vehicleId = driver.vehicle.id;
            resolvedVehicleType = driver.vehicle.type;
          }

          break;
        } else {
          const targetName = driverEntries[d].name.trim().replace(/\s+/g, " ");
          const nameOnlyMatches = await prisma.driver.count({
            where: { name: { equals: targetName, mode: "insensitive" } },
          });

          if (nameOnlyMatches > 0) {
            results.driversAmbiguous++;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Driver "${driverEntries[d].name}" found but vendor "${vendorName}" and/or vehicle type "${vehicleType}" didn't match - trying next driver.`,
            });
            recordUnmatchedDriverName(
              driverEntries[d].name,
              rowNum,
              employeeCode,
              vendorName,
              "ambiguous",
            );
          } else {
            results.driversNotFound++;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Driver "${driverEntries[d].name}" not found in master data - trying next driver.`,
            });
            recordUnmatchedDriverName(
              driverEntries[d].name,
              rowNum,
              employeeCode,
              vendorName,
              "not_found",
            );
          }
        }
      }

      if (!driverId && driverEntries.length > 0) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `No matching driver found with Name + Vendor "${vendorName}" + Vehicle Type "${vehicleType}". Row saved WITHOUT driver.`,
        });
      }

      let vendorId = null;
      if (vendorName) {
        const vendor = await findVendor(vendorName, caches.vendor);
        if (vendor) {
          vendorId = vendor.id;
        } else {
          results.vendorsNotFound++;
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Vendor "${vendorName}" not found in master data.`,
          });
        }
      }

      const areaRecord = employee.area || null;

      const sheetAddress = get("address");
      if (sheetAddress) {
        const addressCheck = analyzeAddressMatch(sheetAddress, employee);
        if (!addressCheck.isMatch) {
          results.addressMismatch++;
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: addressCheck.reason,
          });
        }
      }

      const vehicleReg = get("vehicleReg");
      if (vehicleReg) {
        const vehicle = await findVehicleByReg(vehicleReg, caches.vehicle);
        if (vehicle) {
          vehicleId = vehicle.id;
          resolvedVehicleType = vehicle.type;
        } else {
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Vehicle "${vehicleReg}" not found in master data.`,
          });
        }
      }

      // ============================================================
      // FIX: If driver has no vehicle, CREATE ONE
      // ============================================================
      if (driverId && !vehicleId) {
        const vehicle = await findOrCreateVehicleForDriver(
          driverId,
          vendorName,
          vehicleType,
          caches,
        );
        if (vehicle) {
          vehicleId = vehicle.id;
          resolvedVehicleType = vehicle.type;
          if (vehicle.notes?.includes("Placeholder")) {
            results.vehiclesCreated = (results.vehiclesCreated || 0) + 1;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver "${driverRecord?.name}" (vendor: ${vendorName}, type: ${vehicleType}). Replace with actual vehicle when available.`,
            });
          }
        } else {
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Failed to create vehicle for driver "${driverRecord?.name}". Row will be DRAFT.`,
          });
        }
      }

      let vehicleTypeConfirmed = false;
      if (vehicleType && resolvedVehicleType) {
        const sheetTypeKey = normalizeVehicleType(vehicleType);
        if (sheetTypeKey && VEHICLE_TYPES.has(sheetTypeKey)) {
          if (sheetTypeKey !== resolvedVehicleType) {
            results.vehicleTypeMismatch++;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Sheet Vehicle Type ("${vehicleType}") doesn't match assigned vehicle actual type (${resolvedVehicleType}).`,
            });
          } else {
            vehicleTypeConfirmed = true;
          }
        }
      }

      if (
        driverId &&
        driverSheetPhone &&
        !driverRecord.phone &&
        vendorName &&
        !driverRecord.__matchWarning &&
        vehicleTypeConfirmed &&
        !caches.driverPhoneBackfills.has(driverId)
      ) {
        const digits = String(driverSheetPhone).replace(/\D/g, "");
        if (digits) {
          caches.driverPhoneBackfills.set(driverId, digits);
          driverRecord.phone = digits;
          results.driversPhoneBackfilled =
            (results.driversPhoneBackfilled || 0) + 1;
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
          {
            disableMultiTrip: false,
            trustProposedDriver: true,
          },
          vendorName,
        );
        route = routeResult.route;
        trip = routeResult.trip;
        routeCreated = routeResult.created;
        if (routeCreated) results.routesCreated++;
        if (routeResult.newTrip) {
          results.routeLegsOpenedForOverflow++;
        }
        if (routeResult.overCapacity) {
          results.capacityExceeded++;
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Trip #${trip.tripNumber} on route "${route.routeCode}" is at/over capacity.`,
          });
        }
        (routeResult.notes || []).forEach((note) => {
          results.notes.push({ row: rowNum, employeeCode, note });
        });
        if (!route?.id || !trip?.id) {
          await skipRow(
            sheetName,
            rowNum,
            employeeCode,
            "Route/Trip could not be created/found.",
            raw,
          );
          return;
        }
      } catch (routeError) {
        await skipRow(
          sheetName,
          rowNum,
          employeeCode,
          `Route/Trip creation failed: ${routeError.message}`,
          raw,
        );
        return;
      }

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
        options: { trustProposedDriver: true },
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

      const missingDriver = !driverId;
      const missingVehicle = !vehicleId;
      if (missingDriver || missingVehicle) {
        results.pendingAssignment += 1;
      }

      let scheduleData = {
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

      const existing = caches.scheduleByEmployeeId.get(employee.id) || null;

      const pendingIdx = pendingByEmployeeId.get(employee.id);
      if (pendingIdx !== undefined) {
        const prevPending = pendingWrites[pendingIdx];
        const prevData = prevPending.scheduleData;
        const sameShift =
          normalizeShiftForCompare(prevData.shiftTiming) ===
          normalizeShiftForCompare(shiftTiming);
        const isPickDropPair =
          (prevData.serviceType === "PICK_ONLY" &&
            scheduleData.serviceType === "DROP_ONLY") ||
          (prevData.serviceType === "DROP_ONLY" &&
            scheduleData.serviceType === "PICK_ONLY");

        if (sameShift && isPickDropPair) {
          const pickIsPrev = prevData.serviceType === "PICK_ONLY";
          const pickData = pickIsPrev ? prevData : scheduleData;
          const dropData = pickIsPrev ? scheduleData : prevData;
          const pickRowNum = pickIsPrev ? prevPending.rowNum : rowNum;
          const dropRowNum = pickIsPrev ? rowNum : prevPending.rowNum;

          scheduleData = {
            ...pickData,
            serviceType: "PICK_AND_DROP",
            officeArrivalTime: pickData.officeArrivalTime,
            pickupTime: pickData.pickupTime,
            dropTime: dropData.dropTime,
          };
          route = pickIsPrev ? prevPending.route : route;

          if (
            scheduleData.tripId &&
            (pickData.driverId !== dropData.driverId ||
              pickData.vehicleId !== dropData.vehicleId)
          ) {
            let mergedTrip = caches?.tripById?.get(scheduleData.tripId);
            if (!mergedTrip) {
              mergedTrip = await prisma.trip.findUnique({
                where: { id: scheduleData.tripId },
                include: { vehicle: true },
              });
            }
            if (mergedTrip) {
              const tripPatch = {};
              if (
                scheduleData.driverId &&
                mergedTrip.driverId !== scheduleData.driverId
              ) {
                tripPatch.driverId = scheduleData.driverId;
              }
              if (
                scheduleData.vehicleId &&
                mergedTrip.vehicleId !== scheduleData.vehicleId
              ) {
                tripPatch.vehicleId = scheduleData.vehicleId;
              }
              if (Object.keys(tripPatch).length) {
                mergedTrip = await prisma.trip.update({
                  where: { id: mergedTrip.id },
                  data: tripPatch,
                  include: { vehicle: true },
                });
                caches?.tripById?.set(mergedTrip.id, mergedTrip);
                if (mergedTrip.driverId) {
                  caches?.tripIdByDriver?.set(
                    mergedTrip.driverId,
                    mergedTrip.id,
                  );
                }
                results.notes.push({
                  row: rowNum,
                  employeeCode,
                  note: `Pick leg (row ${pickRowNum}) and Drop leg (row ${dropRowNum}) named different drivers/vehicles - kept the Pick leg's driver/vehicle on the trip to match the merged schedule.`,
                });
              }
            }
          }

          prevPending.scheduleData = scheduleData;
          prevPending.dayFields = dayFields;
          prevPending.route = route;

          results.pickDropLegsMerged += 1;
        } else {
          const driverConflict =
            prevData.driverId &&
            scheduleData.driverId &&
            prevData.driverId !== scheduleData.driverId;

          results.conflictingDuplicatesSkipped += 1;
          if (driverConflict) {
            results.duplicateDriverConflicts =
              (results.duplicateDriverConflicts || 0) + 1;
            const currentDriverRaw =
              driverEntries[0]?.name || scheduleData.driverId;
            const prevDriverRaw = prevPending.driverRaw || prevData.driverId;
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `CONFLICT: Employee ${employeeCode} has TWO rows in the sheet (row ${prevPending.rowNum} and row ${rowNum}) with the SAME service type but DIFFERENT drivers named ("${prevDriverRaw}" vs "${currentDriverRaw}"). Kept row ${prevPending.rowNum}'s driver; row ${rowNum} was skipped. This needs to be fixed in the sheet - the system cannot tell which one is correct.`,
            });
          }
          await skipRow(
            sheetName,
            rowNum,
            employeeCode,
            `Employee ${employeeCode} already has another schedule row queued from row ${prevPending.rowNum}.`,
            raw,
          );
          return;
        }
      } else {
        if (existing?.isLocked) {
          await skipRow(
            sheetName,
            rowNum,
            employeeCode,
            "Schedule is locked.",
            raw,
          );
          return;
        }
        if (existing) results.updated++;
        else results.created++;
        pendingByEmployeeId.set(employee.id, pendingWrites.length);
        pendingWrites.push({
          employee,
          existing,
          scheduleData,
          dayFields,
          route,
          sheetName,
          rowNum,
          employeeCode,
          raw,
          driverRaw: driverEntries[0]?.name || null,
        });
      }

      caches.scheduleByEmployeeId.set(employee.id, {
        ...(existing || {}),
        ...scheduleData,
        id: existing?.id,
      });
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

      if (pendingWrites.length >= PENDING_WRITE_FLUSH_SIZE) {
        await flushPendingWrites();
      }
    } catch (rowError) {
      await skipRow(sheetName, rowNum, employeeCode, rowError.message, raw);
    } finally {
      processedCount += 1;
      updateBulkUploadJob(jobId, { processedRows: processedCount });

      if (processedCount % batchSize === 0) {
        batchesCompleted += 1;
        updateBulkUploadJob(jobId, {
          batchesCompleted,
          partialResult: JSON.parse(JSON.stringify(results)),
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };

  await Promise.all(
    Array.from(rowGroups.values()).map((groupRows) =>
      limit(async () => {
        for (const { sheetName, raw, rowNum, colIndex } of groupRows) {
          await processRow(sheetName, raw, rowNum, colIndex);
        }
      }),
    ),
  );

  await flushPendingWrites();

  // Phone backfill flush
  if (caches.driverPhoneBackfills.size) {
    const backfillEntries = Array.from(caches.driverPhoneBackfills.entries());
    try {
      await prisma.$transaction(
        backfillEntries.map(([driverIdToUpdate, phoneDigits]) =>
          prisma.driver.update({
            where: { id: driverIdToUpdate },
            data: { phone: phoneDigits },
          }),
        ),
      );
    } catch (backfillBatchError) {
      for (const [driverIdToUpdate, phoneDigits] of backfillEntries) {
        try {
          await prisma.driver.update({
            where: { id: driverIdToUpdate },
            data: { phone: phoneDigits },
          });
        } catch (backfillRowError) {
          results.driversPhoneBackfilled = Math.max(
            0,
            (results.driversPhoneBackfilled || 0) - 1,
          );
        }
      }
    }
  }

  results.unmatchedDriverNames = Array.from(unmatchedDriverNameMap.values())
    .sort((a, b) => b.occurrences - a.occurrences)
    .map((entry) => ({
      ...entry,
      note:
        entry.reason === "ambiguous"
          ? `Matches more than one driver in the master data.`
          : `No driver by this exact name in the master data.`,
    }));

  if (processedCount % batchSize !== 0) {
    batchesCompleted += 1;
  }
  updateBulkUploadJob(jobId, {
    batchesCompleted,
    partialResult: JSON.parse(JSON.stringify(results)),
  });

  await syncPendingRidesForWeekBestEffort(weekStartDate);

  return results;
};

// ---------- Validate Upload ----------

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
        "Couldn't read that file as an .xlsx/.xls workbook.",
      );
      return res.status(response.status.code).json(response);
    }

    const sheetsReport = [];
    let anyValidRows = false;

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
          validRows: 0,
          warnings: ["No 'Employee ID' header found"],
        });
        continue;
      }

      const colIndex = {};
      rows[headerRowIndex].forEach((cell, i) => {
        const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
        if (key) colIndex[key] = i;
      });

      const get = (raw, key) =>
        colIndex[key] !== undefined
          ? String(raw[colIndex[key]] ?? "").trim()
          : "";

      const dataRows = rows.slice(headerRowIndex + 1);
      let validRows = 0;
      for (const raw of dataRows) {
        const employeeCode = get(raw, "employeeCode");
        if (employeeCode && /^\d+$/.test(employeeCode)) validRows++;
      }
      if (validRows > 0) anyValidRows = true;

      const mappedFields = Object.entries(colIndex)
        .filter(([key]) => key !== "employeeCode")
        .map(([key]) => key);

      const warnings = [];
      if (validRows === 0) warnings.push("No valid data rows found");
      if (!colIndex.name) warnings.push("Missing 'User Name' column");
      if (!colIndex.shiftTiming)
        warnings.push("Missing 'Shift Timings' column");

      sheetsReport.push({
        sheet: sheetName,
        headerFound: true,
        validRows,
        mappedFields,
        warnings,
      });
    }

    const result = {
      canProceed: anyValidRows,
      sheets: sheetsReport,
    };

    const response = okResponse(result, "Workbook format checked.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------- Bulk Upload Controller ----------

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
        "Couldn't read that file as an .xlsx/.xls workbook.",
      );
      return res.status(response.status.code).json(response);
    }

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
        message: `A bulk upload for the week of ${weekStart} is already running.`,
        data: { existingJobId: jobResult.existingJobId },
      };
      return res.status(response.status.code).json(response);
    }
    const jobId = jobResult.jobId;

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
  analyzeAddressMatch,
  createWeeklySchedule,
  getAllWeeklySchedules,
  getWeeklyScheduleById,
  updateWeeklySchedule,
  deleteWeeklySchedule,
  getCurrentWeekSchedules,
  getEmployeeScheduleRange,
  getGroupedSchedules,
  getScheduleStats,
  getScheduleTableStats,
  getScheduleTableGroupedByArea,
  bulkUploadWeeklySchedule,
  validateBulkUploadFile,
  getBulkUploadStatus,
  reassignMismatchedShiftEmployees,
  optimizeRouteAssignments,
  resyncPendingRides,
  resolvePendingVehicleAssignments,
};
  