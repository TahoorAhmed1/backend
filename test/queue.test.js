const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRedisUrl } = require('../lib/queue');

test('normalizeRedisUrl keeps a valid redis scheme', () => {
  assert.equal(normalizeRedisUrl('redis://localhost:6379'), 'redis://localhost:6379');
});

test('normalizeRedisUrl adds a redis scheme when missing', () => {
  assert.equal(normalizeRedisUrl('localhost:6379'), 'redis://localhost:6379');
});

test('normalizeRedisUrl throws for blank values', () => {
  assert.throws(() => normalizeRedisUrl('   '), /REDIS_URL is not configured/i);
});
