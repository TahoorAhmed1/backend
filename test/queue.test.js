const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRedisUrl } = require('../lib/queue');
const pm2Config = require('../ecosystem.config.js');

test('normalizeRedisUrl keeps a valid redis scheme', () => {
  assert.equal(normalizeRedisUrl('redis://localhost:6379'), 'redis://localhost:6379');
});

test('normalizeRedisUrl adds a redis scheme when missing', () => {
  assert.equal(normalizeRedisUrl('localhost:6379'), 'redis://localhost:6379');
});

test('normalizeRedisUrl throws for blank values', () => {
  assert.throws(() => normalizeRedisUrl('   '), /REDIS_URL is not configured/i);
});

test('pm2 loads the project env file for all managed apps', () => {
  const apps = pm2Config.apps || [];

  assert.ok(apps.some((app) => app.name === 'myapp' && app.env_file === '.env'));
  assert.ok(apps.some((app) => app.name === 'myapp-bulk' && app.env_file === '.env'));
});
