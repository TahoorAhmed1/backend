const env = require("dotenv");
const path = require("path");
const http = require("http");
const os = require("os");
const cluster = require("cluster");
const { logger } = require("./configs/logger");

const envFile =
  process.env.NODE_ENV == "development"
    ? ".env.development"
    : process.env.NODE_ENV == "staging"
      ? ".env.staging"
      : process.env.NODE_ENV == "test"
        ? ".env.test"
        : ".env";

env.config({ path: path.resolve(__dirname, envFile), override: true });

const app = require("./app");

const port = process.env.PORT;
const workerCount = Number(process.env.WEB_CONCURRENCY) || os.cpus().length;

if (cluster.isPrimary) {
  logger.info(`primary process ${process.pid} starting ${workerCount} workers`);

  // PM2's `wait_ready` only listens for a "ready" IPC message from the
  // process it directly spawned (this primary). It has no visibility into
  // cluster.fork() children, so we must forward readiness ourselves once
  // at least one worker has actually bound to the port.
  let readySentToPM2 = false;

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

  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    forkWorker();
  }

  let consecutiveCrashes = 0;
  let lastCrashTime = 0;

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
        "too many worker crashes in a row; stopping automatic respawn to avoid PM2 restart loop",
      );
      return;
    }

    setTimeout(
      () => forkWorker(),
      Math.min(1000 * consecutiveCrashes, 10000),
    );
  });

  // Make sure a PM2 restart/reload/stop actually kills the cluster
  // children instead of leaving them running as orphans.
  const shutdown = (signal) => {
    logger.info(`primary process ${process.pid} received ${signal}, shutting down workers`);

    for (const id in cluster.workers) {
      cluster.workers[id].process.kill(signal);
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} else {
  const server = http.createServer(app);

  server.listen(port, () => {
    logger.info(`worker ${process.pid} listening on http://localhost:${port}
       Environment: ${process.env.NODE_ENV || "live"}
       Loaded Config from: ${envFile}
       TEST_VAR: ${process.env.TEST_VAR}`);


    if (process.send) {
      process.send("worker-ready");
    }
  });

  app.get("/", async (req, res) => {
    res.send("server is running");
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}