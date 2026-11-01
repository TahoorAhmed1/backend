'use strict';
/**
 * PM2 process "myapp-location-worker". Consumer groups (all driven by the ACTORS registry):
 *   driver   : driver-location-heatmap | driver-location-realtime | driver-location-persist
 *   employee : employee-location-persist
 * Plus the 30 s sweeper. Scale by running more instances (<= partition count).
 */
try { require('dotenv').config(); } catch (_) { /* PM2 env_file already loaded .env */ }

const loc = require('../services/location/location.service');
const { config, ALL_ACTORS, kafka, redis, ensureTopics, decode } = loc.internals;

const FK_VIOLATION = 'P2003';

function latestLocationsByActor(messages, maxEventAgeMs, now = Date.now()) {
  const latest = new Map();
  for (const message of messages) {
    const event = decode(message);
    if (event && now - event.ts <= maxEventAgeMs) latest.set(event.actorId, event);
  }
  return latest;
}

/* Per-key write throttle with bounded memory (idle keys are pruned). */
function createThrottle({ minIntervalMs, pruneEveryMs = 60_000 }) {
  const state = new Map(); // key -> { ts, marker }
  const maxIdleMs = Math.max(minIntervalMs * 60, 10 * 60_000);
  const timer = setInterval(() => {
    const cutoff = Date.now() - maxIdleMs;
    for (const [k, v] of state) if (v.ts < cutoff) state.delete(k);
  }, pruneEveryMs);
  timer.unref?.();

  return {
    /** allow if: first time, interval elapsed, or `marker` changed (e.g. new H3 cell). */
    allow(key, ts, marker = null) {
      const prev = state.get(key);
      const ok = !prev || ts - prev.ts >= minIntervalMs || (marker !== null && marker !== prev.marker);
      if (ok) state.set(key, { ts, marker });
      return ok;
    },
    stop: () => clearInterval(timer),
  };
}

/* ── handlers: each returns an eachBatch(); each message is decoded safely, bad ones skipped ── */

// Drivers: update H3 counters in Redis.
const heatmapHandler = () => async ({ batch, resolveOffset, heartbeat }) => {
  for (const message of batch.messages) {
    const evt = decode(message);
    if (evt && Date.now() - evt.ts <= config.maxEventAgeMs) await loc.heatmap.recordPing(evt, config.city);
    resolveOffset(message.offset);
    await heartbeat();
  }
};

// Drivers: one live position event per driver, independent of how many rides are active.
const realtimeHandler = () => {
  const { triggerDriverLocation } = require('../services/notification.service');
  const throttle = createThrottle({ minIntervalMs: 1_000 });

  const handler = async ({ batch, resolveOffset, heartbeat }) => {
    const latest = latestLocationsByActor(batch.messages, config.maxEventAgeMs);
    const results = await Promise.allSettled(
      [...latest.values()]
        .filter((e) => throttle.allow(e.actorId, e.ts))
        .map((e) =>
          triggerDriverLocation(e.actorId, {
            rideId: null,
            driverId: e.actorId,
            latitude: e.lat,
            longitude: e.lng,
            accuracy: e.accuracy,
            speed: e.speed,
            heading: e.heading,
            recordedAt: new Date(e.ts),
          }),
        ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) console.error(`[location.realtime] ${failed}/${results.length} pusher triggers failed`);
    for (const message of batch.messages) resolveOffset(message.offset);
    await heartbeat();
  };
  handler.stop = throttle.stop;
  return handler;
};

// Bulk insert that survives a poison row: if a ride/driver was deleted while its pings were still in
// Kafka, createMany throws an FK error; retried forever it would stall the partition. Fall back to
// row-by-row and drop only the orphans.
async function insertRows(delegate, rows, label) {
  try {
    await delegate.createMany({ data: rows });
    return;
  } catch (err) {
    if (err?.code !== FK_VIOLATION) throw err;
  }
  let dropped = 0;
  for (const row of rows) {
    try {
      await delegate.create({ data: row });
    } catch (err) {
      if (err?.code !== FK_VIOLATION) throw err;
      dropped += 1;
    }
  }
  if (dropped) console.warn(`[location.persist:${label}] dropped ${dropped} orphan row(s) (FK violation)`);
}

// Generic for every actor: registry says which model, how often, and whether a cell change forces a write.
const persistHandler = (actor, prisma) => {
  const { model, minIntervalMs, onCellChange } = actor.persist;
  const throttle = createThrottle({ minIntervalMs });

  const handler = async ({ batch, resolveOffset, heartbeat }) => {
    const rows = [];
    for (const message of batch.messages) {
      const evt = decode(message);
      if (!evt) continue;
      const marker = onCellChange ? loc.heatmap.toCell(evt.lat, evt.lng) : null;
      if (!throttle.allow(`${evt.actorId}:${evt.rideId ?? ''}`, evt.ts, marker)) continue;
      rows.push({
        [actor.idField]: evt.actorId,
        rideId: evt.rideId,
        latitude: evt.lat, longitude: evt.lng,
        accuracy: evt.accuracy, speed: evt.speed, heading: evt.heading,
        recordedAt: new Date(evt.ts),
      });
    }
    if (rows.length) await insertRows(prisma[model], rows, actor.key);
    for (const message of batch.messages) resolveOffset(message.offset);
    await heartbeat();
  };
  handler.stop = throttle.stop;
  return handler;
};

/* ── bootstrap ── */
async function startConsumer(groupId, topic, eachBatch) {
  const consumer = kafka.consumer({ groupId });
  // kafkajs restarts a crashed consumer by itself; we just make the crash visible.
  consumer.on(consumer.events.CRASH, (e) =>
    console.error(`[location:${groupId}] crash (restart=${e.payload.restart}):`, e.payload.error?.message),
  );
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({ eachBatch, partitionsConsumedConcurrently: 1 });
  return consumer;
}

async function startLocationWorkers() {
  const { prisma } = require('../lib/prisma');
  await ensureTopics();

  const consumers = [];
  const stoppers = [];

  for (const actor of ALL_ACTORS) {
    if (actor.heatmap) consumers.push(await startConsumer(`${actor.key}-location-heatmap`, actor.topic, heatmapHandler()));
    if (actor.realtime) {
      const realtime = realtimeHandler();
      stoppers.push(realtime.stop);
      consumers.push(await startConsumer(`${actor.key}-location-realtime`, actor.topic, realtime));
    }
    const persist = persistHandler(actor, prisma);
    stoppers.push(persist.stop);
    consumers.push(await startConsumer(`${actor.key}-location-persist`, actor.topic, persist));
  }
  stoppers.push(loc.heatmap.startSweeper(config.city));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[location-worker] ${signal}, draining...`);
    stoppers.forEach((stop) => stop());
    await Promise.allSettled(consumers.map((c) => c.disconnect()));
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  console.log(`[location-worker] up: ${consumers.length} consumer groups, city=${config.city}, h3Res=${config.h3Res}`);
}

module.exports = { createThrottle, latestLocationsByActor, startLocationWorkers };

if (require.main === module || process.env.pm_id !== undefined) {
  startLocationWorkers().catch((err) => {
    console.error('[location-worker] fatal:', err);
    process.exit(1); // PM2 autorestarts
  });
}