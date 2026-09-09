const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const QUEUE_NAME = "bulk-upload";

const normalizeRedisUrl = (url) => {
  if (!url || !url.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint, e.g. redis://localhost:6379 or rediss://:password@host:6379.",
    );
  }

  const trimmed = url.trim();
  return /^redis(s)?:\/\//i.test(trimmed) ? trimmed : `redis://${trimmed}`;
};

const redisUrl = normalizeRedisUrl(process.env.REDIS_URL);
const useTls =
  process.env.REDIS_TLS === "true" ||
  /^rediss:\/\//i.test(redisUrl) ||
  process.env.REDIS_SSL === "true";

const connection = new IORedis(redisUrl, {
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 15000),
  lazyConnect: false,
  ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
});

connection.on("error", (error) => {
  console.error(
    "[redis] connection error. Check REDIS_URL, REDIS_PASSWORD, and whether TLS is required:",
    error,
  );
});

const bulkUploadQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

module.exports = { bulkUploadQueue, connection, QUEUE_NAME };
