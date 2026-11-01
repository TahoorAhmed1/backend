const { genericResponse } = require("../constants/responses");
const { consumeLocationRateLimit } = require("../services/location/location.service");

const locationRateLimit = (actorKey) => async (req, res, next) => {
  const userId = req.user?.userId;
  if (!userId) {
    const response = genericResponse(401, false, null, "Authenticated user is required.");
    return res.status(response.status.code).json(response);
  }

  try {
    const result = await consumeLocationRateLimit(actorKey, userId);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      const response = genericResponse(429, false, null, "Location update rate limit exceeded.");
      return res.status(response.status.code).json(response);
    }

    next();
  } catch (error) {
    console.error("[location.rateLimit] Redis check failed:", error.message);
    const response = genericResponse(503, false, null, "Location tracking is temporarily unavailable.");
    return res.status(response.status.code).json(response);
  }
};

const locationRequestMetrics = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (durationMs >= 1_000) {
      console.warn("[location.api] slow request:", {
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    }
  });
  next();
};

module.exports = { locationRateLimit, locationRequestMetrics };
