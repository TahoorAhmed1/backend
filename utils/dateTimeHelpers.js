// ---------- Date / Time helpers ----------
// Pure helpers for working with week-start dates and shift/time-of-day parsing.

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const toDateOnly = (d) => {
  const date = new Date(d);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

const formatDateOnly = (d) => new Date(d).toISOString().slice(0, 10);

const saturdayOfCurrentWeek = () => {
  const now = new Date();
  const utcToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const daysSinceSaturday = (utcToday.getUTCDay() + 1) % 7;
  return new Date(
    utcToday.getTime() - daysSinceSaturday * 24 * 60 * 60 * 1000,
  );
};

/**
 * Normalize any input date to UTC midnight of the Saturday that begins
 * the week containing that date.
 *
 * Schedule week-start values use UTC midnight, and this helper guarantees
 * the reassign endpoint compares on exactly the same Saturday value even if
 * the caller sends another day from that week.
 *
 * JS getUTCDay(): 0=Sun, 1=Mon, ..., 6=Sat
 */
function toSaturdayUtcMidnight(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid weekStart: ${input}`);
  }

  // 1) Flatten to UTC midnight of the calendar day as the client sees it.
  //    Using UTC getters/setters keeps this deterministic regardless of
  //    the server's TZ.
  const utcMidnight = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );

  // 2) Snap backwards to the most recent Saturday.
  //    Sat=6 -> offset 0, Sun=0 -> offset 1, Mon=1 -> offset 2, ...
  const day = utcMidnight.getUTCDay();
  const offset = (day + 1) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - offset);

  return utcMidnight;
}

const DAY_FIELD_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

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

function normalizeTime(value) {
  if (!value) return null;

  // Date object → HH:mm
  if (value instanceof Date) {
    const hh = String(value.getUTCHours()).padStart(2, "0");
    const mm = String(value.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // String "9:00 PM", "21:00", "9:00pm-6:00am" (shift style) etc.
  if (typeof value === "string") {
    // Range ho to sirf start lo
    const first = value.split("-")[0].trim();
    const m = first.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
    if (!m) return first.toLowerCase();

    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = (m[3] || "").toLowerCase();

    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;

    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  return null;
}



module.exports = {
  DAY_KEYS,
  DAY_FIELD_KEYS,
  toDateOnly,
  formatDateOnly,
  saturdayOfCurrentWeek,
  parseSheetTimeOfDay,
  timeOfDayToUtcDate,
  parseSheetTimeToDate,
  toShiftTimeDate,
  toIsoOrNull,
  toSaturdayUtcMidnight,
  computePickupTime,
  normalizeTime
};
