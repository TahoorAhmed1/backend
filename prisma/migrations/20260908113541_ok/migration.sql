-- CreateTable
CREATE TABLE "BulkUploadJob" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "filePath" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "batchSize" INTEGER NOT NULL DEFAULT 100,
    "totalBatches" INTEGER NOT NULL DEFAULT 0,
    "batchesCompleted" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkUploadJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkUploadJob_weekStart_status_idx" ON "BulkUploadJob"("weekStart", "status");
