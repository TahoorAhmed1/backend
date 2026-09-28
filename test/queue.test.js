const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRedisUrl, validateRedisConfiguration } = require('../lib/queue');
const pm2Config = require('../ecosystem.config.js');

test('normalizeRedisUrl keeps a valid redis scheme', () => {
  assert.equal(normalizeRedisUrl('rediss://localhost:6379'), 'rediss://localhost:6379');
});

test('normalizeRedisUrl adds a redis scheme when missing', () => {
  assert.equal(normalizeRedisUrl('localhost:6379'), 'rediss://localhost:6379');
});

test('normalizeRedisUrl throws for blank values', () => {
  assert.throws(() => normalizeRedisUrl('   '), /REDIS_URL is not configured/i);
});

test('validateRedisConfiguration rejects plain rediss:// with TLS enabled', () => {
  const originalUrl = process.env.REDIS_URL;
  const originalTls = process.env.REDIS_TLS;

  process.env.REDIS_URL = 'rediss://localhost:6379';
  process.env.REDIS_TLS = 'true';

  try {
    assert.throws(
      () => validateRedisConfiguration(),
      /REDIS_TLS\/REDIS_SSL is enabled but REDIS_URL uses rediss:\/\//i,
    );
  } finally {
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;

    if (originalTls === undefined) delete process.env.REDIS_TLS;
    else process.env.REDIS_TLS = originalTls;
  }
});

test('pm2 loads the project env file for all managed apps', () => {
  const apps = pm2Config.apps || [];

  assert.ok(apps.some((app) => app.name === 'myapp' && app.env_file === '.env'));
  assert.ok(apps.some((app) => app.name === 'myapp-bulk' && app.env_file === '.env'));
});

test('startBulkUploadWorker does not crash if Redis is not configured', () => {
  const queueModulePath = require.resolve('../lib/queue');
  const workerModulePath = require.resolve('../worker/bulkupload.worker');
  const originalQueueModule = require.cache[queueModulePath];

  const stubQueue = {
    connection: null,
    QUEUE_NAME: 'bulk-upload',
    ensureQueueConfigured: () => {
      throw new Error('REDIS_URL is not configured. Set it to a valid Redis endpoint before starting the bulk upload queue.');
    },
  };

  require.cache[queueModulePath] = { exports: stubQueue };
  delete require.cache[workerModulePath];

  try {
    const { startBulkUploadWorker } = require('../worker/bulkupload.worker');
    assert.equal(startBulkUploadWorker(), null);
  } finally {
    if (originalQueueModule) {
      require.cache[queueModulePath] = originalQueueModule;
    } else {
      delete require.cache[queueModulePath];
    }

    delete require.cache[workerModulePath];
  }
});
