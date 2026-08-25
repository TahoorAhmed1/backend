-- DropForeignKey
ALTER TABLE "Trip" DROP CONSTRAINT "Trip_driverId_fkey";

-- AlterTable
ALTER TABLE "Trip" ALTER COLUMN "driverId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
