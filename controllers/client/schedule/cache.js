// ============================================================
// BULK UPLOAD JOB MANAGEMENT
// ============================================================

const bulkUploadJobs = new Map();
const { BULK_UPLOAD_JOB_TTL_MS } = require("./constants");

const createBulkUploadJob = (totalRows, batchSize, weekStartDate) => {
  const cutoff = Date.now() - BULK_UPLOAD_JOB_TTL_MS;
  for (const [id, job] of bulkUploadJobs) {
    if (job.status !== "processing" && job.startedAt < cutoff) {
      bulkUploadJobs.delete(id);
    }
  }

  const weekKey = weekStartDate.toISOString();
  const conflicting = Array.from(bulkUploadJobs.values()).find(
    (job) => job.status === "processing" && job.weekKey === weekKey,
  );
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.jobId };
  }

  const jobId = `bulkupload_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  bulkUploadJobs.set(jobId, {
    jobId,
    weekKey,
    status: "processing",
    totalRows,
    processedRows: 0,
    batchSize,
    totalBatches: totalRows ? Math.ceil(totalRows / batchSize) : 0,
    batchesCompleted: 0,
    startedAt: Date.now(),
    partialResult: null,
    result: null,
    error: null,
  });
  return { conflict: false, jobId };
};

const updateBulkUploadJob = (jobId, patch) => {
  const job = bulkUploadJobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
};

const getBulkUploadJob = (jobId) => {
  return bulkUploadJobs.get(jobId);
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  bulkUploadJobs,
  createBulkUploadJob,
  updateBulkUploadJob,
  getBulkUploadJob,
};