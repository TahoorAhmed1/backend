/*
  Warnings:

  - You are about to alter the column `latitude` on the `EmployeeLocation` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.
  - You are about to alter the column `longitude` on the `EmployeeLocation` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.
  - You are about to alter the column `accuracy` on the `EmployeeLocation` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.
  - You are about to alter the column `speed` on the `EmployeeLocation` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.
  - You are about to alter the column `heading` on the `EmployeeLocation` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.

*/
-- DropForeignKey
ALTER TABLE "EmployeeLocation" DROP CONSTRAINT "EmployeeLocation_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeLocation" DROP CONSTRAINT "EmployeeLocation_rideId_fkey";

-- AlterTable
ALTER TABLE "EmployeeLocation" ALTER COLUMN "latitude" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "longitude" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "accuracy" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "speed" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "heading" SET DATA TYPE DOUBLE PRECISION;

-- AddForeignKey
ALTER TABLE "EmployeeLocation" ADD CONSTRAINT "EmployeeLocation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLocation" ADD CONSTRAINT "EmployeeLocation_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
