const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const QUEUE_NAME = "bulk-upload";

const isRedisUrl = (url) => /^redis:\/\//i.test(url);
const isRedissUrl = (url) => /^rediss:\/\//i.test(url);

const normalizeRedisUrl = (url) => {
  if (!url || !url.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint.",
    );
  }

  let normalized = url.trim();

  // Add scheme when only host:port is supplied.
  if (!isRedisUrl(normalized) && !isRedissUrl(normalized)) {
    normalized = `redis://${normalized}`;
  }

  const tlsEnabled =
    process.env.REDIS_TLS === "true" ||
    process.env.REDIS_SSL === "true";

  // Automatically use rediss:// when TLS is enabled.
  if (tlsEnabled && isRedisUrl(normalized)) {
    normalized = normalized.replace(/^redis:\/\//i, "rediss://");
  }

  return normalized;
};

const validateRedisConfiguration = () => {
  const rawUrl = process.env.REDIS_URL;

  if (!rawUrl || !rawUrl.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint.",
    );
  }

  const normalized = normalizeRedisUrl(rawUrl);

  return normalized;
};

let redisUrl = null;

try {
  redisUrl = validateRedisConfiguration();

  console.log("[redis] configuration loaded", {
    urlConfigured: true,
    protocol: redisUrl.startsWith("rediss://")
      ? "rediss"
      : "redis",
    tlsEnabled:
      process.env.REDIS_TLS === "true" ||
      process.env.REDIS_SSL === "true",
  });
} catch (error) {
  console.error("[redis] configuration error:", error.message);
}

const useTls =
  Boolean(redisUrl) &&
  (
    process.env.REDIS_TLS === "true" ||
    process.env.REDIS_SSL === "true" ||
    isRedissUrl(redisUrl)
  );

const connection = redisUrl
  ? new IORedis(redisUrl, {
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,

      // Required by BullMQ.
      maxRetriesPerRequest: null,

      // Keep commands queued during temporary disconnects.
      enableOfflineQueue: true,

      connectTimeout: Number(
        process.env.REDIS_CONNECT_TIMEOUT_MS || 15000,
      ),

      lazyConnect: false,

      retryStrategy(times) {
        const delay = Math.min(times * 1000, 30000);

        console.warn(
          `[redis] reconnect attempt ${times}, retrying in ${delay}ms`,
        );

        return delay;
      },

      reconnectOnError(error) {
        const message = error?.message || "";

        if (
          message.includes("READONLY") ||
          message.includes("ECONNRESET") ||
          message.includes("ETIMEDOUT") ||
          message.includes("EAI_AGAIN") ||
          message.includes("ENOTFOUND")
        ) {
          return 2;
        }

        return false;
      },

      ...(useTls
        ? {
            tls: {
              rejectUnauthorized:
                process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false",
            },
          }
        : {}),
    })
  : null;

if (connection) {
  connection.on("connect", () => {
    console.log("[redis] connecting...");
  });

  connection.on("ready", () => {
    console.log("[redis] connection ready");
  });

  connection.on("reconnecting", (delay) => {
    console.warn(`[redis] reconnecting in ${delay}ms`);
  });

  connection.on("error", (error) => {
    console.error("[redis] connection error:", {
      code: error?.code,
      message: error?.message,
    });
  });

  connection.on("close", () => {
    console.warn("[redis] connection closed");
  });
}

const bulkUploadQueue = connection
  ? new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 200,
      },
    })
  : null;

const ensureQueueConfigured = () => {
  if (!bulkUploadQueue || !connection) {
    throw new Error(
      "Redis connection is not available. Check REDIS_URL, Redis credentials, TLS settings, and network connectivity.",
    );
  }

  return bulkUploadQueue;
};

module.exports = {
  bulkUploadQueue,
  connection,
  QUEUE_NAME,
  normalizeRedisUrl,
  validateRedisConfiguration,
  ensureQueueConfigured,
  redisUrl,
};