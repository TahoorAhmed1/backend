const dotenv = require("dotenv");
const path = require("path");
const http = require("http");
const cluster = require("cluster");
const { logger } = require("./configs/logger");

const envFile =
  process.env.NODE_ENV === "development"
    ? ".env.development"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : process.env.NODE_ENV === "test"
        ? ".env.test"
        : ".env";

dotenv.config({
  path: path.resolve(__dirname, envFile),
  override: true,
});

const port = Number(process.env.PORT) || 8000;

// Keep the HTTP server app process single-worker by default so the
// BullMQ enqueue module does not open duplicate Redis sockets from
// every cluster worker process.
const configuredWorkerCount = Number(process.env.WEB_CONCURRENCY);

const workerCount =
  Number.isInteger(configuredWorkerCount) &&
  configuredWorkerCount > 0
    ? configuredWorkerCount
    : 1;

if (cluster.isPrimary) {
  logger.info(
    `primary process ${process.pid} starting ${workerCount} workers`,
  );

  let readySentToPM2 = false;
  let consecutiveCrashes = 0;
  let lastCrashTime = 0;

  const forkWorker = () => {
    const worker = cluster.fork();

    worker.on("message", (msg) => {
      if (msg === "worker-ready" && !readySentToPM2) {
        readySentToPM2 = true;

        if (process.send) {
          process.send("ready");
        }
      }
    });

    return worker;
  };

  for (let i = 0; i < workerCount; i += 1) {
    forkWorker();
  }

  cluster.on("exit", (worker, code, signal) => {
    logger.error(
      `worker ${worker.process.pid} exited (${signal || code})`,
    );

    const now = Date.now();

    if (now - lastCrashTime < 5000) {
      consecutiveCrashes += 1;
    } else {
      consecutiveCrashes = 1;
    }

    lastCrashTime = now;

    if (consecutiveCrashes > 5) {
      logger.error(
        "too many worker crashes in a row; stopping automatic respawn",
      );
      return;
    }

    setTimeout(() => {
      forkWorker();
    }, Math.min(1000 * consecutiveCrashes, 10000));
  });

  const shutdown = (signal) => {
    logger.info(
      `primary process ${process.pid} received ${signal}, shutting down workers`,
    );

    for (const id in cluster.workers) {
      const worker = cluster.workers[id];

      if (worker) {
        worker.process.kill(signal);
      }
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} else {
  // Load app only inside cluster workers.
  // This prevents the primary process from initializing
  // Redis/DB connections through app imports.
  const app = require("./app");

  const server = http.createServer(app);

  server.listen(port, () => {
    logger.info(
      `worker ${process.pid} listening on http://localhost:${port}`,
    );

    logger.info(
      `Environment: ${process.env.NODE_ENV || "live"}`,
    );

    logger.info(
      `Loaded Config from: ${envFile}`,
    );

    if (process.env.TEST_VAR) {
      logger.info(
        `TEST_VAR: ${process.env.TEST_VAR}`,
      );
    }

    if (process.send) {
      process.send("worker-ready");
    }
  });

  app.get("/", (req, res) => {
    res.send("server is running");
  });

  const shutdownWorker = (signal) => {
    logger.info(
      `worker ${process.pid} received ${signal}`,
    );

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(0);
    }, 10000).unref();
  };

  process.on("SIGTERM", () => shutdownWorker("SIGTERM"));
  process.on("SIGINT", () => shutdownWorker("SIGINT"));
}