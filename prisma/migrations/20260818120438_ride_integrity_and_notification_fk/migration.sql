/*
  Warnings:

  - A unique constraint covering the columns `[driverId,routeId,rideDate]` on the table `Ride` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "subAreaId" TEXT;

-- AlterTable
ALTER TABLE "RidePassenger" ADD COLUMN     "area" TEXT,
ADD COLUMN     "employeeName" TEXT,
ADD COLUMN     "subArea" TEXT;

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Ride_routeId_rideDate_idx" ON "Ride"("routeId", "rideDate");

-- CreateIndex
CREATE INDEX "Ride_rideDate_idx" ON "Ride"("rideDate");

-- CreateIndex
CREATE UNIQUE INDEX "Ride_driverId_routeId_rideDate_key" ON "Ride"("driverId", "routeId", "rideDate");

-- CreateIndex
CREATE INDEX "WeeklySchedule_weekStart_status_routeId_idx" ON "WeeklySchedule"("weekStart", "status", "routeId");

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_subAreaId_fkey" FOREIGN KEY ("subAreaId") REFERENCES "SubArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
