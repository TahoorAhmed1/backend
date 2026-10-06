const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JOB_ROUTING,
  normalizeRedisUrl,
  validateRedisConfiguration,
} = require('../lib/queue');
const pm2Config = require('../ecosystem.config.js');

test('normalizeRedisUrl keeps a valid redis scheme', () => {
  assert.equal(normalizeRedisUrl('redis://localhost:6379'), 'redis://localhost:6379');
});

test('normalizeRedisUrl adds a redis scheme when missing', () => {
  assert.equal(normalizeRedisUrl('localhost:6379'), 'redis://localhost:6379');
});

test('normalizeRedisUrl throws for blank values', () => {
  assert.throws(() => normalizeRedisUrl('   '), /Redis URL is not configured/i);
});

test('validateRedisConfiguration rejects plain redis:// with TLS enabled', () => {
  const originalJobType = process.env.BULK_JOB_TYPE;
  const originalUrl = process.env.REDIS_ACCOUNT_1_URL;
  const originalTls = process.env.REDIS_TLS;

  process.env.BULK_JOB_TYPE = 'BULK_UPLOAD';
  process.env.REDIS_ACCOUNT_1_URL = 'redis://localhost:6379';
  process.env.REDIS_TLS = 'true';

  try {
    assert.throws(
      () => validateRedisConfiguration('BULK_UPLOAD'),
      /TLS is enabled but REDIS_ACCOUNT_1_URL uses redis:\/\//i,
    );
  } finally {
    if (originalJobType === undefined) delete process.env.BULK_JOB_TYPE;
    else process.env.BULK_JOB_TYPE = originalJobType;

    if (originalUrl === undefined) delete process.env.REDIS_ACCOUNT_1_URL;
    else process.env.REDIS_ACCOUNT_1_URL = originalUrl;

    if (originalTls === undefined) delete process.env.REDIS_TLS;
    else process.env.REDIS_TLS = originalTls;
  }
});

test('validateRedisConfiguration never falls back to another account URL', () => {
  const originalAccount3Url = process.env.REDIS_ACCOUNT_3_URL;
  const originalAccount1Url = process.env.REDIS_ACCOUNT_1_URL;

  process.env.REDIS_ACCOUNT_1_URL = 'redis://localhost:6379';
  delete process.env.REDIS_ACCOUNT_3_URL;

  try {
    assert.throws(
      () => validateRedisConfiguration('RESYNC_PENDING_RIDES'),
      /REDIS_ACCOUNT_3_URL.*not configured/i,
    );
  } finally {
    if (originalAccount1Url === undefined) delete process.env.REDIS_ACCOUNT_1_URL;
    else process.env.REDIS_ACCOUNT_1_URL = originalAccount1Url;

    if (originalAccount3Url === undefined) delete process.env.REDIS_ACCOUNT_3_URL;
    else process.env.REDIS_ACCOUNT_3_URL = originalAccount3Url;
  }
});

test('job types have a fixed one-to-one Redis account mapping', () => {
  assert.deepEqual(JOB_ROUTING, {
    BULK_UPLOAD: {
      accountKey: 'account-1',
      redisVariable: 'REDIS_ACCOUNT_1_URL',
    },
    UPDATE_SCHEDULE: {
      accountKey: 'account-2',
      redisVariable: 'REDIS_ACCOUNT_2_URL',
    },
    RESYNC_PENDING_RIDES: {
      accountKey: 'account-3',
      redisVariable: 'REDIS_ACCOUNT_3_URL',
    },
  });
});

test('pm2 loads the project env file for all managed apps', () => {
  const apps = pm2Config.apps || [];

  assert.ok(apps.some((app) => app.name === 'myapp' && app.env_file === '.env'));
  const routing = {
    BULK_UPLOAD: 'account-1',
    UPDATE_SCHEDULE: 'account-2',
    RESYNC_PENDING_RIDES: 'account-3',
  };
  for (const [jobType, accountKey] of Object.entries(routing)) {
    const app = apps.find((candidate) => candidate.name === `myapp-bulk-${accountKey}`);
    assert.ok(app);
    assert.equal(app.exec_mode, 'fork');
    assert.equal(app.instances, 1);
    assert.equal(app.env.BULK_JOB_TYPE, jobType);
    assert.equal(app.env_production.BULK_JOB_TYPE, jobType);
  }
});

test('startBulkUploadWorker fails clearly if Redis is not configured', () => {
  const queueModulePath = require.resolve('../lib/queue');
  const workerModulePath = require.resolve('../worker/bulkupload.worker');
  const originalQueueModule = require.cache[queueModulePath];

  const stubQueue = {
    jobType: 'BULK_UPLOAD',
    accountKey: 'account-1',
    connection: null,
    QUEUE_NAME: 'account-1',
    QUEUE_PREFIX: 'bulk-upload',
    QUEUE_DISPLAY_NAME: 'bulk-upload:account-1',
    ensureQueueConfigured: () => {
      throw new Error('REDIS_ACCOUNT_1_URL is not configured for BULK_UPLOAD.');
    },
  };

  require.cache[queueModulePath] = { exports: stubQueue };
  delete require.cache[workerModulePath];

  try {
    const { startBulkUploadWorker } = require('../worker/bulkupload.worker');
    assert.throws(
      () => startBulkUploadWorker(),
      /REDIS_ACCOUNT_1_URL is not configured/i,
    );
  } finally {
    if (originalQueueModule) {
      require.cache[queueModulePath] = originalQueueModule;
    } else {
      delete require.cache[queueModulePath];
    }

    delete require.cache[workerModulePath];
  }
});
