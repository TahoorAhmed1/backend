/*
  Warnings:

  - A unique constraint covering the columns `[licenseNumber]` on the table `Driver` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Driver_name_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Driver_licenseNumber_key" ON "Driver"("licenseNumber");

-- CreateIndex
CREATE INDEX "Driver_name_cnic_phone_licenseNumber_userId_idx" ON "Driver"("name", "cnic", "phone", "licenseNumber", "userId");
