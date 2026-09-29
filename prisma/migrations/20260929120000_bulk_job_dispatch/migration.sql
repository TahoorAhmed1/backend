ALTER TABLE "BulkUploadJob"
  ALTER COLUMN "filePath" DROP NOT NULL,
  ADD COLUMN "jobType" TEXT NOT NULL DEFAULT 'BULK_UPLOAD',
  ADD COLUMN "action" TEXT NOT NULL DEFAULT 'BULK_UPLOAD',
  ADD COLUMN "employeeCodeFilter" JSONB,
  ADD COLUMN "dispatchedAt" TIMESTAMP(3),
  ADD COLUMN "dedupeKey" TEXT;

CREATE INDEX "BulkUploadJob_status_dispatchedAt_createdAt_idx"
  ON "BulkUploadJob"("status", "dispatchedAt", "createdAt");

UPDATE "BulkUploadJob"
SET "dispatchedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'processing';
