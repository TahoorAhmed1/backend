const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const QUEUE_PREFIX = "bulk-upload";
const JOB_ROUTING = {
  BULK_UPLOAD: {
    accountKey: "account-1",
    redisVariable: "REDIS_ACCOUNT_1_URL",
  },
  UPDATE_SCHEDULE: {
    accountKey: "account-2",
    redisVariable: "REDIS_ACCOUNT_2_URL",
  },
  RESYNC_PENDING_RIDES: {
    accountKey: "account-3",
    redisVariable: "REDIS_ACCOUNT_3_URL",
  },
};

const normalizeRedisUrl = (url, jobType) => {
  if (!url || !url.trim()) {
    const variableName = JOB_ROUTING[jobType]?.redisVariable;
    throw new Error(
      `${variableName || "Redis URL"} is not configured for ${jobType || "the selected job type"}.`,
    );
  }

  const trimmed = url.trim();

  if (/^redis:\/\//i.test(trimmed) || /^rediss:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `redis://${trimmed}`;
};

const validateRedisConfiguration = (
  jobType = process.env.BULK_JOB_TYPE,
) => {
  const routing = JOB_ROUTING[jobType];
  if (!routing) {
    throw new Error(
      "BULK_JOB_TYPE must be BULK_UPLOAD, UPDATE_SCHEDULE, or RESYNC_PENDING_RIDES.",
    );
  }

  const normalizedUrl = normalizeRedisUrl(
    process.env[routing.redisVariable],
    jobType,
  );

  const tlsEnabled =
    process.env.REDIS_TLS === "true" ||
    process.env.REDIS_SSL === "true";
  const usesTls = /^rediss:\/\//i.test(normalizedUrl);

  if (tlsEnabled && !usesTls) {
    throw new Error(
      `TLS is enabled but ${routing.redisVariable} uses redis://. Configure it to use rediss:// or disable TLS.`,
    );
  }

  if (!tlsEnabled && usesTls) {
    throw new Error(
      `TLS is disabled but ${routing.redisVariable} uses rediss://. Enable REDIS_TLS or REDIS_SSL.`,
    );
  }

  return normalizedUrl;
};

const jobType = process.env.BULK_JOB_TYPE;
const routing = JOB_ROUTING[jobType] || null;
const accountKey = routing?.accountKey || null;
const QUEUE_NAME = routing ? accountKey : null;
const QUEUE_DISPLAY_NAME = QUEUE_NAME
  ? `${QUEUE_PREFIX}:${QUEUE_NAME}`
  : null;
let redisUrl = null;
let connection = null;
let bulkUploadQueue = null;

if (routing && process.env[routing.redisVariable]?.trim()) {
  redisUrl = validateRedisConfiguration(jobType);
  const useTls = /^rediss:\/\//i.test(redisUrl);

  connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 15000),
    lazyConnect: false,

    retryStrategy(times) {
      const delay = Math.min(times * 1000, 30000);
      console.warn(
        `[redis:${jobType}] reconnect attempt ${times}, retrying in ${delay}ms`,
      );
      return delay;
    },

    ...(useTls
      ? {
          tls: {
            rejectUnauthorized:
              process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false",
          },
        }
      : {}),
  });

  connection.on("connect", () => {
    console.log(`[redis:${jobType}] connecting`);
  });

  connection.on("ready", () => {
    console.log(`[redis:${jobType}] connection ready`);
  });

  connection.on("reconnecting", (delay) => {
    console.warn(`[redis:${jobType}] reconnecting in ${delay}ms`);
  });

  connection.on("error", (error) => {
    console.error(`[redis:${jobType}] connection error`, {
      code: error?.code,
    });
  });

  connection.on("close", () => {
    console.warn(`[redis:${jobType}] connection closed`);
  });

  bulkUploadQueue = new Queue(QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 200,
    },
  });
}

const ensureQueueConfigured = () => {
  if (!connection || !bulkUploadQueue) {
    validateRedisConfiguration(jobType);
    throw new Error(
      `Redis queue for ${jobType} could not be initialized.`,
    );
  }

  return bulkUploadQueue;
};

module.exports = {
  JOB_ROUTING,
  jobType,
  QUEUE_PREFIX,
  QUEUE_NAME,
  QUEUE_DISPLAY_NAME,
  accountKey,
  bulkUploadQueue,
  connection,
  ensureQueueConfigured,
  normalizeRedisUrl,
  redisUrl,
  validateRedisConfiguration,
};
