-- DropIndex
DROP INDEX "Driver_name_cnic_phone_licenseNumber_userId_idx";

-- CreateIndex
CREATE INDEX "Driver_cnic_licenseNumber_userId_idx" ON "Driver"("cnic", "licenseNumber", "userId");
