-- CreateEnum
CREATE TYPE "RideConfirmationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED');

-- AlterTable
ALTER TABLE "RidePassenger" ADD COLUMN     "confirmationStatus" "RideConfirmationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "confirmedAt" TIMESTAMP(3);
