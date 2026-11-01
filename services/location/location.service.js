'use strict';
/**
 * Location pipeline — shared core (API + worker). Driver and employee use ONE flow:
 *
 *   controller -> ingestLocation(): validate -> authorise (Redis cache, DB fallback)
 *              -> Kafka  <actor>.location (key = actorId, ordered per actor)
 *   worker/location.process.js consumes it: heatmap (Redis H3) | realtime (Pusher) | persist (Postgres)
 *
 * Heatmap rules (drivers):
 *   same H3 cell ping   -> only "last seen" refreshed   (driver stopped at a signal stays counted)
 *   new cell            -> old cell -1, new cell +1     (one atomic Lua script)
 *   silent > 30 s       -> sweeper: cell -1, forget     (wifi off / app killed)
 *   ride done           -> removed immediately
 * A Redis key TTL cannot do the expiry (an expired key never runs a DECR), hence ZSET + sweeper.
 *
 * Sections: 1 config · 2 actors · 3 clients · 4 validation · 5 codec · 6 access cache
 *           7 heatmap store · 8 ingest · 9 exports
 */
const h3 = require('h3-js');
const Redis = require('ioredis');
const { Kafka, CompressionTypes, Partitioners, logLevel } = require('kafkajs');

/* ───────────────────────────── 1. config ───────────────────────────── */
const int = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[location] ${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
};

const config = Object.freeze({
  city: process.env.HEAT_CITY || 'karachi',        // Redis hash-tag => one shard per city
  h3Res: int('H3_RES', 8, { min: 0, max: 15 }),     // 8 ≈ 460 m edge, 9 ≈ 175 m
  driverTtlMs: int('DRIVER_TTL_MS', 30_000, { min: 1_000 }),
  sweepEveryMs: int('SWEEP_EVERY_MS', 5_000, { min: 500 }),
  maxEventAgeMs: int('MAX_EVENT_AGE_MS', 30_000, { min: 1_000 }),
  kafka: Object.freeze({
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',').map((b) => b.trim()),
    partitions: int('LOCATION_PARTITIONS', 6, { min: 1 }),
    replicationFactor: int('KAFKA_RF', 1, { min: 1 }),
  }),
  redis: Object.freeze({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    tls: process.env.REDIS_TLS === 'true',
  }),
});

/* ───────────────────────────── 2. actors ───────────────────────────── */
// The ONLY place where driver and employee differ. New tracked actor = new entry here.
const ACTORS = Object.freeze({
  driver: Object.freeze({
    key: 'driver',
    idField: 'driverId',
    topic: process.env.DRIVER_LOCATION_TOPIC || 'driver.location',
    access: Object.freeze({ grantedTtlS: 60, deniedTtlS: 5 }),
    heatmap: true,
    realtime: true,
    persist: Object.freeze({ model: 'driverLocation', minIntervalMs: 10_000, onCellChange: true }),
  }),
  employee: Object.freeze({
    key: 'employee',
    idField: 'employeeId',
    topic: process.env.EMPLOYEE_LOCATION_TOPIC || 'employee.location',
    access: Object.freeze({ grantedTtlS: 20, deniedTtlS: 5 }),
    heatmap: false,
    realtime: false,
    persist: Object.freeze({ model: 'employeeLocation', minIntervalMs: 5_000, onCellChange: false }),
  }),
});
const ALL_ACTORS = Object.freeze(Object.values(ACTORS));

/* ───────────────────────────── 3. clients ───────────────────────────── */
const redis = new Redis(config.redis.url, {
  ...(config.redis.tls ? { tls: {} } : {}),
  maxRetriesPerRequest: 2,
});
redis.on('error', (err) => console.error('[location.redis]', err.message));

const kafka = new Kafka({
  clientId: `fleet-${process.env.name || process.pid}`,
  brokers: config.kafka.brokers,
  logLevel: logLevel.WARN,
});
const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
let producerReady = null;

// Lazy + memoised; a FAILED connect is not memoised, so the next ping retries.
const connectProducer = () => {
  producerReady ??= producer.connect().catch((err) => {
    producerReady = null;
    throw err;
  });
  return producerReady;
};

const disconnectProducer = async () => {
  if (producerReady) await producer.disconnect().catch(() => {});
  producerReady = null;
};

/** Worker calls this once on boot. Idempotent. */
async function ensureTopics() {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      topics: ALL_ACTORS.map((a) => ({
        topic: a.topic,
        numPartitions: config.kafka.partitions,
        replicationFactor: config.kafka.replicationFactor,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

/* ───────────────────────────── 4. validation ───────────────────────────── */
// Devices report "unknown" as a negative number (iOS sends -1): treat as missing, don't reject.
const unknownIfNegative = (v) => (typeof v === 'number' && v < 0 ? null : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isMissing = (v) => v === undefined || v === null;
const bad = (message) => ({ ok: false, message });

/** Pure (no I/O). @returns {{ok:true,value:object}|{ok:false,message:string}} */
function parseGpsSample(body) {
  const b = body ?? {};
  const { latitude, longitude } = b;
  const accuracy = unknownIfNegative(b.accuracy);
  const speed = unknownIfNegative(b.speed);
  const heading = unknownIfNegative(b.heading);

  if (!isNum(latitude) || !isNum(longitude)) return bad('Valid latitude and longitude are required.');
  if (latitude < -90 || latitude > 90) return bad('Latitude must be between -90 and 90.');
  if (longitude < -180 || longitude > 180) return bad('Longitude must be between -180 and 180.');
  if (!isMissing(accuracy) && (!isNum(accuracy) || accuracy < 0)) return bad('Invalid accuracy.');
  if (!isMissing(speed) && (!isNum(speed) || speed < 0)) return bad('Invalid speed.');
  if (!isMissing(heading) && (!isNum(heading) || heading < 0 || heading > 360)) {
    return bad('Heading must be between 0 and 360.');
  }
  return {
    ok: true,
    value: { latitude, longitude, accuracy: accuracy ?? null, speed: speed ?? null, heading: heading ?? null },
  };
}

/* ───────────────────────────── 5. codec ───────────────────────────── */
// Versioned wire format. decode() never throws: a bad message is skipped, never crash-loops a partition.
const SCHEMA_VERSION = 1;

const encode = (actor, { actorId, rideId, latitude, longitude, accuracy, speed, heading }, ts) =>
  JSON.stringify({
    v: SCHEMA_VERSION, actor: actor.key, actorId, rideId: rideId ?? null,
    lat: latitude, lng: longitude,
    accuracy: accuracy ?? null, speed: speed ?? null, heading: heading ?? null, ts,
  });

function decode(message) {
  try {
    const e = JSON.parse(message.value.toString());
    if (e?.v !== SCHEMA_VERSION) return null;
    if (typeof e.actorId !== 'string' || !isNum(e.lat) || !isNum(e.lng) || !isNum(e.ts)) return null;
    return e;
  } catch {
    return null;
  }
}

/** key = actorId => one actor's pings stay in ONE partition => ordered. Server clock, not the phone's. */
async function publishLocation(actor, sample) {
  await connectProducer();
  const ts = Date.now();
  await producer.send({
    topic: actor.topic,
    compression: CompressionTypes.GZIP,
    messages: [{ key: sample.actorId, value: encode(actor, sample, ts) }],
  });
  return ts;
}

/* ───────────────────────────── 6. access cache ───────────────────────────── */
// Caches "may this user post locations for this ride?" so a ping costs 0 Postgres reads.
// DENY is cached briefly too (an app pinging a finished ride must not hammer the DB).
// Every op fails OPEN to the database: Redis down => slower, not broken.
const grantKey = (a, userId, rideId) => `loc:access:${a.key}:${userId}:${rideId}`;
const denyKey = (a, userId, rideId) => `${grantKey(a, userId, rideId)}:denied`;

async function readAccess(actor, userId, rideId) {
  if (!userId || !rideId) return null;
  try {
    const [granted, denied] = await redis.mget(grantKey(actor, userId, rideId), denyKey(actor, userId, rideId));
    if (granted) return { ok: true, actorId: granted };
    if (denied) return { ok: false, message: denied };
  } catch (err) {
    console.error('[location.access] read failed, using DB:', err.message);
  }
  return null;
}

async function rememberAccess(actor, userId, rideId, decision) {
  if (!userId || !rideId) return;
  try {
    if (decision.ok) await redis.set(grantKey(actor, userId, rideId), decision.actorId, 'EX', actor.access.grantedTtlS);
    else await redis.set(denyKey(actor, userId, rideId), decision.message, 'EX', actor.access.deniedTtlS);
  } catch (err) {
    console.error('[location.access] write failed:', err.message);
  }
}

/** Call on ride status transitions. Never throws. */
async function clearAccessCache(actor, userId, rideId) {
  if (!userId || !rideId) return;
  try {
    await redis.del(grantKey(actor, userId, rideId), denyKey(actor, userId, rideId));
  } catch (err) {
    console.error('[location.access] clear failed:', err.message);
  }
}

/* ───────────────────────────── 7. heatmap store ───────────────────────────── */
// {heat:<city>}:cell   HASH driverId -> last H3 cell      {heat:<city>}:counts ZSET cell     -> #drivers
// {heat:<city>}:seen   ZSET driverId -> last ping ts      {heat:<city>}:pos    HASH driverId -> last position
// The hash-tag keeps all four keys in one Redis-Cluster slot (required for Lua).
const heatKeys = (city = config.city) => {
  const tag = `{heat:${city}}`;
  return [`${tag}:cell`, `${tag}:seen`, `${tag}:counts`, `${tag}:pos`];
};

const lua = (cellVar) => `
  local c = redis.call('ZINCRBY', KEYS[3], -1, ${cellVar})
  if tonumber(c) <= 0 then redis.call('ZREM', KEYS[3], ${cellVar}) end`;

redis.defineCommand('heatPing', {
  numberOfKeys: 4,
  lua: `
    local old = redis.call('HGET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
    redis.call('HSET', KEYS[4], ARGV[1], ARGV[4])
    if old == ARGV[2] then return 0 end
    if old then ${lua('old')} end
    redis.call('ZINCRBY', KEYS[3], 1, ARGV[2])
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    return 1`,
});

redis.defineCommand('heatSweep', {
  numberOfKeys: 4,
  lua: `
    local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
    for _, id in ipairs(ids) do
      local cell = redis.call('HGET', KEYS[1], id)
      if cell then ${lua('cell')}
        redis.call('HDEL', KEYS[1], id)
      end
      redis.call('HDEL', KEYS[4], id)
      redis.call('ZREM', KEYS[2], id)
    end
    return #ids`,
});

redis.defineCommand('heatRemove', {
  numberOfKeys: 4,
  lua: `
    local cell = redis.call('HGET', KEYS[1], ARGV[1])
    if cell then ${lua('cell')}
      redis.call('HDEL', KEYS[1], ARGV[1])
    end
    redis.call('HDEL', KEYS[4], ARGV[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 1`,
});

const toCell = (lat, lng) => h3.latLngToCell(lat, lng, config.h3Res);

const heatmap = {
  toCell,

  async recordPing({ actorId, lat, lng, speed, heading, ts }, city) {
    const cell = toCell(lat, lng);
    const pos = JSON.stringify({ lat, lng, speed, heading, ts });
    const changed = await redis.heatPing(...heatKeys(city), actorId, cell, ts, pos);
    return { cell, changed: changed === 1 };
  },

  removeDriver: (driverId, city) => redis.heatRemove(...heatKeys(city), driverId),

  sweepStale: (city) => redis.heatSweep(...heatKeys(city), Date.now() - config.driverTtlMs, 500),

  /** @returns {() => void} stop function. Safe in several worker instances (atomic). */
  startSweeper(city) {
    const timer = setInterval(
      () => heatmap.sweepStale(city).catch((e) => console.error('[location.sweeper]', e.message)),
      config.sweepEveryMs,
    );
    return () => clearInterval(timer);
  },

  /** [{cell, count}] — the client draws hexagons with h3-js cellToBoundary(cell). */
  async snapshot(city) {
    const raw = await redis.zrange(heatKeys(city)[2], 0, -1, 'WITHSCORES');
    const out = [];
    for (let i = 0; i < raw.length; i += 2) out.push({ cell: raw[i], count: Number(raw[i + 1]) });
    return out;
  },

  /** Last known position; can replace driverLocation.findFirst() in read endpoints. */
  async lastPosition(driverId, city) {
    const raw = await redis.hget(heatKeys(city)[3], driverId);
    return raw ? JSON.parse(raw) : null;
  },

  /** Cell + neighbours, for "nearest driver" lookups. */
  neighbourhood: (lat, lng, k = 1) => h3.gridDisk(toCell(lat, lng), k),
};

/* ───────────────────────────── 8. ingest ───────────────────────────── */
/**
 * The ONE flow both controllers call. Controllers only pass the actor and an authorize()
 * callback holding their own DB rule; everything else is identical.
 * @param {() => Promise<{ok:true,actorId:string}|{ok:false,message:string}>} p.authorize
 * @returns {Promise<{ok:true,data:object}|{ok:false,message:string}>}
 */
async function ingestLocation({ actor, userId, rideId, body, authorize, locationRideId }) {
  const parsed = parseGpsSample(body); // reject garbage before touching Redis/DB
  if (!parsed.ok) return parsed;

  let decision = await readAccess(actor, userId, rideId);
  if (!decision) {
    decision = await authorize();
    await rememberAccess(actor, userId, rideId, decision);
  }
  if (!decision.ok) return decision;

  const ts = await publishLocation(actor, {
    actorId: decision.actorId,
    rideId: locationRideId === undefined ? rideId : locationRideId,
    ...parsed.value,
  });

  return {
    ok: true,
    data: {
      id: null, // the row is created asynchronously by the persist consumer
      [actor.idField]: decision.actorId,
      rideId,
      ...parsed.value,
      recordedAt: new Date(ts),
    },
  };
}

/* ───────────────────────────── 9. exports ───────────────────────────── */
module.exports = {
  // used by controllers
  ACTORS,
  ingestLocation,
  clearAccessCache,
  removeDriverFromHeatmap: heatmap.removeDriver,
  heatmap, // snapshot(), lastPosition(), neighbourhood()
  shutdownLocationProducer: disconnectProducer, // call from server.js SIGTERM handler

  // used by worker/location.process.js and tests
  internals: { config, ALL_ACTORS, kafka, redis, ensureTopics, decode, encode, parseGpsSample },
};