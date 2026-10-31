// utils/routePickupPoint.js
//
// A Route has ONE common pickup point (e.g. "Karsaz"). The driver goes to that
// point, every employee of the route gathers there, then the driver goes to the
// office. Individual employee home coordinates are never used as driver stops.
//
// Exports
//   ROUTE_PICKUP_SELECT          Prisma select fragment for `route: { select }`
//   resolveRoutePickupPoint()    pure: route -> { name, latitude, longitude, source }
//   ensureRoutePickupPoint()     request path: fill missing coords (time-boxed, safe)
//   withGeocodedPickupPoint()    write path: use in admin route create/update

const { geocodeLocation } = require("./geocode");

// ── select fragment ──────────────────────────────────────────────────────────
const ROUTE_PICKUP_SELECT = {
  id: true,
  pickupPointName: true,
  pickupLatitude: true,
  pickupLongitude: true,
};

// ── validation ───────────────────────────────────────────────────────────────
const isValidCoord = (lat, lng) =>
  typeof lat === "number" &&
  typeof lng === "number" &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180 &&
  !(lat === 0 && lng === 0); // "null island" = an unset value, never a real stop

// The place to look up / display. Auto-created route names are composites such as
// "Karsaz - 9AM-6PM - IBT_1" (area - shift - office), which can't be geocoded, so:
//   explicit pickupPointName  >  the route's area name  >  first segment of routeName
const firstSegment = (name) => {
  const head = String(name ?? "").split(" - ")[0].trim();
  return head || null;
};
const effectiveName = (r) =>
  r?.pickupPointName?.trim() || r?.area?.name?.trim() || firstSegment(r?.routeName) || null;

const badInput = (message) =>
  Object.assign(new Error(message), { statusCode: 400, status: 400 });

// ── pure resolver ────────────────────────────────────────────────────────────
/**
 * source: "ROUTE"   -> route has valid coordinates (normal case)
 *         "NOT_SET" -> no coordinates; the client should show the name only
 *
 * Deliberately NO "average of employee homes" fallback: a synthetic point can land
 * somewhere meaningless and send a driver to the wrong place. Not set is honest.
 */
const resolveRoutePickupPoint = (route) => {
  const name = effectiveName(route);
  if (isValidCoord(route?.pickupLatitude, route?.pickupLongitude)) {
    return {
      name,
      latitude: route.pickupLatitude,
      longitude: route.pickupLongitude,
      source: "ROUTE",
    };
  }
  return { name, latitude: null, longitude: null, source: "NOT_SET" };
};

// ── request path: lazy fill ──────────────────────────────────────────────────
const FAILED_TTL_MS = 60 * 60 * 1000; // don't retry a failed name for 1 hour
const MAX_FAILED_ENTRIES = 5000;
const failedLookups = new Map(); // routeId -> failedAt (ms)
const inFlight = new Map(); //      routeId -> Promise<{lat,lng}|null>

const GEO_HIT_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_MISS_TTL_MS = 60 * 60 * 1000;
const MAX_GEO_ENTRIES = 5000;
const geoCache = new Map(); //    normalized name -> { at, hit }
const geoInFlight = new Map(); // normalized name -> Promise<hit|null>

// Many routes share one place (every shift of "Karsaz"): look each NAME up once.
const geocodeCached = async (name, geocode) => {
  const key = String(name).trim().toLowerCase();
  const cached = geoCache.get(key);
  if (cached && Date.now() - cached.at < (cached.hit ? GEO_HIT_TTL_MS : GEO_MISS_TTL_MS)) {
    return cached.hit;
  }
  if (geoInFlight.has(key)) return geoInFlight.get(key);

  const job = (async () => {
    try {
      const hit = await geocode(name);
      if (geoCache.size >= MAX_GEO_ENTRIES) geoCache.delete(geoCache.keys().next().value);
      geoCache.set(key, { at: Date.now(), hit: hit ?? null });
      return hit ?? null;
    } finally {
      geoInFlight.delete(key);
    }
  })();
  geoInFlight.set(key, job);
  return job;
};

const _resetCachesForTests = () => {
  failedLookups.clear();
  inFlight.clear();
  geoCache.clear();
  geoInFlight.clear();
};

const rememberFailure = (routeId) => {
  if (failedLookups.size >= MAX_FAILED_ENTRIES) {
    failedLookups.delete(failedLookups.keys().next().value); // evict oldest
  }
  failedLookups.set(routeId, Date.now());
};

// One geocode+save job per route at a time; concurrent callers share it. Never rejects.
const runLookup = (prisma, route, geocode) => {
  const existing = inFlight.get(route.id);
  if (existing) return existing;

  const job = (async () => {
    try {
      const name = effectiveName(route);
      const hit = await geocodeCached(name, geocode);
      if (!hit) {
        rememberFailure(route.id);
        return null;
      }

      // Guarded write: only fills a route that STILL has no coordinates, so an
      // admin's manual edit made while we were looking up is never overwritten.
      const { count } = await prisma.route.updateMany({
        where: { id: route.id, pickupLatitude: null, pickupLongitude: null },
        data: {
          pickupLatitude: hit.latitude,
          pickupLongitude: hit.longitude,
          pickupPointGeocoded: true,
          ...(route.pickupPointName ? {} : { pickupPointName: effectiveName(route) }),
        },
      });

      if (count === 0) {
        // Someone set coordinates meanwhile - use theirs.
        const fresh = await prisma.route.findUnique({
          where: { id: route.id },
          select: { pickupLatitude: true, pickupLongitude: true },
        });
        return isValidCoord(fresh?.pickupLatitude, fresh?.pickupLongitude)
          ? { latitude: fresh.pickupLatitude, longitude: fresh.pickupLongitude }
          : null;
      }
      return { latitude: hit.latitude, longitude: hit.longitude };
    } catch (err) {
      console.error(`[routePickupPoint] lookup failed for route ${route.id}:`, err.message);
      rememberFailure(route.id);
      return null;
    } finally {
      inFlight.delete(route.id);
    }
  })();

  inFlight.set(route.id, job);
  return job;
};

/**
 * Returns the route with coordinates filled in when possible. Safe to call on every
 * request: no-op when coords exist, shares one lookup between concurrent callers,
 * is time-boxed (the lookup keeps running in the background and is saved for the
 * next request), and never throws.
 */
const ensureRoutePickupPoint = async (prisma, route, options = {}) => {
  const { deadlineMs = 3000, geocode = geocodeLocation } = options;

  if (!route?.id) return route;
  if (isValidCoord(route.pickupLatitude, route.pickupLongitude)) return route;
  if (!effectiveName(route)) return route;

  const failedAt = failedLookups.get(route.id);
  if (failedAt && Date.now() - failedAt < FAILED_TTL_MS) return route;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });

  try {
    const hit = await Promise.race([runLookup(prisma, route, geocode), timeout]);
    return hit
      ? { ...route, pickupLatitude: hit.latitude, pickupLongitude: hit.longitude }
      : route;
  } finally {
    clearTimeout(timer);
  }
};

// ── write path: admin create / update ────────────────────────────────────────
/**
 * Use in the admin route create/update handler on the data about to be saved:
 *
 *   create:  const data = await withGeocodedPickupPoint(req.body);
 *   update:  const existing = await prisma.route.findUnique({ where: { id } });
 *            const data = await withGeocodedPickupPoint(req.body, existing);
 *
 * Rules
 *   - Coordinates typed by an admin are validated, kept, and marked manual.
 *   - Manual coordinates are NEVER replaced by a lookup on later edits.
 *   - Unchanged name  -> nothing is looked up (so saving a full form is safe).
 *   - Changed name on an auto-looked-up route -> looked up again; if that fails the
 *     stale coordinates are cleared (they belong to the old name).
 * Throws an error with statusCode 400 for invalid manual coordinates.
 */
const withGeocodedPickupPoint = async (data, existing = null, options = {}) => {
  const { geocode = geocodeLocation } = options;
  const d = { ...(data ?? {}) };

  // 1) Admin supplied coordinates.
  const lat = d.pickupLatitude;
  const lng = d.pickupLongitude;
  const supplied = lat != null || lng != null;

  if (supplied) {
    if (!isValidCoord(lat, lng)) {
      throw badInput("pickupLatitude/pickupLongitude must be valid coordinates.");
    }
    const sameAsStored =
      existing && existing.pickupLatitude === lat && existing.pickupLongitude === lng;
    if (!sameAsStored) d.pickupPointGeocoded = false; // typed by a human
    return d;
  }

  // 2) Existing, valid coordinates that must be preserved.
  const hasStored = isValidCoord(existing?.pickupLatitude, existing?.pickupLongitude);
  const nextName = effectiveName({
    pickupPointName: d.pickupPointName ?? existing?.pickupPointName,
    routeName: d.routeName ?? existing?.routeName,
    area: existing?.area,
  });

  if (hasStored) {
    if (existing.pickupPointGeocoded === false) return d; // manual: never touch
    if (nextName === effectiveName(existing)) return d; //   same name: nothing to do
  }

  // 3) Look up from the name.
  if (!nextName) return d;
  const hit = await geocodeCached(nextName, geocode);

  if (hit) {
    return {
      ...d,
      pickupPointName: d.pickupPointName ?? existing?.pickupPointName ?? nextName,
      pickupLatitude: hit.latitude,
      pickupLongitude: hit.longitude,
      pickupPointGeocoded: true,
    };
  }

  // Lookup failed. Stale coordinates (from the old name) must not survive a rename.
  if (hasStored) {
    return {
      ...d,
      pickupLatitude: null,
      pickupLongitude: null,
      pickupPointGeocoded: false,
    };
  }
  return d;
};

// ── bulk creation: reuse a sibling route's point ─────────────────────────────
/**
 * Routes of the same area (and sub-area) share one physical pickup point - only the
 * shift differs. When creating a route, copy the point from a sibling that already
 * has one instead of looking the same place up again.
 * @param routes    routes of the same area (with their pickup fields)
 * @param subAreaId the new route's sub-area (null/undefined = none)
 * @returns {{pickupPointName, pickupLatitude, pickupLongitude, pickupPointGeocoded}|null}
 */
const pickupPointFromSibling = (routes, subAreaId) => {
  const sub = subAreaId || null;
  const sibling = (routes ?? []).find(
    (r) => (r.subAreaId || null) === sub && isValidCoord(r.pickupLatitude, r.pickupLongitude),
  );
  return sibling
    ? {
        pickupPointName: sibling.pickupPointName ?? null,
        pickupLatitude: sibling.pickupLatitude,
        pickupLongitude: sibling.pickupLongitude,
        pickupPointGeocoded: sibling.pickupPointGeocoded ?? false,
      }
    : null;
};

module.exports = {
  lookupNameFor: effectiveName,
  pickupPointFromSibling,
  ROUTE_PICKUP_SELECT,
  resolveRoutePickupPoint,
  ensureRoutePickupPoint,
  withGeocodedPickupPoint,
  isValidCoord,
  _resetCachesForTests,
};