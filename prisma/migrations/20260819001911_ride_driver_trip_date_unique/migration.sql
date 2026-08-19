/*
  Warnings:

  - A unique constraint covering the columns `[driverId,tripId,rideDate]` on the table `Ride` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Ride_driverId_routeId_rideDate_key";

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "tripId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Ride_driverId_tripId_rideDate_key" ON "Ride"("driverId", "tripId", "rideDate");

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
