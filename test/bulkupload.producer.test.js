const test = require("node:test");
const assert = require("node:assert/strict");

const queueModulePath = require.resolve("../lib/queue");
const { findConflictingJob } = require("../services/bulkupload.producer");

test("producer does not load the Redis queue module", () => {
  assert.equal(require.cache[queueModulePath], undefined);
});

test("processing jobs block another upload without consulting Redis", async () => {
  const row = { id: "job-1" };
  const bulkUploadJobs = {
    findFirst: async () => row,
  };

  const result = await findConflictingJob(
    bulkUploadJobs,
    new Date("2026-09-26T00:00:00.000Z"),
  );

  assert.deepEqual(result, { conflict: true, existingJobId: row.id });
});

test("no processing job means the week is available", async () => {
  const bulkUploadJobs = {
    findFirst: async () => null,
  };

  const result = await findConflictingJob(
    bulkUploadJobs,
    new Date("2026-09-26T00:00:00.000Z"),
  );

  assert.equal(result, null);
});