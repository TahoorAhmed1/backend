/*
  Warnings:

  - The `pickupTime` column on the `Ride` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `officeArrivalTime` column on the `Ride` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `dropTime` column on the `Ride` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `vehicleEntity` column on the `WeeklySchedule` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `pickupTime` column on the `WeeklySchedule` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `officeArrivalTime` column on the `WeeklySchedule` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `dropTime` column on the `WeeklySchedule` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Ride" DROP COLUMN "pickupTime",
ADD COLUMN     "pickupTime" TIMESTAMP(3),
DROP COLUMN "officeArrivalTime",
ADD COLUMN     "officeArrivalTime" TIMESTAMP(3),
DROP COLUMN "dropTime",
ADD COLUMN     "dropTime" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WeeklySchedule" DROP COLUMN "vehicleEntity",
ADD COLUMN     "vehicleEntity" "Entity",
DROP COLUMN "pickupTime",
ADD COLUMN     "pickupTime" TIMESTAMP(3),
DROP COLUMN "officeArrivalTime",
ADD COLUMN     "officeArrivalTime" TIMESTAMP(3),
DROP COLUMN "dropTime",
ADD COLUMN     "dropTime" TIMESTAMP(3);
