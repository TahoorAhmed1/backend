const { prisma } = require("../lib/prisma");

const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 100;

const findConflictingJob = async (bulkUploadJobs, weekStartDate) => {
  const conflicting = await bulkUploadJobs.findFirst({
    where: {
      weekStart: weekStartDate,
      status: "processing",
      jobType: "BULK_UPLOAD",
    },
  });

  return conflicting
    ? { conflict: true, existingJobId: conflicting.id }
    : null;
};

/**
 * Persists a bulk upload job for the bulk process to dispatch to BullMQ.
 *
 * Returns immediately - the actual processing happens in the worker.
 */
const enqueueBulkUpload = async (filePath, weekStartDate, batchSize = DEFAULT_BATCH_SIZE) => {
  const clampedBatchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(MIN_BATCH_SIZE, batchSize || DEFAULT_BATCH_SIZE),
  );

  const conflicting = await findConflictingJob(
    prisma.bulkUploadJob,
    weekStartDate,
  );
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.id };
  }

  const job = await prisma.bulkUploadJob.create({
    data: {
      weekStart: weekStartDate,
      filePath,
      batchSize: clampedBatchSize,
      status: "processing",
      jobType: "BULK_UPLOAD",
      action: "BULK_UPLOAD",
    },
  });

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

  const conflicting = await findConflictingJob(
    prisma.bulkUploadJob,
    weekStartDate,
  );
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.id };
  }

  const job = await prisma.bulkUploadJob.create({
    data: {
      weekStart: weekStartDate,
      filePath,
      batchSize: clampedBatchSize,
      status: "processing",
      jobType: "BULK_UPLOAD",
      action: "UPDATE_SCHEDULE",
      employeeCodeFilter,
    },
  });

  return { conflict: false, jobId: job.id };
};

/**
 * For your status-polling endpoint (e.g. GET /bulk-upload/:jobId).
 */
const getBulkUploadJobStatus = async (jobId) => {
  return prisma.bulkUploadJob.findUnique({ where: { id: jobId } });
};

const enqueuePendingRideResync = async (weekStartDate) => {
  const dedupeKey = `resync-pending-rides-${weekStartDate
    .toISOString()
    .slice(0, 10)}`;
  const existing = await prisma.bulkUploadJob.findFirst({
    where: { dedupeKey },
  });

  if (existing?.status === "processing") {
    return { jobId: existing.id };
  }

  if (existing) {
    await prisma.bulkUploadJob.updateMany({
      where: {
        id: existing.id,
        status: { in: ["completed", "failed"] },
      },
      data: {
        status: "processing",
        dispatchedAt: null,
        startedAt: new Date(),
        completedAt: null,
        result: null,
        error: null,
      },
    });
    return { jobId: existing.id };
  }

  try {
    const job = await prisma.bulkUploadJob.create({
      data: {
        weekStart: weekStartDate,
        status: "processing",
        jobType: "RESYNC_PENDING_RIDES",
        dedupeKey,
        filePath: null,
      },
    });
    return { jobId: job.id };
  } catch (error) {
    if (error.code !== "P2002") throw error;
    const concurrentJob = await prisma.bulkUploadJob.findUnique({
      where: { dedupeKey },
    });
    if (!concurrentJob) throw error;
    return { jobId: concurrentJob.id };
  }
};

module.exports = {
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
  enqueueBulkUpload,
  enqueueUpdateSchedule,
  enqueuePendingRideResync,
  getBulkUploadJobStatus,
  findConflictingJob,
};