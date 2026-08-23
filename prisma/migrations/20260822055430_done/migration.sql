/*
  Warnings:

  - The `vehicleEntity` column on the `WeeklySchedule` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "WeeklySchedule" DROP COLUMN "vehicleEntity",
ADD COLUMN     "vehicleEntity" TEXT;
