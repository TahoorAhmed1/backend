/*
  Warnings:

  - A unique constraint covering the columns `[employeeId,rideDate,leg]` on the table `Attendance` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[rideId,employeeId,leg]` on the table `RidePassenger` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "VendorLateStatus" AS ENUM ('ON_TIME', 'ON_TIME_LATE', 'LATE', 'ONLY_DROP', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "RideLeg" AS ENUM ('PICKUP', 'DROP');

-- DropIndex
DROP INDEX "Attendance_employeeId_rideDate_key";

-- DropIndex
DROP INDEX "RidePassenger_rideId_employeeId_key";

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "backfilled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leg" "RideLeg" NOT NULL DEFAULT 'PICKUP',
ADD COLUMN     "vendorLateStatus" "VendorLateStatus" NOT NULL DEFAULT 'UNCLASSIFIED';

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "serviceType" "ServiceType" NOT NULL DEFAULT 'PICK_AND_DROP',
ADD COLUMN     "serviceTypeBackfilled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RidePassenger" ADD COLUMN     "leg" "RideLeg" NOT NULL DEFAULT 'PICKUP',
ADD COLUMN     "scheduledTime" TIMESTAMP(3),
ADD COLUMN     "serviceType" "ServiceType" NOT NULL DEFAULT 'PICK_AND_DROP';

-- CreateIndex
CREATE INDEX "Attendance_rideDate_vendorLateStatus_idx" ON "Attendance"("rideDate", "vendorLateStatus");

-- CreateIndex
CREATE INDEX "Attendance_rideId_vendorLateStatus_idx" ON "Attendance"("rideId", "vendorLateStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_employeeId_rideDate_leg_key" ON "Attendance"("employeeId", "rideDate", "leg");

-- CreateIndex
CREATE INDEX "Ride_vendorId_rideDate_idx" ON "Ride"("vendorId", "rideDate");

-- CreateIndex
CREATE UNIQUE INDEX "RidePassenger_rideId_employeeId_leg_key" ON "RidePassenger"("rideId", "employeeId", "leg");
