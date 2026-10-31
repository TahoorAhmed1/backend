// utils/geocode.js
//
// Place name -> coordinates, using FREE services only (no API key, no billing).
//
//   1. OpenStreetMap Nominatim   (primary)
//   2. Photon by Komoot          (fallback, also OpenStreetMap data)
//
// Guarantees
//   - Nominatim's 1 request/second policy is enforced even under concurrent calls
//     (requests are queued, not just delayed).
//   - Every result is validated against a bounding box (default: Karachi), so a
//     name can never resolve to another city or country.
//   - Never throws: returns null on any failure (network, HTTP, bad payload).
//
// Config (all optional): GEOCODE_USER_AGENT, GEOCODE_CITY, GEOCODE_COUNTRY_CODE,
// GEOCODE_COUNTRY_NAME, GEOCODE_BOUNDS="south,west,north,east".
// Requires Node >= 18 (global fetch + AbortSignal.timeout).

const DEFAULTS = {
  city: process.env.GEOCODE_CITY || "Karachi",
  countryCode: (process.env.GEOCODE_COUNTRY_CODE || "pk").toLowerCase(),
  countryName: process.env.GEOCODE_COUNTRY_NAME || "Pakistan",
  // south, west, north, east (Karachi metro area)
  bounds: (process.env.GEOCODE_BOUNDS || "24.70,66.80,25.20,67.50")
    .split(",")
    .map(Number),
  userAgent:
    process.env.GEOCODE_USER_AGENT || "transport-app/1.0 (admin@yourcompany.com)",
  timeoutMs: 6000,
  // Public Nominatim allows 1 request/second. Only lower this if you self-host Nominatim.
  nominatimMinIntervalMs: Number.isFinite(Number(process.env.GEOCODE_NOMINATIM_MIN_INTERVAL_MS))
    && process.env.GEOCODE_NOMINATIM_MIN_INTERVAL_MS !== undefined
    ? Number(process.env.GEOCODE_NOMINATIM_MIN_INTERVAL_MS)
    : 1100,
  fetch: undefined, // resolved at call time (see getFetch) so polyfills/stubs are honoured
};

const createGeocoder = (overrides = {}) => {
  const cfg = { ...DEFAULTS, ...overrides };
  const [SOUTH, WEST, NORTH, EAST] = cfg.bounds;
  const centerLat = (SOUTH + NORTH) / 2;
  const centerLng = (WEST + EAST) / 2;

  const inBounds = (lat, lng) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= SOUTH &&
    lat <= NORTH &&
    lng >= WEST &&
    lng <= EAST;

  // --- Nominatim rate limit: a promise chain, so concurrent callers queue up ---
  let chain = Promise.resolve();
  let lastCallAt = 0;
  const nominatimSlot = () => {
    const slot = chain.then(async () => {
      const wait = lastCallAt + cfg.nominatimMinIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCallAt = Date.now();
    });
    chain = slot.catch(() => {});
    return slot;
  };

  const getFetch = () => cfg.fetch ?? globalThis.fetch;

  const getJson = async (url) => {
    const res = await getFetch()(url, {
      headers: { "User-Agent": cfg.userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const nominatim = async (query) => {
    await nominatimSlot();
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", `${query}, ${cfg.city}, ${cfg.countryName}`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", cfg.countryCode);
    url.searchParams.set("viewbox", `${WEST},${NORTH},${EAST},${SOUTH}`);
    const arr = await getJson(url);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return { latitude: parseFloat(arr[0].lat), longitude: parseFloat(arr[0].lon) };
  };

  const photon = async (query) => {
    const url = new URL("https://photon.komoot.io/api/");
    url.searchParams.set("q", `${query} ${cfg.city}`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("lat", String(centerLat));
    url.searchParams.set("lon", String(centerLng));
    url.searchParams.set("bbox", `${WEST},${SOUTH},${EAST},${NORTH}`);
    const json = await getJson(url);
    const c = json?.features?.[0]?.geometry?.coordinates; // GeoJSON: [lon, lat]
    return Array.isArray(c) ? { latitude: c[1], longitude: c[0] } : null;
  };

  const providers = [
    { name: "nominatim", run: nominatim },
    { name: "photon", run: photon },
  ];

  /** @returns {Promise<{latitude:number, longitude:number, provider:string}|null>} */
  const geocodeLocation = async (rawName) => {
    const query = String(rawName ?? "").trim();
    if (!query) return null;
    if (typeof getFetch() !== "function") {
      console.error("[geocode] global fetch is unavailable (Node >= 18 required).");
      return null;
    }

    for (const provider of providers) {
      try {
        const hit = await provider.run(query);
        if (hit && inBounds(hit.latitude, hit.longitude)) {
          return { ...hit, provider: provider.name };
        }
      } catch (err) {
        console.error(`[geocode] ${provider.name} failed for "${query}": ${err.message}`);
      }
    }
    return null;
  };

  return { geocodeLocation };
};

const defaultGeocoder = createGeocoder();

module.exports = {
  geocodeLocation: defaultGeocoder.geocodeLocation,
  createGeocoder,
};