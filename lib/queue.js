const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const QUEUE_NAME = "bulk-upload";

const normalizeRedisUrl = (url) => {
  if (!url || !url.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint.",
    );
  }

  const trimmed = url.trim();

  if (
    /^redis:\/\//i.test(trimmed) ||
    /^rediss:\/\//i.test(trimmed)
  ) {
    return trimmed;
  }

  return `redis://${trimmed}`;
};

const validateRedisConfiguration = () => {
  const rawUrl = process.env.REDIS_URL;

  if (!rawUrl || !rawUrl.trim()) {
    throw new Error(
      "REDIS_URL is not configured. Set it to a valid Redis endpoint.",
    );
  }

  const normalizedUrl = normalizeRedisUrl(rawUrl);

  const tlsEnabled =
    process.env.REDIS_TLS === "true" ||
    process.env.REDIS_SSL === "true";

  const usesTls = /^rediss:\/\//i.test(normalizedUrl);

  if (tlsEnabled !== usesTls) {
    throw new Error(
      `Redis TLS mismatch. REDIS_URL uses ${
        usesTls ? "rediss://" : "redis://"
      }, while TLS is ${tlsEnabled ? "enabled" : "disabled"}.`,
    );
  }

  return normalizedUrl;
};

let redisUrl = null;

try {
  redisUrl = validateRedisConfiguration();

  console.log("[redis] configuration loaded", {
    protocol: redisUrl.startsWith("rediss://") ? "rediss" : "redis",
    tls: redisUrl.startsWith("rediss://"),
  });
} catch (error) {
  console.error("[redis] configuration error:", error.message);
}

const useTls =
  Boolean(redisUrl) && /^rediss:\/\//i.test(redisUrl);

const connection = redisUrl
  ? new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
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
      "Redis connection is not available. Check REDIS_URL and Redis TLS configuration.",
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