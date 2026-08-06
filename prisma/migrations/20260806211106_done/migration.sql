-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "maxDailyHours" INTEGER,
ADD COLUMN     "maxWeeklyHours" INTEGER;

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "employeeCode" TEXT,
    "rowNumber" INTEGER,
    "reason" TEXT NOT NULL,
    "rawData" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleException_weekStart_idx" ON "ScheduleException"("weekStart");
