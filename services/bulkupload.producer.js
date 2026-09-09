const { prisma } = require("../lib/prisma");
const { bulkUploadQueue } = require("../lib/queue");

const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 100;

/**
 * Enqueues a bulk upload job. Call this from your upload route handler
 * with the path of the file already saved to disk (e.g. by multer) -
 * do NOT parse the workbook here and do NOT pass parsed rows into the
 * queue payload. Keeping the payload tiny is what keeps this cheap to
 * run, whether you're on a small Redis instance or, here, plain Postgres.
 *
 * Returns immediately - the actual processing happens in the worker.
 */
const enqueueBulkUpload = async (filePath, weekStartDate, batchSize = DEFAULT_BATCH_SIZE) => {
  const clampedBatchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(MIN_BATCH_SIZE, batchSize || DEFAULT_BATCH_SIZE),
  );

  // Same "one active job per week" rule the old in-memory Map enforced,
  // now checked against the DB so it holds across restarts/instances.
  const conflicting = await prisma.bulkUploadJob.findFirst({
    where: { weekStart: weekStartDate, status: "processing" },
  });
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.id };
  }

  const job = await prisma.bulkUploadJob.create({
    data: {
      weekStart: weekStartDate,
      filePath,
      batchSize: clampedBatchSize,
      status: "processing",
    },
  });

  try {
    // jobId as the BullMQ job id too - if enqueueBulkUpload is ever called
    // twice with the same job.id this dedupes instead of double-queueing.
    await bulkUploadQueue.add(
      "process",
      {
        jobId: job.id,
        filePath,
        weekStartDate: weekStartDate.toISOString(),
        batchSize: clampedBatchSize,
      },
      { jobId: job.id },
    );
  } catch (error) {
    // If we couldn't even hand the job to the queue, don't leave it stuck
    // in "processing" forever - that would block every future upload for
    // this week with a false 409 conflict.
    await prisma.bulkUploadJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: `Failed to enqueue: ${error.message}`,
        completedAt: new Date(),
      },
    });
    throw error;
  }

  return { conflict: false, jobId: job.id };
};

const enqueueUpdateSchedule = async (
  filePath,
  weekStartDate,
  batchSize = DEFAULT_BATCH_SIZE,
  employeeCodeFilter = [],
) => {
  const clampedBatchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(MIN_BATCH_SIZE, batchSize || DEFAULT_BATCH_SIZE),
  );

  const conflicting = await prisma.bulkUploadJob.findFirst({
    where: { weekStart: weekStartDate, status: "processing" },
  });
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.id };
  }

  const job = await prisma.bulkUploadJob.create({
    data: {
      weekStart: weekStartDate,
      filePath,
      batchSize: clampedBatchSize,
      status: "processing",
    },
  });

  try {
    await bulkUploadQueue.add(
      "process",
      {
        jobId: job.id,
        filePath,
        weekStartDate: weekStartDate.toISOString(),
        batchSize: clampedBatchSize,
        action: "UPDATE_SCHEDULE",
        employeeCodeFilter,
      },
      { jobId: job.id },
    );
  } catch (error) {
    await prisma.bulkUploadJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: `Failed to enqueue: ${error.message}`,
        completedAt: new Date(),
      },
    });
    throw error;
  }

  return { conflict: false, jobId: job.id };
};

/**
 * For your status-polling endpoint (e.g. GET /bulk-upload/:jobId).
 */
const getBulkUploadJobStatus = async (jobId) => {
  return prisma.bulkUploadJob.findUnique({ where: { id: jobId } });
};

const enqueuePendingRideResync = async (weekStartDate) => {
  const job = await bulkUploadQueue.add(
    "resync-pending-rides",
    { weekStartDate: weekStartDate.toISOString() },
    {
      jobId: `resync-pending-rides-${weekStartDate.toISOString().slice(0, 10)}`,
    },
  );

  return { jobId: job.id };
};

module.exports = {
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
  enqueueBulkUpload,
  enqueueUpdateSchedule,
  enqueuePendingRideResync,
  getBulkUploadJobStatus,
};