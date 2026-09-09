// Start this once when your app boots (e.g. required from server.js after
// the DB connects). It can run in the same process as your web server, or
// later as its own `node workers/bulkUpload.worker.js` process for extra
// isolation - no other code changes needed either way.

const fs = require("fs/promises");
const XLSX = require("xlsx");
const { Worker } = require("bullmq");
const { prisma } = require("../lib/prisma");
const { connection, QUEUE_NAME } = require("../lib/queue");
const { processBulkUploadJob } = require("../services/bulkUpload.service");
const { syncPendingRidesForWeek } = require("../lib/rideplaing");

const startBulkUploadWorker = () => {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "resync-pending-rides") {
        const { weekStartDate } = job.data;
        console.log(`[bulkUpload.worker] picked up ride resync job ${job.id}`);
        await syncPendingRidesForWeek(new Date(weekStartDate));
        console.log(`[bulkUpload.worker] ride resync job ${job.id} completed`);
        return;
      }

      const { jobId, filePath, weekStartDate, batchSize } = job.data;

      console.log(`[bulkUpload.worker] picked up job ${jobId}`);

      try {
        const workbook = XLSX.readFile(filePath);

        const results = await processBulkUploadJob(
          jobId,
          workbook,
          new Date(weekStartDate),
          batchSize,
        );

        await prisma.bulkUploadJob.update({
          where: { id: jobId },
          data: {
            status: "completed",
            result: results,
            completedAt: new Date(),
          },
        });

        await fs.unlink(filePath).catch(() => {});

        console.log(`[bulkUpload.worker] job ${jobId} completed`);
      } catch (error) {
        console.error(`[bulkUpload.worker] job ${jobId} failed:`, error);

        await prisma.bulkUploadJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            error: error.message,
            completedAt: new Date(),
          },
        });

        // Re-throw so BullMQ records the failure and applies retry/backoff
        // instead of silently swallowing it.
        throw error;
      }
    },
    {
      connection,
      concurrency: 1, // one bulk upload at a time, matching the old intent
    },
  );

  const shutdown = async () => {
    try {
      await worker.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  worker.on("ready", () => {
    console.log("[bulkUpload.worker] listening for jobs");
  });

  worker.on("error", (error) => {
    console.error("[bulkUpload.worker] worker error:", error);
  });

  return worker;
};

module.exports = { startBulkUploadWorker };