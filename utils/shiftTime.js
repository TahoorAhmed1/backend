// ---------- Shift Time Parsing / Overlap Detection ----------
//
// Extracted from weeklySchedule_controller.js so every place that needs to
// know "do these two shifts overlap" (weekly-schedule conflict checks, route
// creation, trip creation) shares one implementation instead of three
// slowly-diverging copies.

// Loose equality check for shift-timing strings so "6:00 PM - 3:00 AM" and
// "6:00pm-3:00am" compare equal.
const normalizeShift = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/-+/g, "-");

/**
 * "6:00 PM - 3:00 AM" -> { start: 1080, durationMinutes: 540, overnight: true }
 * start/durationMinutes are in minutes-from-midnight. Returns null if the
 * string can't be parsed as a "<time> - <time>" range, so callers can fall
 * back to exact-string comparison for formats we don't recognize.
 */
const parseShiftRange = (shiftTiming) => {
  if (!shiftTiming) return null;
  const parts = String(shiftTiming).split(/-|to/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const toMinutes = (t) => {
    const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = (m[3] || "").toUpperCase();
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };

  const start = toMinutes(parts[0]);
  const end = toMinutes(parts[1]);
  if (start === null || end === null) return null;

  const overnight = end <= start;
  const durationMinutes = overnight ? 24 * 60 - start + end : end - start;
  return { start, durationMinutes, overnight };
};

/**
 * True if two shift ranges share any time on a repeating 24h cycle. Handles
 * overnight shifts (e.g. "10 PM - 6 AM") by also comparing each range
 * shifted back a full day, since two overnight shifts can overlap across
 * the midnight boundary even though their raw start/end minutes don't.
 */
const shiftRangesOverlap = (a, b) => {
  if (!a || !b) return false;
  const windows = (r) => [
    [r.start, r.start + r.durationMinutes],
    [r.start - 1440, r.start - 1440 + r.durationMinutes],
  ];
  for (const [s1, e1] of windows(a)) {
    for (const [s2, e2] of windows(b)) {
      if (s1 < e2 && s2 < e1) return true;
    }
  }
  return false;
};

/**
 * Public entry point: overlap-aware shift comparison instead of exact-string
 * match. Falls back to normalizeShift() equality when either string can't be
 * parsed as a time range (e.g. a shift label like "Night A"), so unparseable
 * data doesn't silently stop being compared at all.
 */
const shiftTimesOverlap = (shiftA, shiftB) => {
  const a = parseShiftRange(shiftA);
  const b = parseShiftRange(shiftB);
  if (!a || !b) return normalizeShift(shiftA) === normalizeShift(shiftB);
  return shiftRangesOverlap(a, b);
};

module.exports = {
  normalizeShift,
  parseShiftRange,
  shiftRangesOverlap,
  shiftTimesOverlap,
};