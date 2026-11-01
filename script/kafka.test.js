'use strict';
// node --test services/location.test.js   (pure logic only: no Redis / Kafka / DB needed)
const test = require('node:test');
const assert = require('node:assert/strict');

// ioredis connects on construct; stub it so requiring the module is side-effect free in tests.
const Module = require('node:module');
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'ioredis') return class { defineCommand() {} on() {} };
  return realLoad.call(this, request, ...rest);
};
const { ACTORS, internals } = require('../services/location/location.service');
const { createThrottle, latestLocationsByActor } = require('../worker/location.process');
Module._load = realLoad;    

const { parseGpsSample, encode, decode } = internals;
const msg = (value) => ({ value: Buffer.from(value) });

test('validation: minimal sample, optionals become null', () => {
  const r = parseGpsSample({ latitude: 24.86, longitude: 67 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { latitude: 24.86, longitude: 67, accuracy: null, speed: null, heading: null });
});

test('validation: iOS -1 means unknown, not an error', () => {
  const r = parseGpsSample({ latitude: 1, longitude: 1, accuracy: -1, speed: -1, heading: -1 });
  assert.equal(r.ok, true);
  assert.equal(r.value.speed, null);
});

test('validation: rejects bad coordinates and metadata', () => {
  for (const b of [undefined, null, {}, { latitude: '1', longitude: 1 }, { latitude: NaN, longitude: 1 }]) {
    assert.equal(parseGpsSample(b).ok, false);
  }
  assert.match(parseGpsSample({ latitude: 91, longitude: 0 }).message, /Latitude/);
  assert.match(parseGpsSample({ latitude: 0, longitude: 181 }).message, /Longitude/);
  assert.match(parseGpsSample({ latitude: 1, longitude: 1, heading: 361 }).message, /Heading/);
});

test('codec: round-trip, and garbage decodes to null without throwing', () => {
  const e = decode(msg(encode(ACTORS.driver, { actorId: 'd1', rideId: 'r1', latitude: 1, longitude: 2 }, 123)));
  assert.deepEqual([e.actor, e.actorId, e.lat, e.ts], ['driver', 'd1', 1, 123]);
  for (const bad of ['not json', '{}', '{"v":99}', '{"v":1,"actorId":"x"}']) assert.equal(decode(msg(bad)), null);
});

test('realtime batches collapse to one latest location per driver', () => {
  const messages = [
    { actorId: 'd1', latitude: 1, ts: 100 },
    { actorId: 'd1', latitude: 2, ts: 110 },
    { actorId: 'd2', latitude: 3, ts: 120 },
  ].map(({ actorId, latitude, ts }) =>
    msg(encode(ACTORS.driver, { actorId, latitude, longitude: 1, rideId: null }, ts)),
  );
  const latest = latestLocationsByActor(messages, 30, 125);
  assert.equal(latest.size, 2);
  assert.equal(latest.get('d1').lat, 2);
  assert.equal(latest.get('d2').lat, 3);
});

test('throttle: interval, marker (new H3 cell) bypass, key isolation', () => {
  const t = createThrottle({ minIntervalMs: 10_000 });
  assert.equal(t.allow('d1', 1_000, 'A'), true);
  assert.equal(t.allow('d1', 2_000, 'A'), false);
  assert.equal(t.allow('d1', 3_000, 'B'), true);   // cell changed
  assert.equal(t.allow('d1', 14_000, 'B'), true);  // interval elapsed
  assert.equal(t.allow('d2', 14_001, 'B'), true);  // other key
  t.stop();
});