const test = require("node:test");
const assert = require("node:assert/strict");

const { findConflictingJob } = require("../services/bulkupload.producer");

test("stale processing rows are failed when their Redis job is missing", async () => {
  const row = { id: "job-1" };
  const updates = [];
  const bulkUploadJobs = {
    findFirst: async () => row,
    update: async (update) => updates.push(update),
  };
  const queue = { getJob: async () => null };

  const result = await findConflictingJob(
    queue,
    bulkUploadJobs,
    new Date("2026-09-26T00:00:00.000Z"),
  );

  assert.equal(result, null);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, row.id);
  assert.equal(updates[0].data.status, "failed");
  assert.match(updates[0].data.error, /missing/i);
});

test("live Redis jobs still block another upload for the week", async () => {
  const row = { id: "job-2" };
  const bulkUploadJobs = {
    findFirst: async () => row,
    update: async () => assert.fail("live jobs must not be reconciled"),
  };
  const queue = {
    getJob: async () => ({ getState: async () => "active" }),
  };

  const result = await findConflictingJob(
    queue,
    bulkUploadJobs,
    new Date("2026-09-26T00:00:00.000Z"),
  );

  assert.deepEqual(result, { conflict: true, existingJobId: row.id });
});