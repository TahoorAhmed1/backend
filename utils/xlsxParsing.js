// ---------- XLSX bulk-upload parsing helpers ----------
// Header aliasing, day/off-day parsing, vehicle/area/entity normalization.

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
  "vehicle entity": "vehicleEntity",
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
  location: "location",
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

const normalizeDateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.trim();
  return String(value);
};

const scheduleDataChanged = (existing = {}, incoming = {}) => {
  const keyFields = [
    'shiftTiming',
    'driverId',
    'routeId',
    'pickupTime',
    'officeArrivalTime',
    'dropTime',
    'offDay',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ];

  for (const key of keyFields) {
    const a = normalizeDateValue(existing[key]);
    const b = normalizeDateValue(incoming[key]);
    if (a !== b) return true;
  }

  return false;
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


const ENTITY_VALUES = new Set(["IBEX", "VW"]);

const normalizeEntity = (raw) => {
  const key = String(raw || "")
    .trim()
    .toUpperCase();
  return ENTITY_VALUES.has(key) ? key : null;
};


module.exports = {
  DAY_ABBR_MAP,
  HEADER_ALIASES,
  parseOffDays,
  deriveServiceType,
  normalizeShiftForCompare,
  parseDriverEntries,
  parseDriverEntry,
  normalizeMatch,
  scheduleDataChanged,
  VEHICLE_TYPES,
  VEHICLE_TYPE_ALIASES,
  normalizeVehicleType,
  AREA_ALIASES,
  normalizeAreaName,
  ENTITY_VALUES,
  normalizeEntity,
};
