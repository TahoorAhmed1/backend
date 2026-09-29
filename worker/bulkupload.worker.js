const fs = require("fs/promises");
const XLSX = require("xlsx");
const { Worker } = require("bullmq");

const { prisma } = require("../lib/prisma");

const {
  connection,
  QUEUE_NAME,
  bulkUploadQueue,
  ensureQueueConfigured,
} = require("../lib/queue");

const {
  processBulkUploadJob,
  processUpdateScheduleJob,
} = require("../services/bulkUpload.service");

const {
  syncPendingRidesForWeek,
} = require("../lib/rideplaing");

const configuredDispatchInterval = Number(
  process.env.BULK_QUEUE_DISPATCH_INTERVAL_MS || 2000,
);
const DISPATCH_INTERVAL_MS =
  Number.isFinite(configuredDispatchInterval) &&
  configuredDispatchInterval >= 500
    ? configuredDispatchInterval
    : 2000;
const RECONCILE_INTERVAL_MS = 30000;
const LIVE_QUEUE_STATES = new Set([
  "active",
  "delayed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children",
]);

const startBulkUploadWorker = () => {
  ensureQueueConfigured();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "resync-pending-rides") {
        try {
          const { weekStartDate } = job.data;
          console.log(
            `[bulkUpload.worker] picked up ride resync job ${job.id}`,
          );

          await syncPendingRidesForWeek(new Date(weekStartDate));
          await prisma.bulkUploadJob.update({
            where: { id: job.id },
            data: { status: "completed", completedAt: new Date() },
          });

          console.log(
            `[bulkUpload.worker] ride resync job ${job.id} completed`,
          );
        } catch (error) {
          await prisma.bulkUploadJob.update({
            where: { id: job.id },
            data: {
              status: "failed",
              error: error.message,
              completedAt: new Date(),
            },
          });
          throw error;
        }
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
        employeeCodeFilterCount:
          employeeCodeFilter?.length || 0,
      });

      try {
        const workbook = XLSX.readFile(filePath);

        let results;

        if (action === "UPDATE_SCHEDULE") {
          results = await processUpdateScheduleJob(
            jobId,
            workbook,
            new Date(weekStartDate),
            batchSize,
          );
        } else {
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

        console.log(
          `[bulkUpload.worker] job ${jobId} completed`,
        );
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
      lockDuration: 5 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 1,
    },
  );

  let queuePollInProgress = false;
  let lastReconcileAt = 0;
  const pollQueue = async () => {
    if (queuePollInProgress) return;
    queuePollInProgress = true;

    try {
      const pendingJobs = await prisma.bulkUploadJob.findMany({
        where: { status: "processing", dispatchedAt: null },
        orderBy: { createdAt: "asc" },
        take: 10,
      });

      for (const pendingJob of pendingJobs) {
        try {
          if (pendingJob.jobType === "RESYNC_PENDING_RIDES") {
            await bulkUploadQueue.add(
              "resync-pending-rides",
              {
                jobId: pendingJob.id,
                weekStartDate: pendingJob.weekStart.toISOString(),
              },
              {
                jobId: pendingJob.id,
                removeOnComplete: true,
                removeOnFail: true,
              },
            );
          } else {
            if (!pendingJob.filePath) {
              throw new Error("Bulk upload job is missing its file path.");
            }

            await bulkUploadQueue.add(
              "process",
              {
                jobId: pendingJob.id,
                filePath: pendingJob.filePath,
                weekStartDate: pendingJob.weekStart.toISOString(),
                batchSize: pendingJob.batchSize,
                action: pendingJob.action,
                employeeCodeFilter: pendingJob.employeeCodeFilter || [],
              },
              { jobId: pendingJob.id },
            );
          }

          await prisma.bulkUploadJob.updateMany({
            where: {
              id: pendingJob.id,
              status: "processing",
              dispatchedAt: null,
            },
            data: { dispatchedAt: new Date() },
          });
        } catch (error) {
          if (error.message === "Bulk upload job is missing its file path.") {
            await prisma.bulkUploadJob.update({
              where: { id: pendingJob.id },
              data: {
                status: "failed",
                error: error.message,
                completedAt: new Date(),
              },
            });
          } else {
            console.error(
              `[bulkUpload.worker] dispatch failed for job ${pendingJob.id}:`,
              error.message,
            );
          }
        }
      }

      if (Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
        lastReconcileAt = Date.now();
        const dispatchedJobs = await prisma.bulkUploadJob.findMany({
          where: { status: "processing", dispatchedAt: { not: null } },
          orderBy: { updatedAt: "asc" },
          take: 100,
        });

        for (const pendingJob of dispatchedJobs) {
          const queueJob = await bulkUploadQueue.getJob(pendingJob.id);
          const state = queueJob ? await queueJob.getState() : "missing";

          if (LIVE_QUEUE_STATES.has(state)) continue;

          const completed = state === "completed";
          const data = {
            status: completed ? "completed" : "failed",
            error: completed
              ? null
              : queueJob?.failedReason ||
                `Queue job ${state} before the database status was updated.`,
            completedAt: queueJob?.finishedOn
              ? new Date(queueJob.finishedOn)
              : new Date(),
          };

          if (completed && queueJob.returnvalue !== undefined) {
            data.result = queueJob.returnvalue;
          }

          await prisma.bulkUploadJob.updateMany({
            where: { id: pendingJob.id, status: "processing" },
            data,
          });
        }
      }
    } catch (error) {
      console.error("[bulkUpload.worker] queue polling failed:", error.message);
    } finally {
      queuePollInProgress = false;
    }
  };

  const queuePollTimer = setInterval(pollQueue, DISPATCH_INTERVAL_MS);
  queuePollTimer.unref();
  pollQueue();

  const shutdown = async () => {
    console.log("[bulkUpload.worker] shutting down...");
    clearInterval(queuePollTimer);

    try {
      await worker.close();
      await bulkUploadQueue.close();
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
    console.error(
      "[bulkUpload.worker] worker error:",
      error,
    );
  });

  worker.on("stalled", (jobId) => console.warn("stalled", jobId));
  worker.on("failed", (job, error) =>
    console.error("failed", job?.id, error.message),
  );

  process.on("unhandledRejection", (error) => console.error(error));
  process.on("uncaughtException", (error) => {
    console.error(error);
    process.exit(1);
  });

  return worker;
};

module.exports = {
  startBulkUploadWorker,
};