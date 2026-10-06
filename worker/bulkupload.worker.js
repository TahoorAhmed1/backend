const fs = require("fs/promises");
const XLSX = require("xlsx");
const { Worker } = require("bullmq");

const { prisma } = require("../lib/prisma");

const {
  jobType,
  accountKey,
  connection,
  QUEUE_NAME,
  QUEUE_PREFIX,
  QUEUE_DISPLAY_NAME,
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

const dispatchSelector = {
  BULK_UPLOAD: {
    jobType: "BULK_UPLOAD",
    action: "BULK_UPLOAD",
  },
  UPDATE_SCHEDULE: {
    jobType: "BULK_UPLOAD",
    action: "UPDATE_SCHEDULE",
  },
  RESYNC_PENDING_RIDES: {
    jobType: "RESYNC_PENDING_RIDES",
  },
}[jobType];

const startBulkUploadWorker = () => {
  ensureQueueConfigured();

  console.log("[bulkUpload.worker] starting", {
    accountKey,
    queueName: QUEUE_DISPLAY_NAME,
  });

  /**
   * ============================================================
   * BULLMQ WORKER
   * ============================================================
   */

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const expectedJobName = {
        BULK_UPLOAD: "bulk-upload",
        UPDATE_SCHEDULE: "update-schedule",
        RESYNC_PENDING_RIDES: "resync-pending-rides",
      }[jobType];

      if (job.name !== expectedJobName) {
        throw new Error(
          `Unexpected job name ${job.name} on ${QUEUE_DISPLAY_NAME}.`,
        );
      }

      console.log("[bulkUpload.worker] RECEIVED JOB", {
        bullJobId: job.id,
        name: job.name,
        data: job.data,
      });

      /**
       * --------------------------------------------------------
       * PENDING RIDE RESYNC
       * --------------------------------------------------------
       */

      if (job.name === "resync-pending-rides") {
        const { jobId, weekStartDate } = job.data;

        if (!jobId) {
          throw new Error(
            "Resync job is missing jobId.",
          );
        }

        if (!weekStartDate) {
          throw new Error(
            "Resync job is missing weekStartDate.",
          );
        }

        console.log(
          `[bulkUpload.worker] picked up ride resync job ${jobId}`,
          {
            bullJobId: job.id,
            jobId,
            weekStartDate,
          },
        );

        try {
          /**
           * The dispatcher normally changes the DB record to
           * "processing", but we also do it here as a safety net.
           *
           * IMPORTANT:
           * Use jobId, NOT BullMQ job.id.
           */
          await prisma.bulkUploadJob.updateMany({
            where: {
              id: jobId,
              status: {
                in: ["pending", "processing"],
              },
            },
            data: {
              status: "processing",
              startedAt: new Date(),
            },
          });

          await syncPendingRidesForWeek(
            new Date(weekStartDate),
          );

          await prisma.bulkUploadJob.update({
            where: {
              id: jobId,
            },
            data: {
              status: "completed",
              completedAt: new Date(),
              error: null,
            },
          });

          console.log(
            `[bulkUpload.worker] ride resync job ${jobId} completed`,
          );
        } catch (error) {
          console.error(
            `[bulkUpload.worker] ride resync job ${jobId} failed:`,
            { name: error?.name, code: error?.code },
          );

          /**
           * Do not hide the original processing error if the DB
           * connection itself is temporarily unavailable.
           */
          try {
            await prisma.bulkUploadJob.update({
              where: {
                id: jobId,
              },
              data: {
                status: "failed",
                error: error?.message || String(error),
                completedAt: new Date(),
              },
            });
          } catch (statusError) {
            console.error(
              `[bulkUpload.worker] failed to persist failed status for ride resync job ${jobId}:`,
              { name: statusError?.name, code: statusError?.code },
            );
          }

          throw error;
        }

        return;
      }

      /**
       * --------------------------------------------------------
       * NORMAL BULK UPLOAD / UPDATE SCHEDULE
       * --------------------------------------------------------
       */

      const {
        jobId,
        filePath,
        weekStartDate,
        batchSize,
        employeeCodeFilter,
        action,
      } = job.data;

      if (job.name !== "bulk-upload" && job.name !== "update-schedule") {
        throw new Error(`Unsupported BullMQ job name: ${job.name}`);
      }

      if (!jobId) {
        throw new Error(`${job.name} job is missing jobId.`);
      }

      console.log(
        `[bulkUpload.worker] picked up job ${jobId}`,
        {
          action: action || "BULK_UPLOAD",
          filePath,
          weekStartDate,
          batchSize,
          employeeCodeFilterCount:
            employeeCodeFilter?.length || 0,
        },
      );

      let terminalStatusPersisted = false;

      try {
        /**
         * Mark DB job as processing.
         */
        await prisma.bulkUploadJob.updateMany({
          where: {
            id: jobId,
            status: {
              in: ["pending", "processing"],
            },
          },
          data: {
            status: "processing",
            startedAt: new Date(),
          },
        });

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
          where: {
            id: jobId,
          },
          data: {
            status: "completed",
            result: results,
            completedAt: new Date(),
            error: null,
          },
        });

        terminalStatusPersisted = true;

        console.log(
          `[bulkUpload.worker] job ${jobId} completed`,
        );
      } catch (error) {
        console.error(
          `[bulkUpload.worker] job ${jobId} failed:`,
          { name: error?.name, code: error?.code },
        );

        try {
          await prisma.bulkUploadJob.update({
            where: {
              id: jobId,
            },
            data: {
              status: "failed",
              error: error?.message || String(error),
              completedAt: new Date(),
            },
          });

          terminalStatusPersisted = true;
        } catch (statusError) {
          console.error(
            `[bulkUpload.worker] failed to persist failed status for job ${jobId}:`,
            { name: statusError?.name, code: statusError?.code },
          );
        }

        throw error;
      } finally {
        if (terminalStatusPersisted && filePath) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    },
    {
      connection,
      prefix: QUEUE_PREFIX,

      /**
       * Keep this at 4 for now.
       *
       * Do not increase it until PostgreSQL connection stability
       * has been confirmed.
       */
      concurrency: 4,

      lockDuration: 5 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 1,
    },
  );

  /**
   * ============================================================
   * DATABASE -> BULLMQ DISPATCHER
   * ============================================================
   */

  let queuePollInProgress = false;
  let lastReconcileAt = 0;

  const pollQueue = async () => {
    /**
     * Prevent overlapping polling cycles.
     */
    if (queuePollInProgress) {
      return;
    }

    queuePollInProgress = true;

    try {
      /**
       * New jobs are created as "pending".
       */
      const pendingJobs = await prisma.bulkUploadJob.findMany({
        where: {
          ...dispatchSelector,
          status: "pending",
          dispatchedAt: null,
        },
        orderBy: {
          createdAt: "asc",
        },
        take: 10,
      });

      if (pendingJobs.length > 0) {
        console.log(
          `[bulkUpload.worker] found ${pendingJobs.length} pending job(s)`,
          pendingJobs.map((job) => ({
            id: job.id,
            jobType: job.jobType,
            status: job.status,
          })),
        );
      }

      for (const pendingJob of pendingJobs) {
        try {
          console.log(
            `[bulkUpload.worker] dispatching job ${pendingJob.id}`,
            {
              jobType: pendingJob.jobType,
            },
          );

          /**
           * ------------------------------------------------------
           * RESYNC PENDING RIDES
           * ------------------------------------------------------
           */

          if (
            pendingJob.jobType ===
            "RESYNC_PENDING_RIDES"
          ) {
            const addedJob =
              await bulkUploadQueue.add(
                "resync-pending-rides",
                {
                  /**
                   * IMPORTANT:
                   * Explicit DB job ID.
                   */
                  jobId: pendingJob.id,

                  weekStartDate:
                    pendingJob.weekStart.toISOString(),
                },
                {
                  jobId: pendingJob.id,
                  removeOnComplete: true,
                  removeOnFail: true,
                },
              );

            console.log(
              "[bulkUpload.worker] RESYNC QUEUED",
              {
                dbJobId: pendingJob.id,
                bullJobId: addedJob.id,
                name: addedJob.name,
              },
            );
          } else {
            /**
             * ----------------------------------------------------
             * NORMAL BULK UPLOAD
             * ----------------------------------------------------
             */

            if (!pendingJob.filePath) {
              throw new Error(
                "Bulk upload job is missing its file path.",
              );
            }

            const bullJobName =
              pendingJob.action === "UPDATE_SCHEDULE"
                ? "update-schedule"
                : "bulk-upload";

            await bulkUploadQueue.add(
              bullJobName,
              {
                jobId: pendingJob.id,
                filePath: pendingJob.filePath,
                weekStartDate:
                  pendingJob.weekStart.toISOString(),
                batchSize: pendingJob.batchSize,
                action: pendingJob.action,
                employeeCodeFilter:
                  pendingJob.employeeCodeFilter || [],
              },
              {
                jobId: pendingJob.id,
              },
            );
          }

          console.log(
            "[bulkUpload.worker] ADDED TO BULLMQ",
            {
              dbJobId: pendingJob.id,
              jobType: pendingJob.jobType,
            },
          );

          /**
           * Mark the DB job as processing only AFTER BullMQ
           * successfully accepted the job.
           */
          const dispatched =
            await prisma.bulkUploadJob.updateMany({
              where: {
                id: pendingJob.id,
                status: "pending",
                dispatchedAt: null,
              },
              data: {
                status: "processing",
                dispatchedAt: new Date(),
                startedAt: new Date(),
              },
            });

          if (dispatched.count === 0) {
            console.warn(
              `[bulkUpload.worker] job ${pendingJob.id} was already changed by another process`,
            );
          }
        } catch (error) {
          /**
           * Missing file is a permanent job failure.
           */
          if (
            error.message ===
            "Bulk upload job is missing its file path."
          ) {
            await prisma.bulkUploadJob
              .update({
                where: {
                  id: pendingJob.id,
                },
                data: {
                  status: "failed",
                  error: error.message,
                  completedAt: new Date(),
                },
              })
              .catch((statusError) => {
                console.error(
                  `[bulkUpload.worker] failed to persist missing-file status for ${pendingJob.id}:`,
                  statusError,
                );
              });
          } else {
            /**
             * Queue/Redis/DB transient errors should NOT mark
             * the job as failed. It remains pending and will be
             * retried on the next polling cycle.
             */
            console.error(
              `[bulkUpload.worker] dispatch failed for job ${pendingJob.id}:`,
              {
                name: error?.name,
                code: error?.code,
              },
            );
          }
        }
      }

      /**
       * ========================================================
       * RECONCILIATION
       * ========================================================
       */

      if (
        Date.now() - lastReconcileAt >=
        RECONCILE_INTERVAL_MS
      ) {
        lastReconcileAt = Date.now();

        const dispatchedJobs =
          await prisma.bulkUploadJob.findMany({
            where: {
              ...dispatchSelector,
              status: "processing",
              dispatchedAt: {
                not: null,
              },
            },
            orderBy: {
              updatedAt: "asc",
            },
            take: 100,
          });

        for (const pendingJob of dispatchedJobs) {
          try {
            const queueJob =
              await bulkUploadQueue.getJob(
                pendingJob.id,
              );

            const state = queueJob
              ? await queueJob.getState()
              : "missing";

            /**
             * Still alive in BullMQ. Nothing to reconcile.
             */
            if (LIVE_QUEUE_STATES.has(state)) {
              continue;
            }

            /**
             * A queue job can disappear after completion because
             * removeOnComplete/removeOnFail is enabled.
             */
            const completed =
              state === "completed";

            const data = {
              status: completed
                ? "completed"
                : "failed",

              error: completed
                ? null
                : queueJob?.failedReason ||
                  `Queue job ${state} before the database status was updated.`,

              completedAt: queueJob?.finishedOn
                ? new Date(queueJob.finishedOn)
                : new Date(),
            };

            if (
              completed &&
              queueJob?.returnvalue !== undefined
            ) {
              data.result = queueJob.returnvalue;
            }

            const reconciled =
              await prisma.bulkUploadJob.updateMany({
                where: {
                  id: pendingJob.id,
                  ...dispatchSelector,
                  status: "processing",
                },
                data,
              });

            if (
              reconciled.count > 0 &&
              pendingJob.filePath
            ) {
              await fs
                .unlink(pendingJob.filePath)
                .catch(() => {});
            }
          } catch (reconcileError) {
            console.error(
              `[bulkUpload.worker] reconcile failed for job ${pendingJob.id}:`,
              {
                name: reconcileError?.name,
                code: reconcileError?.code,
              },
            );
          }
        }
      }
    } catch (error) {
      /**
       * Never allow polling errors to terminate the worker.
       */
      console.error(
        "[bulkUpload.worker] queue polling failed:",
        {
          name: error?.name,
          code: error?.code,
        },
      );
    } finally {
      queuePollInProgress = false;
    }
  };

  /**
   * Start DB polling.
   */
  const queuePollTimer = setInterval(
    pollQueue,
    DISPATCH_INTERVAL_MS,
  );

  queuePollTimer.unref();

  /**
   * Immediately run once at startup.
   */
  pollQueue().catch((error) => {
    console.error(
      "[bulkUpload.worker] initial queue poll failed:",
      { name: error?.name, code: error?.code },
    );
  });

  /**
   * ============================================================
   * SHUTDOWN
   * ============================================================
   */

  const shutdown = async () => {
    console.log(
      "[bulkUpload.worker] shutting down...",
    );

    clearInterval(queuePollTimer);

    try {
      await worker.close();
      await bulkUploadQueue.close();
    } catch (error) {
      console.error(
        "[bulkUpload.worker] shutdown error:",
        { name: error?.name, code: error?.code },
      );
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  /**
   * ============================================================
   * BULLMQ EVENTS
   * ============================================================
   */

  worker.on("ready", () => {
    console.log(
      `[bulkUpload.worker] listening for jobs on ${QUEUE_DISPLAY_NAME}`,
    );
  });

  worker.on("error", (error) => {
    console.error(
      "[bulkUpload.worker] worker error:",
      { name: error?.name, code: error?.code },
    );
  });

  worker.on("stalled", (jobId) => {
    console.warn(
      "[bulkUpload.worker] stalled job:",
      jobId,
    );
  });

  worker.on("failed", (job, error) => {
    console.error(
      "[bulkUpload.worker] failed:",
      job?.id,
      { name: error?.name, code: error?.code },
    );
  });

  /**
   * ============================================================
   * PROCESS SAFETY
   * ============================================================
   */

  process.on("unhandledRejection", (error) => {
    console.error(
      "[bulkUpload.worker] unhandled rejection:",
      { name: error?.name, code: error?.code },
    );
  });

  process.on("uncaughtException", (error) => {
    console.error(
      "[bulkUpload.worker] uncaught exception:",
      { name: error?.name, code: error?.code },
    );

    process.exit(1);
  });

  return worker;
};

module.exports = {
  startBulkUploadWorker,
};