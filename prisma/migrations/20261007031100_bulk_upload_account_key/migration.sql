ALTER TABLE "BulkUploadJob"
ADD COLUMN "accountKey" TEXT;

ALTER TABLE "BulkUploadJob"
ADD CONSTRAINT "BulkUploadJob_accountKey_check"
CHECK ("accountKey" IS NULL OR "accountKey" IN ('account-1', 'account-2', 'account-3'));

CREATE INDEX "BulkUploadJob_accountKey_status_dispatchedAt_createdAt_idx"
ON "BulkUploadJob"("accountKey", "status", "dispatchedAt", "createdAt");
