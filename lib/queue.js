const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const QUEUE_NAME = "bulk-upload";

const normalizeRedisUrl = (url) => {
  if (!url || !url.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint."
    );
  }

  const trimmed = url.trim();

  return /^rediss?:\/\//i.test(trimmed)
    ? trimmed
    : `redis://${trimmed}`;
};

const validateRedisConfiguration = () => {
  const rawUrl = process.env.REDIS_URL;
  const tlsEnabled =
    process.env.REDIS_TLS === "true" || process.env.REDIS_SSL === "true";

  if (!rawUrl || !rawUrl.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint."
    );
  }

  const normalized = normalizeRedisUrl(rawUrl);

  if (
    tlsEnabled &&
    /^redis:\/\//i.test(normalized) &&
    !/^rediss:\/\//i.test(normalized)
  ) {
    throw new Error(
      "REDIS_TLS/REDIS_SSL is enabled but REDIS_URL uses redis://. Use rediss:// or disable REDIS_TLS/REDIS_SSL."
    );
  }

  return normalized;
};

const redisUrl = (() => {
  try {
    return validateRedisConfiguration();
  } catch (error) {
    console.warn("[redis] configuration error:", error.message);
    return null;
  }
})();

const useTls =
  Boolean(redisUrl) &&
  (process.env.REDIS_TLS === "true" ||
    /^rediss:\/\//i.test(redisUrl) ||
    process.env.REDIS_SSL === "true");

const connection = redisUrl
  ? new IORedis(redisUrl, {
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,

      // Required/recommended for BullMQ workers
      maxRetriesPerRequest: null,

      // Keep commands queued while Redis reconnects
      enableOfflineQueue: true,

      // Don't fail immediately on temporary Redis/DNS issues
      connectTimeout: Number(
        process.env.REDIS_CONNECT_TIMEOUT_MS || 15000
      ),

      lazyConnect: false,

      // Automatic reconnect with exponential backoff
      retryStrategy(times) {
        const delay = Math.min(times * 1000, 30000);

        console.warn(
          `[redis] reconnect attempt ${times}, retrying in ${delay}ms`
        );

        return delay;
      },

      // Retry connection on common Redis/network errors
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
  if (!bulkUploadQueue) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint before starting the bulk upload queue."
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