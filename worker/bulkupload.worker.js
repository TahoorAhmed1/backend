
const dotenv = require("dotenv");
const path = require("path");

if (process.env.NODE_ENV !== "production") {
  const envFile =
    process.env.NODE_ENV === "development"
      ? ".env.development"
      : process.env.NODE_ENV === "staging"
        ? ".env.staging"
        : process.env.NODE_ENV === "test"
          ? ".env.test"
          : ".env";

  dotenv.config({
    path: path.resolve(__dirname, "..", envFile),
    override: false,
  });
}

const fs = require("fs/promises");
const XLSX = require("xlsx");
const { Worker } = require("bullmq");
const { prisma } = require("../lib/prisma");
const {
  connection,
  QUEUE_NAME,
  ensureQueueConfigured,
} = require("../lib/queue");
const {
  processBulkUploadJob,
  processUpdateScheduleJob,
} = require("../services/bulkUpload.service");
const { syncPendingRidesForWeek } = require("../lib/rideplaing");

const startBulkUploadWorker = () => {
  console.log("[bulkUpload.worker] starting...", {
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL ? "SET" : "MISSING",
    REDIS_TLS: process.env.REDIS_TLS,
    REDIS_SSL: process.env.REDIS_SSL,
  });

  try {
    ensureQueueConfigured();
  } catch (error) {
    console.error(
      "[bulkUpload.worker] Redis configuration error:",
      error.message,
    );

    // Do not silently disable the production worker.
    if (process.env.NODE_ENV === "production") {
      throw error;
    }

    console.warn(
      "[bulkUpload.worker] Worker disabled because Redis is not configured.",
    );

    return null;
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "resync-pending-rides") {
        const { weekStartDate } = job.data;

        console.log(
          `[bulkUpload.worker] picked up ride resync job ${job.id}`,
        );

        await syncPendingRidesForWeek(new Date(weekStartDate));

        console.log(
          `[bulkUpload.worker] ride resync job ${job.id} completed`,
        );

        return;
      }

      const {
        jobId,
        filePath,
        weekStartDate,
        batchSize,
        employeeCodeFilter,
        action,
      } = job.data;

      console.log(`[bulkUpload.worker] picked up job ${jobId}`, {
        action: action || "BULK_UPLOAD",
        filePath,
        weekStartDate,
        batchSize,
        employeeCodeFilterCount: employeeCodeFilter?.length || 0,
      });

      try {
        const workbook = XLSX.readFile(filePath);

        let results;

        if (action === "UPDATE_SCHEDULE") {
          console.log(
            `[bulkUpload.worker] dispatching UPDATE_SCHEDULE branch`,
            {
              jobId,
              filePath,
              employeeCodeFilterCount:
                employeeCodeFilter?.length || 0,
            },
          );

          results = await processUpdateScheduleJob(
            jobId,
            workbook,
            new Date(weekStartDate),
            batchSize,
          );
        } else {
          console.log(
            `[bulkUpload.worker] dispatching BULK_UPLOAD branch`,
            {
              jobId,
              filePath,
            },
          );

          results = await processBulkUploadJob(
            jobId,
            workbook,
            new Date(weekStartDate),
            batchSize,
            employeeCodeFilter,
          );
        }

        await prisma.bulkUploadJob.update({
          where: { id: jobId },
          data: {
            status: "completed",
            result: results,
            completedAt: new Date(),
          },
        });

        await fs.unlink(filePath).catch(() => {});

        console.log(`[bulkUpload.worker] job ${jobId} completed`, {
          action: action || "BULK_UPLOAD",
        });
      } catch (error) {
        console.error(
          `[bulkUpload.worker] job ${jobId} failed:`,
          error,
        );

        await prisma.bulkUploadJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            error: error.message,
            completedAt: new Date(),
          },
        });

        throw error;
      }
    },
    {
      connection,
      concurrency: 1,
    },
  );

  const shutdown = async () => {
    console.log("[bulkUpload.worker] shutting down...");

    try {
      await worker.close();
    } catch (error) {
      console.error(
        "[bulkUpload.worker] shutdown error:",
        error,
      );
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  worker.on("ready", () => {
    console.log("[bulkUpload.worker] listening for jobs");
  });

  worker.on("error", (error) => {
    console.error("[bulkUpload.worker] worker error:", error);
  });

  return worker;
};

module.exports = {
  startBulkUploadWorker,
};