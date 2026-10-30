-- DropIndex
DROP INDEX "DeviceToken_userId_idx";

-- DropIndex
DROP INDEX "Driver_cnic_licenseNumber_userId_idx";

-- DropIndex
DROP INDEX "Notification_userId_idx";

-- DropIndex
DROP INDEX "Ride_rideDate_idx";

-- CreateIndex
CREATE INDEX "AuditLog_model_recordId_idx" ON "AuditLog"("model", "recordId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Block_subAreaId_idx" ON "Block"("subAreaId");

-- CreateIndex
CREATE INDEX "Complaint_vehicleId_idx" ON "Complaint"("vehicleId");

-- CreateIndex
CREATE INDEX "Driver_vendorId_idx" ON "Driver"("vendorId");

-- CreateIndex
CREATE INDEX "Employee_areaId_idx" ON "Employee"("areaId");

-- CreateIndex
CREATE INDEX "Employee_subAreaId_idx" ON "Employee"("subAreaId");

-- CreateIndex
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");

-- CreateIndex
CREATE INDEX "Employee_status_idx" ON "Employee"("status");

-- CreateIndex
CREATE INDEX "EmployeeLocation_rideId_employeeId_recordedAt_idx" ON "EmployeeLocation"("rideId", "employeeId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_status_createdAt_idx" ON "Notification"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ride_rideDate_id_idx" ON "Ride"("rideDate" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ride_status_pickupTime_idx" ON "Ride"("status", "pickupTime");

-- CreateIndex
CREATE INDEX "Ride_vehicleId_idx" ON "Ride"("vehicleId");

-- CreateIndex
CREATE INDEX "Ride_tripId_idx" ON "Ride"("tripId");

-- CreateIndex
CREATE INDEX "Ride_areaId_idx" ON "Ride"("areaId");

-- CreateIndex
CREATE INDEX "Ride_subAreaId_idx" ON "Ride"("subAreaId");

-- CreateIndex
CREATE INDEX "RidePassenger_employeeId_idx" ON "RidePassenger"("employeeId");

-- CreateIndex
CREATE INDEX "Route_officeId_idx" ON "Route"("officeId");

-- CreateIndex
CREATE INDEX "Vehicle_vendorId_idx" ON "Vehicle"("vendorId");
