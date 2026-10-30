-- CreateIndex
CREATE INDEX "Complaint_rideId_idx" ON "Complaint"("rideId");

-- CreateIndex
CREATE INDEX "Complaint_driverId_idx" ON "Complaint"("driverId");

-- CreateIndex
CREATE INDEX "Complaint_employeeId_idx" ON "Complaint"("employeeId");

-- CreateIndex
CREATE INDEX "Ride_status_rideDate_idx" ON "Ride"("status", "rideDate");
