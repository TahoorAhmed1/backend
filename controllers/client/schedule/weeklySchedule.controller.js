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
  "sub area": "subArea",
  subarea: "subArea",
  block: "block",
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

// ---------- DateTime / Time-of-day Parsing ----------

const SHIFT_TIME_ANCHOR_DATE = "1970-01-01";
const KARACHI_UTC_OFFSET_MINUTES = 5 * 60;

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

const PICKUP_LEAD_MINUTES = 2 * 60;
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

const normalizeShiftForCompare = (raw) =>
  String(raw || "")
    .replace(/\s+/g, "")
    .toUpperCase();

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

const normalizeMatch = (str) => {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

// ============================================================
// VEHICLE TYPE NORMALIZATION
// ============================================================

const VEHICLE_TYPES = new Set(["CAR", "VAN", "HIJET", "KARVAN", "BUS"]);

const VEHICLE_TYPE_ALIASES = {
  KARVAN: "KARVAN",
  KARVEN: "KARVAN",
  KARVAN: "KARVAN",
  CAR: "CAR",
  VAN: "VAN",
  HIJET: "HIJET",
  "HI-JET": "HIJET",
  HIJET: "HIJET",
  BUS: "BUS",
};

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

// ============================================================
// AREA ALIASES
// ============================================================

const AREA_ALIASES = {
  pechs: "P.E.C.H.S",
  "pechs,": "P.E.C.H.S",
  "6 pechs": "P.E.C.H.S",
  garden: "Garden East",
  "garden headquarters": "Garden East",
  "garden east": "Garden East",
  "garden east.": "Garden East",
  "garden east k": "Garden East",
  "garden west": "Garden West",
  "garden west,": "Garden West",
  nazimabad: "Nazimabad",
  "nazimabad karachi": "Nazimabad",
  naizamabad: "Nazimabad",
  naizmabad: "Nazimabad",
  nazimbad: "Nazimabad",
  nazaimabad: "Nazimabad",
  "nazaimabad no 4": "Nazimabad",
  "north nazimabad": "North Nazimabad",
  "n nazimabad": "North Nazimabad",
  "north nazimbad": "North Nazimabad",
  "north naizamabad": "North Nazimabad",
  "north naizamabad.": "North Nazimabad",
  "north naizmabad": "North Nazimabad",
  "north nazimbad": "North Nazimabad",
  bufferzone: "Buffer Zone",
  "bufferzone,": "Buffer Zone",
  "buffer zone": "Buffer Zone",
  "buffer zone.": "Buffer Zone",
  "2 minutes chowrangi": "2 Min Chowrangi",
  "2 minute chowrangi": "2 Min Chowrangi",
  "north karachi": "North Karachi",
  "north karach": "North Karachi",
  "north karachi.": "North Karachi",
  "noth karachi": "North Karachi",
  "fb area": "F.B Area",
  "f.b area": "F.B Area",
  "fb area.": "F.B Area",
  "federal b area": "F.B Area",
  liaqatabad: "Liaquatabad",
  "teen hatthi": "Teen Hatti",
  teenhati: "Teen Hatti",
  teenhatti: "Teen Hatti",
  "gulistan e johar": "Gulistan-e-Jauhar",
  "gulistan-e-johar": "Gulistan-e-Jauhar",
  johar: "Gulistan-e-Jauhar",
  jauhar: "Gulistan-e-Jauhar",
  "jauhar chowrangi": "Gulistan-e-Jauhar",
  "gulshan -e-iqbal": "Gulshan-e-Iqbal",
  "gulshan e iqbal": "Gulshan-e-Iqbal",
  gulshan: "Gulshan-e-Iqbal",
  "shah faisal": "Shah Faisal Colony",
  "shah faisal colony": "Shah Faisal Colony",
  "shah faisa": "Shah Faisal Colony",
  shahfaisal: "Shah Faisal Colony",
  mlir: "Shah Faisal Colony",
  malir: "Malir City",
  "malir cantt": "Malir Cantt",
  "malir cantt.": "Malir Cantt",
  "malir cant": "Malir Cantt",
  "malir count": "Malir Cantt",
  "malir cattle": "Malir Cantt",
  saudabad: "Saudabad",
  mehoodabad: "Mehmoodabad",
  mehmoodabad: "Mehmoodabad",
  mehmmodabad: "Mehmoodabad",
  mehmodabad: "Mehmoodabad",
  "mehmoodabad,": "Mehmoodabad",
  mehmdabad: "Mehmoodabad",
  mehmoodbad: "Mehmoodabad",
  "gulzar e hijr": "Gulzar-e-Hijri",
  "gulzar e hijri": "Gulzar-e-Hijri",
  "gulazar-e-hijri": "Gulzar-e-Hijri",
  "gulzar-e-hijr": "Gulzar-e-Hijri",
  "gulzar hijri": "Gulzar-e-Hijri",
  "gulzar e hijri,": "Gulzar-e-Hijri",
  "madrass chowrangi": "Gulzar-e-Hijri",
  "gulazar-e-hijri": "Gulzar-e-Hijri",
  dha: "Defence (DHA)",
  "dha phase 8": "Defence (DHA)",
  "dha phase 2": "Defence (DHA)",
  "defense view": "Defence (DHA)",
  "defence view": "Defence (DHA)",
  defense: "Defence (DHA)",
  defence: "Defence (DHA)",
  "phase 2": "Defence (DHA)",
  "phase 2 ext": "Defence (DHA)",
  "defence view.": "Defence (DHA)",
  clifton: "Clifton",
  "clifton,": "Clifton",
  "korangi crossing": "Korangi",
  crossing: "Korangi",
  "khalid bin waleed road": "Old City Area",
  saddar: "Old City Area",
  "saddar,": "Old City Area",
  "tibet center": "Old City Area",
  "m a jinnah road": "Old City Area",
  "ma jinnah road": "Old City Area",
  "m.a.jinnah road": "Old City Area",
  "scheme 33": "Scheme 33",
  "kaneez fatima": "Kaneez Fatima",
  maymaar: "Gulshan-e-Maymar",
  cantt: "Cantt",
  "cant station": "Cantt",
  "pib colony": "PIB Colony",
  pib: "PIB Colony",
  "jamshed road": "Jamshed Road",
  "jhamshed road": "Jamshed Road",
  "jamshad road": "Jamshed Road",
  "jamshad rd": "Jamshed Road",
  "jail road": "Jail Road",
  numaish: "Numaish",
  numish: "Numaish",
  nomaish: "Numaish",
  "soldier bazar": "Soldier Bazar",
  "soldier bazar no 2": "Soldier Bazar",
  "soldier bazar #1": "Soldier Bazar",
  "soldeir bazar # 1": "Soldier Bazar",
  "akhtar colony": "Akhtar Colony",
  "aktar clony": "Akhtar Colony",
  qayyumabad: "Qayyumabad",
  qayummabad: "Qayyumabad",
  qaiyumabad: "Qayyumabad",
  qyummabad: "Qayyumabad",
  bahadurabad: "Bahadurabad",
  bahadarabad: "Bahadurabad",
  bahadrubad: "Bahadurabad",
  bahardurabad: "Bahadurabad",
  "azam town": "Azam Town",
  "azam basti": "Azam Town",
  "azam basti,": "Azam Town",
  dalmia: "Dalmia",
  airport: "Airport",
  "khi airport": "Airport",
};

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

// ============================================================
// AREA HELPERS
// ============================================================

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
// findDriver
// ============================================================

const pickBestDriverCandidate = (candidates, normalizedVendor) => {
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const driver = candidates[0];
    const driverVendor = normalizeMatch(driver.vendor?.name);
    const vehicleVendor = normalizeMatch(driver.vehicle?.vendor?.name);

    let result = driver;
    if (normalizedVendor) {
      const vendorUnverifiable = !driverVendor && !vehicleVendor;
      const vendorMismatch =
        !vendorUnverifiable &&
        driverVendor !== normalizedVendor &&
        vehicleVendor !== normalizedVendor;
      if (vendorUnverifiable || vendorMismatch) {
        result.__matchWarning = true;
      }
    }
    return result;
  }

  let filtered = candidates;
  if (normalizedVendor) {
    const vendorFiltered = filtered.filter((d) => {
      const driverVendor = normalizeMatch(d.vendor?.name);
      const vehicleVendor = normalizeMatch(d.vehicle?.vendor?.name);
      return (
        driverVendor === normalizedVendor || vehicleVendor === normalizedVendor
      );
    });
    if (vendorFiltered.length > 0) filtered = vendorFiltered;
  }

  if (filtered.length === 1) {
    const result = filtered[0];
    if (normalizedVendor && filtered === candidates && candidates.length > 1) {
      result.__matchWarning = true;
    }
    return result;
  } else if (filtered.length > 1) {
    const result = filtered[0];
    result.__matchWarning = true;
    return result;
  }
  return null;
};

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
  const firstWord = normalizedName.split(" ")[0];

  const cacheKey = `${normalizedName.toLowerCase()}::${normalizedVendor}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const driverInclude = {
    vehicle: { include: { vendor: true } },
    vendor: true,
  };

  const vendorClause = normalizedVendor
    ? {
        OR: [
          {
            vendor: { name: { equals: normalizedVendor, mode: "insensitive" } },
          },
          {
            vehicle: {
              vendor: {
                name: { equals: normalizedVendor, mode: "insensitive" },
              },
            },
          },
        ],
      }
    : null;

  let candidates = await prisma.driver.findMany({
    where: { name: { equals: normalizedName, mode: "insensitive" } },
    include: driverInclude,
  });

  let matchedLoosely = false;
  if (candidates.length === 0 && firstWord && firstWord !== normalizedName) {
    const nameClause = { name: { equals: firstWord, mode: "insensitive" } };

    if (vendorClause) {
      candidates = await prisma.driver.findMany({
        where: { AND: [nameClause, vendorClause] },
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }

    if (candidates.length === 0) {
      candidates = await prisma.driver.findMany({
        where: nameClause,
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }
  }

  if (candidates.length === 0 && firstWord) {
    const nameClause = { name: { contains: firstWord, mode: "insensitive" } };

    if (vendorClause) {
      candidates = await prisma.driver.findMany({
        where: { AND: [nameClause, vendorClause] },
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }

    if (candidates.length === 0) {
      candidates = await prisma.driver.findMany({
        where: nameClause,
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }
  }

  const result = pickBestDriverCandidate(candidates, normalizedVendor);
  if (result && matchedLoosely) result.__looseNameMatch = true;

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

const ENTITY_VALUES = new Set(["IBEX", "VW"]);
const normalizeEntity = (raw) => {
  const key = String(raw || "")
    .trim()
    .toUpperCase();
  return ENTITY_VALUES.has(key) ? key : null;
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

// ---------- Auto-assignment ----------

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
    const candidates = caches.activeVehicles.filter(
      (v) => !busyIds.length || !busyIds.includes(v.id),
    );

    if (typeKey && VEHICLE_TYPES.has(typeKey)) {
      const typed = candidates.find((v) => v.type === typeKey);
      if (typed) return typed;
    }
    return candidates[0] || null;
  }

  const baseWhere = {
    status: "ACTIVE",
    ...(busyIds.length ? { id: { notIn: busyIds } } : {}),
  };

  if (typeKey && VEHICLE_TYPES.has(typeKey)) {
    const typed = await prisma.vehicle.findFirst({
      where: { ...baseWhere, type: typeKey },
    });
    if (typed) return typed;
  }

  return prisma.vehicle.findFirst({
    where: baseWhere,
  });
};

const autoAssignDriverAndVehicle = async (
  weekStartDate,
  candidateShiftTiming,
  targetTripId,
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
  if (!driver) {
    return { driverId: null, vehicleId: null };
  }

  let vehicle = driver.vehicle && driver.vehicle.status === "ACTIVE"
    ? driver.vehicle
    : null;

  if (!vehicle) {
    console.log(`[autoAssign] Driver ${driver.name} (${driver.id}) has no vehicle, creating placeholder...`);
    const vendorName = driver.vendor?.name || "MTS";
    const vehicleType = vehicleTypeHint || "CAR";
    
    vehicle = await findOrCreateVehicleForDriver(
      driver.id,
      vendorName,
      vehicleType,
      caches
    );
  }

  if (!vehicle) {
    vehicle = await findBestAvailableVehicle(
      weekStartDate,
      candidateShiftTiming,
      targetTripId,
      vehicleTypeHint,
      excludeEmployeeId,
      caches,
    );
  }

  if (!vehicle) {
    const vendorName = driver.vendor?.name || "MTS";
    const vehicleType = vehicleTypeHint || "CAR";
    
    vehicle = await findOrCreateVehicleForDriver(
      driver.id,
      vendorName,
      vehicleType,
      caches
    );
  }

  if (vehicle) {
    console.log(`[autoAssign] Driver ${driver.name} assigned to vehicle ${vehicle.vehicleNumber} (${vehicle.id})`);
  } else {
    console.warn(`[autoAssign] Driver ${driver.name} has NO vehicle available!`);
  }

  return { 
    driverId: driver.id, 
    vehicleId: vehicle?.id || null 
  };
};

// ============================================================
// findOrCreateVehicleForDriver
// ============================================================

const findOrCreateVehicleForDriver = async (
  driverId,
  vendorName,
  vehicleType,
  caches,
) => {
  if (!driverId) return null;

  let driver = caches?.driverById?.get(driverId);
  if (!driver) {
    driver = await prisma.driver.findUnique({
      where: { id: driverId },
      include: { vehicle: true },
    });
    if (driver) caches?.driverById?.set(driverId, driver);
  }

  if (driver?.vehicle?.id) {
    const cached = caches?.vehicle?.get(driver.vehicle.id);
    if (cached) return cached;
    const existingVehicle = await prisma.vehicle.findUnique({
      where: { id: driver.vehicle.id },
    });
    if (existingVehicle) {
      caches?.vehicle?.set(existingVehicle.id, existingVehicle);
      return existingVehicle;
    }
  }

  const anyExistingVehicle = await prisma.vehicle.findFirst({
    where: { driverId },
  });
  if (anyExistingVehicle) {
    caches?.vehicle?.set(anyExistingVehicle.id, anyExistingVehicle);
    if (driver) {
      driver.vehicle = anyExistingVehicle;
      caches?.driverById?.set(driverId, driver);
    }
    return anyExistingVehicle;
  }

  const vendor = await findVendor(vendorName, caches?.vendor);
  const vehicleTypeNorm = normalizeVehicleType(vehicleType);

  if (vendor && vehicleTypeNorm && VEHICLE_TYPES.has(vehicleTypeNorm)) {
    const existingVehicle = await prisma.vehicle.findFirst({
      where: {
        vendorId: vendor.id,
        type: vehicleTypeNorm,
        driverId: null,
        status: "ACTIVE",
      },
    });

    if (existingVehicle) {
      const updated = await prisma.vehicle.update({
        where: { id: existingVehicle.id },
        data: { driverId: driverId },
      });
      caches?.vehicle?.set(updated.id, updated);
      if (driver) {
        driver.vehicle = updated;
        caches?.driverById?.set(driverId, driver);
      }
      return updated;
    }
  }

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

  let newVehicle;
  try {
    newVehicle = await prisma.vehicle.create({
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
    console.log(`[findOrCreateVehicleForDriver] Created placeholder vehicle ${vehicleNumber} for driver ${driverId}`);
  } catch (createError) {
    if (createError?.code === "P2002") {
      const settled = await prisma.vehicle.findFirst({ where: { driverId } });
      if (settled) {
        caches?.vehicle?.set(settled.id, settled);
        if (driver) {
          driver.vehicle = settled;
          caches?.driverById?.set(driverId, driver);
        }
        return settled;
      }
    }
    throw createError;
  }

  caches?.vehicle?.set(newVehicle.id, newVehicle);
  if (driver) {
    driver.vehicle = newVehicle;
    caches?.driverById?.set(driverId, driver);
  }

  return newVehicle;
};

// ============================================================
// resolveConflictFreeAssignment
// ============================================================

const resolveConflictFreeAssignment = async ({
  trip,
  weekStartDate,
  candidateShiftTiming,
  proposedDriverId,
  proposedVehicleId,
  vehicleTypeHint,
  excludeEmployeeId,
  caches,
  options,
}) => {
  const notes = [];

  let driverId = proposedDriverId || trip.driverId || undefined;
  let vehicleId = proposedVehicleId || trip.vehicleId || undefined;

  if (proposedDriverId && trip.driverId && proposedDriverId !== trip.driverId) {
    notes.push(
      `This row's named driver differs from another employee's driver sharing Trip #${trip.tripNumber ?? ""} on this route — kept THIS row's own driver as named in the sheet; that other employee's assignment is unaffected by this row.`,
    );
  }
  if (
    proposedVehicleId &&
    trip.vehicleId &&
    proposedVehicleId !== trip.vehicleId
  ) {
    notes.push(
      `This row's named vehicle differs from another employee's vehicle sharing Trip #${trip.tripNumber ?? ""} on this route — kept THIS row's own vehicle as named in the sheet.`,
    );
  }

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
  } else if (options?.skipAutoAssignDriver) {
    notes.push(
      "Sheet named a driver that couldn't be matched to master data — left unassigned rather than auto-assigning a different driver. Please review manually.",
    );
  } else {
    const best = await autoAssignDriverAndVehicle(
      weekStartDate,
      shiftTiming,
      trip.id,
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
    const vehicle = await findOrCreateVehicleForDriver(
      driverId,
      null,
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

  const tripDriverNeedsUpdate = !trip.driverId && driverId;
  const tripVehicleNeedsUpdate = !trip.vehicleId && vehicleId;

  if (tripDriverNeedsUpdate || tripVehicleNeedsUpdate) {
    const updatedTrip = await prisma.trip.update({
      where: { id: trip.id },
      data: {
        ...(tripDriverNeedsUpdate ? { driverId } : {}),
        ...(tripVehicleNeedsUpdate ? { vehicleId } : {}),
      },
      include: { vehicle: true, route: true },
    });
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
// findExistingTripForDriverThisWeek
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
// findOrCreateRouteAndTrip
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
      route = candidates.find((r) => {
        const rShiftNorm = normalizeShift(r.shiftTiming);
        return rShiftNorm === shiftNorm;
      });
    } else {
      route = candidates[0] || null;
    }
  }

  if (!route) {
    const baseName =
      [areaRecord?.name, shiftTiming].filter(Boolean).join(" - ") ||
      campaign ||
      "General Route";
    const baseCode = slugify(baseName) || `ROUTE-${Date.now()}`;

    const MAX_ROUTE_CODE_ATTEMPTS = 5;
    let lastRouteCreateError;
    for (let attempt = 1; attempt <= MAX_ROUTE_CODE_ATTEMPTS; attempt += 1) {
      const routeCode = await generateUniqueRouteCode(baseCode);
      try {
        route = await prisma.route.create({
          data: {
            routeName: baseName,
            routeCode,
            shiftTiming: shiftTiming || undefined,
            areaId: areaRecord?.id,
          },
          include: { area: true },
        });
        lastRouteCreateError = undefined;
        break;
      } catch (createErr) {
        if (createErr?.code !== "P2002") throw createErr;
        lastRouteCreateError = createErr;
      }
    }

    if (lastRouteCreateError) {
      const guaranteedCode = `${baseCode}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      route = await prisma.route.create({
        data: {
          routeName: baseName,
          routeCode: guaranteedCode,
          shiftTiming: shiftTiming || undefined,
          areaId: areaRecord?.id,
        },
        include: { area: true },
      });
    }
    routeCreated = true;
    if (areaRecord) caches?.routesByArea?.delete(areaRecord.id);
    console.log(
      `[weeklySchedule] Created new route: "${route.routeCode}" ` +
        `for area "${areaRecord?.name || "unknown"}" shift "${shiftTiming}"`,
    );
  }

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
// findOrCreateTripOnRoute - FIXED
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
  if (!route || !route.id) {
    console.error('[Trip create] Invalid route:', route);
    throw new Error(`Route object is missing or has no id: ${JSON.stringify(route)}`);
  }

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

  if (options.disableMultiTrip) {
    trip = trips[0] || null;
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
    const hasRoomFor = async (candidate) => {
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
      return occupancy < capacity;
    };

    if (driverId) {
      for (const candidate of trips) {
        if (candidate.driverId === driverId && (await hasRoomFor(candidate))) {
          trip = candidate;
          break;
        }
      }
      if (!trip) {
        for (const candidate of trips) {
          if (!candidate.driverId && (await hasRoomFor(candidate))) {
            trip = candidate;
            break;
          }
        }
      }
    }

    if (!trip) {
      for (const candidate of trips) {
        const conflictingDriver =
          driverId && candidate.driverId && candidate.driverId !== driverId;
        if (!conflictingDriver && (await hasRoomFor(candidate))) {
          trip = candidate;
          break;
        }
      }
    }
  }

  let safeDriverId = driverId || null;
  let safeVehicleId = vehicleIdHint || null;

  if (!safeDriverId) {
    const best = await autoAssignDriverAndVehicle(
      weekStartDate,
      shiftTiming,
      null,
      vehicleType,
      excludeEmployeeId,
      caches,
    );
    if (best.driverId) {
      safeDriverId = best.driverId;
      safeVehicleId = best.vehicleId;
      notes.push(`Driver auto-assigned: ${safeDriverId}`);
    } else {
      throw new Error('Cannot create trip: No driver available for this trip');
    }
  }

  if (safeDriverId && !safeVehicleId) {
    console.log(`[Trip create] Driver ${safeDriverId} has no vehicle, creating placeholder...`);
    const vehicle = await findOrCreateVehicleForDriver(
      safeDriverId,
      vendorName || "MTS",
      vehicleType || "CAR",
      caches,
    );
    if (vehicle) {
      safeVehicleId = vehicle.id;
      if (vehicle.notes?.includes("Placeholder")) {
        notes.push(
          `Created placeholder vehicle "${vehicle.vehicleNumber}" for driver "${safeDriverId}". Replace with actual vehicle when available.`,
        );
      }
    } else {
      throw new Error(`Driver ${safeDriverId} has no vehicle and couldn't create one`);
    }
  }

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
    const MAX_TRIP_NUMBER_ATTEMPTS = 5;
    let lastTripCreateError;
    let currentTrips = trips;
    
    for (let attempt = 1; attempt <= MAX_TRIP_NUMBER_ATTEMPTS; attempt += 1) {
      const nextTripNumber = currentTrips.length
        ? Math.max(...currentTrips.map((t) => t.tripNumber)) + 1
        : 1;
      
      try {
        const createData = {
          routeId: route.id,
          tripNumber: nextTripNumber,
          driverId: safeDriverId,
          vehicleId: safeVehicleId || null,
          shiftTiming: shiftTiming || null,
        };
        
        console.log(`[Trip create] Attempt ${attempt} with data:`, JSON.stringify(createData, null, 2));
        
        trip = await prisma.trip.create({
          data: createData,
          include: { vehicle: true },
        });
        
        lastTripCreateError = undefined;
        break;
        
      } catch (createErr) {
        console.error(`[Trip create] Error on attempt ${attempt}:`, {
          code: createErr?.code,
          message: createErr?.message,
          meta: createErr?.meta,
        });
        
        if (createErr?.code !== "P2002") {
          throw createErr;
        }
        
        lastTripCreateError = createErr;
        currentTrips = await prisma.trip.findMany({
          where: { routeId: route.id, status: "ACTIVE" },
          include: { vehicle: { include: { vendor: true } } },
          orderBy: { tripNumber: "asc" },
        });
      }
    }

    if (lastTripCreateError) {
      const guaranteedTripNumber =
        (currentTrips.length
          ? Math.max(...currentTrips.map((t) => t.tripNumber))
          : 0) +
        1000 +
        Math.floor(Math.random() * 1000);
      
      console.log(`[Trip create] Using guaranteed trip number: ${guaranteedTripNumber}`);
      
      trip = await prisma.trip.create({
        data: {
          routeId: route.id,
          tripNumber: guaranteedTripNumber,
          driverId: safeDriverId,
          vehicleId: safeVehicleId || null,
          shiftTiming: shiftTiming || null,
        },
        include: { vehicle: true },
      });
    }

    trips = currentTrips;
    caches?.tripsByRoute?.set(route.id, trips);
    tripCreated = true;
    tripChanged = true;
    trips.push(trip);
    
  } else {
    const patch = {};
    
    if (safeDriverId && !trip.driverId) {
      patch.driverId = safeDriverId;
    } else if (
      safeDriverId &&
      trip.driverId &&
      safeDriverId !== trip.driverId
    ) {
      notes.push(
        `Trip #${trip.tripNumber} on route "${route.routeCode}" is already assigned to a different driver — this row's sheet driver was NOT applied; please verify manually.`,
      );
    }
    
    if (safeVehicleId && !trip.vehicleId) {
      patch.vehicleId = safeVehicleId;
    }

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
      console.log(`[Trip update] Updating trip ${trip.id} with:`, patch);
      
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
  trip.route = route;
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

    await tryAcquireWeekAreaLock(weekStartDate);

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
// resolvePendingVehicleAssignments
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

    await tryAcquireWeekAreaLock(weekStartDate);

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
  await tryAcquireWeekAreaLock(weekStartDate);

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
        undefined,
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
      const best = await autoAssignDriverAndVehicle(
        weekStartDate,
        shiftTiming,
        trip.id,
        undefined,
        entry.employeeId,
        caches,
      );
      if (best.driverId) {
        driverId = best.driverId;
        summary.driversReassigned++;
      }
    }

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
      vehicleEntity,
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

    let normalizedVehicleEntity = null;
    if (vehicleEntity) {
      normalizedVehicleEntity = normalizeEntity(vehicleEntity);
      if (!normalizedVehicleEntity) {
        const response = badRequestResponse(
          "Invalid vehicleEntity — expected IBEX or VW.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    const officeArrivalDate = officeArrivalTime
      ? toShiftTimeDate(officeArrivalTime)
      : null;
    if (officeArrivalTime && !officeArrivalDate) {
      const response = badRequestResponse(
        "Invalid officeArrivalTime — expected an ISO 8601 datetime.",
      );
      return res.status(response.status.code).json(response);
    }
    const dropDate = dropTime ? toShiftTimeDate(dropTime) : null;
    if (dropTime && !dropDate) {
      const response = badRequestResponse(
        "Invalid dropTime — expected an ISO 8601 datetime.",
      );
      return res.status(response.status.code).json(response);
    }
    const pickupDate = computePickupTime(officeArrivalDate);

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
      vehicleEntity: normalizedVehicleEntity,
      serviceType: serviceType || "PICK_AND_DROP",
      monday: monday || "BOTH",
      tuesday: tuesday || "BOTH",
      wednesday: wednesday || "BOTH",
      thursday: thursday || "BOTH",
      friday: friday || "BOTH",
      saturday: saturday || "OFF",
      sunday: sunday || "OFF",
      pickupTime: pickupDate,
      shiftTiming,
      officeArrivalTime: officeArrivalDate,
      dropTime: dropDate,
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

    delete updateData.pickupTime;

    if ("officeArrivalTime" in updateData) {
      const parsed = updateData.officeArrivalTime
        ? toShiftTimeDate(updateData.officeArrivalTime)
        : null;
      if (updateData.officeArrivalTime && !parsed) {
        const errorResponse = badRequestResponse(
          "Invalid officeArrivalTime — expected an ISO 8601 datetime.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.officeArrivalTime = parsed;
      updateData.pickupTime = computePickupTime(parsed);
    }

    if ("dropTime" in updateData) {
      const parsed = updateData.dropTime
        ? toShiftTimeDate(updateData.dropTime)
        : null;
      if (updateData.dropTime && !parsed) {
        const errorResponse = badRequestResponse(
          "Invalid dropTime — expected an ISO 8601 datetime.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.dropTime = parsed;
    }

    if ("vehicleEntity" in updateData) {
      const normalized = updateData.vehicleEntity
        ? normalizeEntity(updateData.vehicleEntity)
        : null;
      if (updateData.vehicleEntity && !normalized) {
        const errorResponse = badRequestResponse(
          "Invalid vehicleEntity — expected IBEX or VW.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.vehicleEntity = normalized;
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

// ---------- Trip Driver Update ----------

const updateTripDriver = async (req, res, next) => {
  try {
    const { tripId } = req.params;
    const { driverId, weekStart } = req.body;

    const trip = await prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) {
      const errorResponse = badRequestResponse("Trip not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const safeDriverId = driverId || null;

    const [updatedTrip] = await prisma.$transaction([
      prisma.trip.update({
        where: { id: tripId },
        data: { driverId: safeDriverId },
        include: { vehicle: true, driver: true, route: true },
      }),
      prisma.weeklySchedule.updateMany({
        where: { tripId, status: { not: "CANCELLED" } },
        data: { driverId: safeDriverId },
      }),
    ]);

    if (weekStart) {
      await syncPendingRidesForWeekBestEffort(toDateOnly(weekStart));
    }

    const response = okResponse(
      updatedTrip,
      "Trip driver updated successfully.",
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
          },
        },
        trip: {
          select: {
            id: true,
            tripNumber: true,
            driver: true,
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
          driverBadge: s.driver?.name ?? "—",
          vehicleBadge: s.vehicle?.vehicleNumber ?? "—",
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
        pick: toIsoOrNull(s.pickupTime) ?? "-",
        arrival: toIsoOrNull(s.officeArrivalTime) ?? "-",
        drop: toIsoOrNull(s.dropTime) ?? "-",
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
        id: t.id,
        tripNumber: t.tripNumber,
        capacity: t.vehicle?.capacity ?? null,
        driverId: t.driverId ?? null,
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
          id: t.id,
          tripNumber: t.tripNumber,
          capacity: t.capacity,
          driver: t.driverName ?? "—",
          driverId: t.driverId ?? null,
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
        ? schedule.driverId
          ? `driver:${schedule.driverId}:${schedule.vehicleId ?? "novehicle"}:${schedule.shiftTiming ?? ""}`
          : schedule.tripId
            ? `trip:${schedule.tripId}`
            : `nodriver:${schedule.id}`
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
        pickupTime: toIsoOrNull(schedule?.pickupTime),
        dropTime: toIsoOrNull(schedule?.dropTime),
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
// processBulkUploadJob - MAIN BULK UPLOAD LOGIC
// ============================================================

const processBulkUploadJob = async (
  jobId,
  workbook,
  weekStartDate,
  batchSize = DEFAULT_BATCH_SIZE,
) => {
  console.log(
    `[weeklySchedule][job ${jobId}] START weekStart=${weekStartDate} batchSize=${batchSize}`,
  );
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
    driverPhoneMismatch: 0,
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

  await tryAcquireWeekAreaLock(weekStartDate);

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
    areaCache: new Map(),
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
    console.error(
      `[weeklySchedule][SKIP] sheet="${sheetName}" row=${rowNum} employeeCode=${employeeCode || "?"} reason: ${reason}`,
    );
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

  const employeeWriteLocks = new Map();
  const runExclusiveForEmployee = (employeeId, task) => {
    const prevTail = employeeWriteLocks.get(employeeId) || Promise.resolve();
    const runTask = () => task();
    const result = prevTail.then(runTask, runTask);
    employeeWriteLocks.set(
      employeeId,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  };

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

  const BATCH_TX_TIMEOUT_MS = 20000;
  const BATCH_TX_MAX_WAIT_MS = 10000;

  const flushPendingWrites = async () => {
    if (!pendingWrites.length) return;
    const batch = pendingWrites.splice(0, pendingWrites.length);
    pendingByEmployeeId.clear();
    try {
      const saved = await prisma.$transaction(
        batch.map((item) =>
          prisma.weeklySchedule.upsert({
            where: {
              employeeId_weekStart: {
                employeeId: item.scheduleData.employeeId,
                weekStart: item.scheduleData.weekStart,
              },
            },
            update: item.scheduleData,
            create: item.scheduleData,
          }),
        ),
        { timeout: BATCH_TX_TIMEOUT_MS, maxWait: BATCH_TX_MAX_WAIT_MS },
      );
      saved.forEach((savedSchedule, i) =>
        applyCacheEffects(savedSchedule, batch[i]),
      );
    } catch (batchError) {
      console.error(
        `[weeklySchedule][flushPendingWrites] BATCH TRANSACTION FAILED (${batch.length} rows), falling back to row-by-row: ${batchError.message}`,
      );
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
        const hasRealId = Boolean(existing?.id);
        try {
          const savedSchedule = await prisma.weeklySchedule.upsert({
            where: {
              employeeId_weekStart: {
                employeeId: scheduleData.employeeId,
                weekStart: scheduleData.weekStart,
              },
            },
            update: scheduleData,
            create: scheduleData,
          });
          applyCacheEffects(savedSchedule, item);
        } catch (rowError) {
          if (hasRealId) results.updated--;
          else results.created--;
          console.error(
            `[weeklySchedule][flushPendingWrites] row-level save failed employeeCode=${employeeCode} row=${rowNum}: ${rowError.message}`,
          );
          await skipRow(sheetName, rowNum, employeeCode, rowError.message, raw);
        }
      }
    }
  };

  // Row grouping
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

      const employee = caches.employee.get(employeeCode);

      const sheetAreaRaw =
        colIndex.area !== undefined
          ? String(raw[colIndex.area] ?? "").trim()
          : "";
      let areaRecord = sheetAreaRaw
        ? await findOrCreateNormalizedArea(
            normalizeAreaName(sheetAreaRaw),
            caches,
          )
        : null;
      if (!areaRecord && employee) {
        areaRecord = await getMainArea(employee, caches);
      }
      const areaKey = areaRecord?.id || "__no_area__";

      if (!rowGroups.has(areaKey)) rowGroups.set(areaKey, []);
      rowGroups.get(areaKey).push({ sheetName, raw, rowNum, colIndex });
    }
  }

  const ROW_GROUP_CONCURRENCY = 24;
  const limit = pLimit(ROW_GROUP_CONCURRENCY);

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
      let resolvedVehicleEntity = null;

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

          if (driver.__looseNameMatch) {
            results.notes.push({
              row: rowNum,
              employeeCode,
              note: `Driver "${driverEntries[d].name}" matched to "${driver.name}" by partial name — please verify this is correct.`,
            });
          }

          if (driver.vehicle) {
            vehicleId = driver.vehicle.id;
            resolvedVehicleType = driver.vehicle.type;
            resolvedVehicleEntity = driver.vehicle.vehicleEntity ?? null;
            console.log(`[processRow] Driver ${driver.name} has vehicle: ${driver.vehicle.vehicleNumber}`);
          } else {
            console.log(`[processRow] Driver ${driver.name} has NO vehicle, creating placeholder...`);
            const vendorNameForVehicle = vendorName || driver.vendor?.name || "MTS";
            const vehicleTypeForVehicle = vehicleType || "CAR";
            
            const newVehicle = await findOrCreateVehicleForDriver(
              driverId,
              vendorNameForVehicle,
              vehicleTypeForVehicle,
              caches
            );
            
            if (newVehicle) {
              vehicleId = newVehicle.id;
              resolvedVehicleType = newVehicle.type;
              resolvedVehicleEntity = newVehicle.vehicleEntity ?? null;
              
              results.vehiclesCreated = (results.vehiclesCreated || 0) + 1;
              results.notes.push({
                row: rowNum,
                employeeCode,
                note: `Created placeholder vehicle "${newVehicle.vehicleNumber}" for driver "${driver.name}". Replace with actual vehicle when available.`,
              });
              console.log(`[processRow] Created placeholder vehicle ${newVehicle.vehicleNumber} for driver ${driver.name}`);
            } else {
              results.notes.push({
                row: rowNum,
                employeeCode,
                note: `Failed to create vehicle for driver "${driver.name}". Row will be DRAFT.`,
              });
              console.error(`[processRow] Failed to create vehicle for driver ${driver.name}`);
            }
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
              note: `Driver "${driverEntries[d].name}" found but vendor "${vendorName}" didn't match - trying next driver.`,
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

      const driverNamedButUnmatched = !driverId && driverEntries.length > 0;
      if (driverNamedButUnmatched) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `No matching driver found with Name + Vendor "${vendorName}". Row saved WITHOUT driver.`,
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

      let areaRecord = null;
      const sheetAreaName = get("area");
      if (sheetAreaName) {
        const normalizedName = normalizeAreaName(sheetAreaName);
        areaRecord = await findOrCreateNormalizedArea(normalizedName, caches);
      }
      if (!areaRecord) {
        areaRecord = await getMainArea(employee, caches);
      }

      if (areaRecord && !employee.areaId && employee.areaId !== areaRecord.id) {
        await prisma.employee.update({
          where: { id: employee.id },
          data: { areaId: areaRecord.id },
        });
        employee.areaId = areaRecord.id;
        employee.area = areaRecord;
        caches.employee.set(employee.employeeCode, employee);
      }

      const sheetSubArea = get("subArea");
      const sheetBlock = get("block");
      const sheetLocationCombined = [
        sheetAreaName,
        sheetSubArea,
        sheetBlock,
        get("address"),
      ]
        .filter(Boolean)
        .join(" ");
      if (sheetLocationCombined) {
        const addressCheck = analyzeAddressMatch(
          sheetLocationCombined,
          employee,
        );
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
          resolvedVehicleEntity = vehicle.vehicleEntity ?? null;
        } else {
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Vehicle "${vehicleReg}" not found in master data.`,
          });
        }
      }

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
          resolvedVehicleEntity = vehicle.vehicleEntity ?? null;
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

      if (driverId && driverSheetPhone && driverRecord.phone) {
        const sheetDigits = String(driverSheetPhone)
          .replace(/\D/g, "")
          .slice(-10);
        const onFileDigits = String(driverRecord.phone)
          .replace(/\D/g, "")
          .slice(-10);
        if (sheetDigits && onFileDigits && sheetDigits !== onFileDigits) {
          results.driverPhoneMismatch = (results.driverPhoneMismatch || 0) + 1;
          results.notes.push({
            row: rowNum,
            employeeCode,
            note: `Driver "${driverRecord.name}" phone on the sheet ("${driverSheetPhone}") doesn't match the phone on file ("${driverRecord.phone}") — please verify.`,
          });
        }
      }

      const vehicleEntityRaw = get("vehicleEntityName");
      const vehicleEntity = normalizeEntity(vehicleEntityRaw);
      if (vehicleEntityRaw && !vehicleEntity) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Vehicle Entity "${vehicleEntityRaw}" is not a recognized entity (expected IBEX or VW).`,
        });
      } else if (!vehicleEntityRaw) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Vehicle Entity is missing for this row.`,
        });
      } else if (
        vehicleEntity &&
        resolvedVehicleEntity &&
        vehicleEntity !== resolvedVehicleEntity
      ) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Sheet Vehicle Entity ("${vehicleEntity}") doesn't match the assigned vehicle's entity on file (${resolvedVehicleEntity}).`,
        });
      }

      const employeeEntityRaw = get("entity");
      const employeeEntity = normalizeEntity(employeeEntityRaw);
      if (employeeEntityRaw && !employeeEntity) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Entity "${employeeEntityRaw}" is not a recognized entity (expected IBEX or VW).`,
        });
      } else if (employeeEntity && !employee.entity) {
        await prisma.employee.update({
          where: { id: employee.id },
          data: { entity: employeeEntity },
        });
        employee.entity = employeeEntity;
        caches.employee.set(employee.employeeCode, employee);
      } else if (
        employeeEntity &&
        employee.entity &&
        employeeEntity !== employee.entity
      ) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Sheet Entity ("${employeeEntity}") doesn't match this employee's entity on file (${employee.entity}).`,
        });
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
            note: `Trip #${trip?.tripNumber ?? "?"} on route "${route?.routeCode ?? route?.id ?? "unknown"}" is at/over capacity.`,
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
        console.error(
          `[weeklySchedule][row] employeeCode=${employeeCode} ROUTE/TRIP CREATION THREW: ${routeError.message}\n${routeError.stack}`,
        );
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
        excludeEmployeeId: employee.id,
        caches,
        options: {
          trustProposedDriver: true,
          skipAutoAssignDriver: driverNamedButUnmatched,
        },
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

      const officeArrivalTimeRaw = get("officeArrivalTime");
      const dropTimeRaw = get("dropTime");
      const serviceType = deriveServiceType(officeArrivalTimeRaw, dropTimeRaw);

      const officeArrivalDate = parseSheetTimeToDate(officeArrivalTimeRaw);
      const dropDate = parseSheetTimeToDate(dropTimeRaw);
      const pickupDate = computePickupTime(officeArrivalDate);

      if (
        officeArrivalTimeRaw &&
        !officeArrivalDate &&
        serviceType !== "DROP_ONLY"
      ) {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Office Arrival Time "${officeArrivalTimeRaw}" could not be parsed into a valid time — pickup time could not be derived.`,
        });
      }
      if (dropTimeRaw && !dropDate && serviceType !== "PICK_ONLY") {
        results.notes.push({
          row: rowNum,
          employeeCode,
          note: `Drop Time "${dropTimeRaw}" could not be parsed into a valid time.`,
        });
      }

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
        vehicleEntity: vehicleEntity || undefined,
        serviceType,
        shiftTiming: shiftTiming || undefined,
        pickupTime: pickupDate || undefined,
        officeArrivalTime: officeArrivalDate || undefined,
        dropTime: dropDate || undefined,
        offDay: get("offDay") || undefined,
        ...dayFields,
        status: missingDriver || missingVehicle ? "DRAFT" : "ACTIVE",
      };

      const shouldSkipRow = await runExclusiveForEmployee(
        employee.id,
        async () => {
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
                    mergedTrip.route = route;
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
                const prevDriverRaw =
                  prevPending.driverRaw || prevData.driverId;
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
              return true;
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
              return true;
            }
            const existingHasId = Boolean(existing?.id);
            if (existingHasId) results.updated++;
            else results.created++;
            pendingByEmployeeId.set(employee.id, pendingWrites.length);
            pendingWrites.push({
              employee,
              existing: existingHasId ? existing : null,
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
            ...(existing?.id ? { id: existing.id } : {}),
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

          return false;
        },
      );

      if (shouldSkipRow) return;

      if (pendingWrites.length >= PENDING_WRITE_FLUSH_SIZE) {
        await flushPendingWrites();
      }
    } catch (rowError) {
      console.error(
        `[weeklySchedule][row] employeeCode=${employeeCode} row=${rowNum} UNCAUGHT ERROR: ${rowError.message}\n${rowError.stack}`,
      );
      await skipRow(sheetName, rowNum, employeeCode, rowError.message, raw);
    } finally {
      processedCount += 1;
      updateBulkUploadJob(jobId, { processedRows: processedCount });

      if (processedCount % 50 === 0) {
        console.log(
          `[weeklySchedule][progress] processed ${processedCount} rows so far...`,
        );
      }

      if (processedCount % batchSize === 0) {
        batchesCompleted += 1;
        console.log(
          `[weeklySchedule][batch] batch ${batchesCompleted} complete (processedRows=${processedCount})`,
        );
        updateBulkUploadJob(jobId, {
          batchesCompleted,
          partialResult: JSON.parse(JSON.stringify(results)),
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };

  console.log(
    `[weeklySchedule][job ${jobId}] processing ${rowGroups.size} area group(s), concurrency=${ROW_GROUP_CONCURRENCY}`,
  );

  await Promise.all(
    Array.from(rowGroups.entries()).map(([, groupRows]) =>
      limit(async () => {
        for (const { sheetName, raw, rowNum, colIndex } of groupRows) {
          await processRow(sheetName, raw, rowNum, colIndex);
        }
      }),
    ),
  );

  console.log(`[weeklySchedule][job ${jobId}] all groups done, final flush...`);
  await flushPendingWrites();
  console.log(`[weeklySchedule][job ${jobId}] final flush complete.`);

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

  console.log(`[weeklySchedule][job ${jobId}] syncing pending rides...`);
  await syncPendingRidesForWeekBestEffort(weekStartDate);
  console.log(
    `[weeklySchedule][job ${jobId}] COMPLETE. created=${results.created} updated=${results.updated} skipped=${results.skipped.length}`,
  );

  return results;
};

// ---------- Driver Options ----------

const getDriverOptions = async (req, res, next) => {
  try {
    const drivers = await prisma.driver.findMany({
      where: {
        vehicle: {
          isNot: null,
        },
      },
      select: {
        id: true,
        name: true,
        status: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    const response = okResponse(
      drivers,
      "Available driver options retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
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

    console.log(
      `[weeklySchedule][job ${jobId}] launching background processing...`,
    );
    processBulkUploadJob(jobId, workbook, weekStartDate, batchSize)
      .then((results) => {
        console.log(`[weeklySchedule][job ${jobId}] resolved OK.`);
        updateBulkUploadJob(jobId, { status: "done", result: results });
      })
      .catch((error) => {
        console.error(
          `[weeklySchedule][job ${jobId}] FAILED (uncaught at top level): ${error.message}\n${error.stack}`,
        );
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
  normalizeEntity,
  parseSheetTimeOfDay,
  parseSheetTimeToDate,
  toShiftTimeDate,
  toIsoOrNull,
  computePickupTime,
  getDriverOptions,
  updateTripDriver,
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