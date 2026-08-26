const { prisma } = require("../../../lib/prisma");
const {
  normalizeShift,
  parseShiftRange,
  shiftTimesOverlap,
} = require("../shiftTime");
const {
  DAY_KEYS,
  MIN_REST_MINUTES,
  DEFAULT_MAX_DAILY_HOURS,
  DEFAULT_MAX_WEEKLY_HOURS,
  PICKUP_LEAD_MINUTES,
  SHIFT_TIME_ANCHOR_DATE,
  KARACHI_UTC_OFFSET_MINUTES,
  ADDRESS_MATCH_THRESHOLD,
  VEHICLE_TYPES,
  VEHICLE_TYPE_ALIASES,
  ENTITY_VALUES,
  ADDRESS_STOPWORDS,
  AREA_ALIASES,
  DEFAULT_CAPACITY_BY_VEHICLE_TYPE,
  FALLBACK_ROUTE_CAPACITY,
} = require("./constants");

// ============================================================
// DATE HELPERS
// ============================================================

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

// ============================================================
// SHIFT HELPERS
// ============================================================

const countWorkingDays = (entry) =>
  DAY_KEYS.filter((day) => entry[day] && entry[day] !== "OFF").length;

const hasMinimumRest = (a, b) => {
  if (!a || !b) return true;
  const aEnd = a.start + a.durationMinutes;
  const bEnd = b.start + b.durationMinutes;
  const gapAToB = (((b.start - aEnd) % 1440) + 1440) % 1440;
  const gapBToA = (((a.start - bEnd) % 1440) + 1440) % 1440;
  return Math.max(gapAToB, gapBToA) >= MIN_REST_MINUTES;
};

const normalizeShiftForCompare = (raw) =>
  String(raw || "")
    .replace(/\s+/g, "")
    .toUpperCase();

const normalizeMatch = (str) => {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

// ============================================================
// VEHICLE TYPE HELPERS
// ============================================================

const normalizeVehicleType = (raw) => {
  if (!raw) return "";
  const str = String(raw).toUpperCase().trim();

  if (VEHICLE_TYPE_ALIASES[str]) {
    return VEHICLE_TYPE_ALIASES[str];
  }

  const parts = str.split(/[\s\/\-_,]+/);
  for (const part of parts) {
    const normalized = VEHICLE_TYPE_ALIASES[part];
    if (normalized && VEHICLE_TYPES.has(normalized)) {
      return normalized;
    }
    if (VEHICLE_TYPES.has(part)) {
      return part;
    }
  }

  if (str.includes("KARVAN") || str.includes("KARVEN")) {
    return "KARVAN";
  }
  if (str.includes("HIJET") || str.includes("HI-JET")) {
    return "HIJET";
  }

  return parts[0] || "";
};

const guessMaxCapacity = (vehicleTypeRaw) => {
  const key = normalizeVehicleType(vehicleTypeRaw);
  return DEFAULT_CAPACITY_BY_VEHICLE_TYPE[key] || FALLBACK_ROUTE_CAPACITY;
};

// ============================================================
// ENTITY HELPERS
// ============================================================

const normalizeEntity = (raw) => {
  const key = String(raw || "")
    .trim()
    .toUpperCase();
  return ENTITY_VALUES.has(key) ? key : null;
};

// ============================================================
// AREA HELPERS
// ============================================================

const normalizeAreaName = (areaName) => {
  if (!areaName) return null;
  const trimmed = String(areaName).trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  if (AREA_ALIASES[lower]) {
    return AREA_ALIASES[lower];
  }

  const sortedAliases = Object.entries(AREA_ALIASES).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [alias, canonical] of sortedAliases) {
    if (lower.includes(alias)) {
      return canonical;
    }
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
};

const findOrCreateNormalizedArea = async (areaName, caches) => {
  const normalizedName = normalizeAreaName(areaName);
  if (!normalizedName) return null;

  const cacheKey = `area::${normalizedName.toLowerCase()}`;
  if (caches?.areaCache?.has(cacheKey)) {
    return caches.areaCache.get(cacheKey);
  }

  let area = await prisma.area.findFirst({
    where: {
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
    },
  });

  if (!area) {
    area = await prisma.area.create({
      data: {
        name: normalizedName,
        city: "Karachi",
      },
    });
    console.log(
      `[area] Created new area: "${normalizedName}" from "${areaName}"`,
    );
  }

  caches?.areaCache?.set(cacheKey, area);
  return area;
};

const getMainArea = async (employee, caches) => {
  if (!employee) return null;

  if (!caches) caches = {};
  if (!caches.areaCache) {
    caches.areaCache = new Map();
  }

  let rawAreaName = null;

  if (employee.area?.name) {
    rawAreaName = employee.area.name;
  } else if (employee.areaId) {
    try {
      const cacheKey = `area::${employee.areaId}`;
      let area = caches.areaCache.get(cacheKey);
      if (area === undefined) {
        area = await prisma.area.findUnique({ where: { id: employee.areaId } });
        caches.areaCache.set(cacheKey, area || null);
      }
      rawAreaName = area?.name || null;
    } catch (areaError) {
      console.error(
        `[weeklySchedule][getMainArea] area lookup failed for employee ${employee.employeeCode} ` +
          `(areaId=${employee.areaId}): ${areaError.message}`,
      );
    }
  }

  if (!rawAreaName && employee.subAreaId) {
    try {
      const cacheKey = `subarea::${employee.subAreaId}`;
      let subArea = caches.areaCache.get(cacheKey);
      if (subArea === undefined) {
        subArea = await prisma.subArea.findUnique({
          where: { id: employee.subAreaId },
          include: { area: true },
        });
        caches.areaCache.set(cacheKey, subArea || null);
      }
      rawAreaName = subArea?.area?.name || subArea?.name || null;
    } catch (subAreaError) {
      console.error(
        `[weeklySchedule][getMainArea] subArea lookup failed for employee ${employee.employeeCode} ` +
          `(subAreaId=${employee.subAreaId}): ${subAreaError.message}.`,
      );
    }
  }

  if (!rawAreaName) {
    console.log(
      `[weeklySchedule][getMainArea] employee ${employee.employeeCode} has no resolvable area ` +
        `(areaId=${employee.areaId || "none"}, subAreaId=${employee.subAreaId || "none"}).`,
    );
    return null;
  }

  const mainArea = await findOrCreateNormalizedArea(rawAreaName, caches);
  console.log(
    `[weeklySchedule][getMainArea] employee ${employee.employeeCode}: "${rawAreaName}" -> "${mainArea?.name || "null"}"`,
  );
  return mainArea;
};

// ============================================================
// ADDRESS HELPERS
// ============================================================

const normalizeAddressTokens = (raw) =>
  new Set(
    String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !ADDRESS_STOPWORDS.has(t)),
  );

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

  return {
    isMatch: false,
    score,
    reason: `Sheet address ("${sheetAddress}") shares almost nothing with this employee's master-data address/area`,
  };
};

// ============================================================
// TIME PARSING HELPERS
// ============================================================

const parseSheetTimeOfDay = (raw) => {
  if (raw === null || raw === undefined || raw === "") return null;

  if (typeof raw === "number" || /^\d+(\.\d+)?$/.test(String(raw).trim())) {
    const num = Number(raw);
    if (!Number.isNaN(num)) {
      const fraction = num - Math.floor(num);
      const totalMinutes = Math.round(fraction * 24 * 60);
      return {
        hours: Math.floor(totalMinutes / 60) % 24,
        minutes: totalMinutes % 60,
      };
    }
  }

  const str = String(raw).trim();
  if (!str) return null;
  if (/pick\s*only|drop\s*only/i.test(str)) return null;

  let cleaned = str
    .replace(/\s*:\s*:?\s*/g, ":")
    .replace(/:\s*(AM|PM)/i, " $1")
    .replace(/:(\d{2}):(\d{2})\s*(AM|PM)/i, (match, h, m, meridiem) => {
      return `${parseInt(h)}:${m} ${meridiem}`;
    })
    .replace(/\s*:\s*:\s*/g, ":")
    .replace(/\s*(AM|PM)\s*/i, " $1")
    .trim();

  const match = cleaned.match(/^(\d{1,2}):?(\d{2})?\s*(AM|PM)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3] ? match[3].toUpperCase() : null;

  if (Number.isNaN(hours) || hours > 23 || minutes > 59) return null;
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  return { hours, minutes };
};

const timeOfDayToUtcDate = ({ hours, minutes }) => {
  const rawUtcMinutes = hours * 60 + minutes - KARACHI_UTC_OFFSET_MINUTES;
  const wrapped = ((rawUtcMinutes % 1440) + 1440) % 1440;
  const dayOffset = Math.floor(rawUtcMinutes / 1440);
  const anchor = new Date(`${SHIFT_TIME_ANCHOR_DATE}T00:00:00.000Z`);
  anchor.setUTCDate(anchor.getUTCDate() + dayOffset);
  anchor.setUTCHours(Math.floor(wrapped / 60), wrapped % 60, 0, 0);
  return anchor;
};

const parseSheetTimeToDate = (raw) => {
  const tod = parseSheetTimeOfDay(raw);
  return tod ? timeOfDayToUtcDate(tod) : null;
};

const toShiftTimeDate = (value) => {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.trim())) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return parseSheetTimeToDate(value);
};

const toIsoOrNull = (value) => {
  const d = toShiftTimeDate(value);
  return d ? d.toISOString() : null;
};

const computePickupTime = (officeArrivalDate) => {
  if (
    !(officeArrivalDate instanceof Date) ||
    Number.isNaN(officeArrivalDate.getTime())
  )
    return null;
  return new Date(
    officeArrivalDate.getTime() - PICKUP_LEAD_MINUTES * 60 * 1000,
  );
};

// ============================================================
// DRIVER PARSING HELPERS
// ============================================================

const parseDriverEntries = (raw) => {
  if (!raw) return [];
  const str = String(raw);
  const re =
    /([A-Za-z][A-Za-z .]*?)\s*[-:]?\s*(?:\d\s+)?(\d{3,5}[\s-]\d{6,8}|\d{10,13})/g;
  const out = [];
  let match;
  while ((match = re.exec(str)) !== null) {
    const name = match[1].trim();
    const phone = match[2].replace(/[\s-]/g, "");
    if (name && phone.length >= 10 && phone.length <= 13) {
      out.push({ name, phone });
    }
  }
  return out;
};

const parseDriverEntry = (raw) => parseDriverEntries(raw)[0] || null;

// ============================================================
// SERVICE TYPE HELPERS
// ============================================================

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

const parseOffDays = (offDayRaw) => {
  const tokens =
    String(offDayRaw || "")
      .toUpperCase()
      .match(/SUN|MON|TUE|WED|THU|FRI|SAT/g) || [];
  return new Set(tokens.map((t) => DAY_ABBR_MAP[t]));
};

// ============================================================
// ROUTE HELPERS
// ============================================================

const slugify = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const generateUniqueRouteCode = async (baseCode) => {
  let candidate = baseCode;
  let n = 1;
  while (await prisma.route.findUnique({ where: { routeCode: candidate } })) {
    n += 1;
    candidate = `${baseCode}-L${n}`;
  }
  return candidate;
};

// ============================================================
// DRIVER WORKING HOURS HELPERS
// ============================================================

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

// ============================================================
// ROSTER FILTER HELPERS
// ============================================================

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

// ============================================================
// COUNT TRIP OCCUPANCY
// ============================================================

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

// ============================================================
// CONCURRENCY HELPERS
// ============================================================

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

// ============================================================
// AUDIT & EXCEPTION HELPERS
// ============================================================

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

// ============================================================
// LOOKUP FUNCTIONS
// ============================================================

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

// ============================================================
// SYNC ROUTE HELPERS
// ============================================================

const syncRouteFromTrips = async (routeId, caches, tripsHint) => {
  const trips =
    tripsHint ||
    (await prisma.trip.findMany({
      where: { routeId, status: "ACTIVE" },
      include: { vehicle: true },
      orderBy: { tripNumber: "asc" },
    }));

  const cachedRoute = caches?.routeById?.get(routeId);
  if (cachedRoute) {
    return cachedRoute;
  }

  const updated = await prisma.route.update({
    where: { id: routeId },
    data: {},
    include: { area: true },
  });
  caches?.routeById?.set(routeId, updated);
  return updated;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Date helpers
  toDateOnly,
  formatDateOnly,
  mondayOfCurrentWeek,

  // Shift helpers
  countWorkingDays,
  hasMinimumRest,
  normalizeShiftForCompare,
  normalizeMatch,

  // Vehicle type helpers
  normalizeVehicleType,
  guessMaxCapacity,

  // Entity helpers
  normalizeEntity,

  // Area helpers
  normalizeAreaName,
  findOrCreateNormalizedArea,
  getMainArea,

  // Address helpers
  normalizeAddressTokens,
  analyzeAddressMatch,

  // Time parsing helpers
  parseSheetTimeOfDay,
  parseSheetTimeToDate,
  toShiftTimeDate,
  toIsoOrNull,
  computePickupTime,

  // Driver parsing helpers
  parseDriverEntries,
  parseDriverEntry,

  // Service type helpers
  deriveServiceType,
  parseOffDays,

  // Route helpers
  slugify,
  generateUniqueRouteCode,

  // Driver working hours helpers
  checkDriverWorkingHours,

  // Roster helpers
  filterRoster,
  upsertRosterEntry,

  // Count helpers
  countTripOccupancy,

  // Concurrency helpers
  acquireWeekAreaLock,
  tryAcquireWeekAreaLock,

  // Audit & exception helpers
  recordAssignmentHistory,
  logScheduleException,

  // Lookup functions
  findVendor,
  findEmployee,

  // Sync helpers
  syncRouteFromTrips,
};
