-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'BREAKDOWN');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('CAR', 'VAN', 'HIJET', 'KARVAN', 'BUS');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('AVAILABLE', 'ON_RIDE', 'OFFLINE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DriverShiftType" AS ENUM ('TWELVE_HOUR', 'TWENTY_FOUR_HOUR');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "Entity" AS ENUM ('IBEX', 'VW');

-- CreateEnum
CREATE TYPE "OfficeLocation" AS ENUM ('IBT_1', 'IBT_2', 'IBT_3', 'SKY_TOWER');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('PICK_AND_DROP', 'DROP_ONLY', 'PICK_ONLY');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('PENDING', 'STARTED', 'ARRIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ComplaintCategory" AS ENUM ('DRIVER_BEHAVIOUR', 'VEHICLE_CONDITION', 'ROUTE_ISSUE', 'TIMING_DELAY', 'SCHEDULING', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'DRAFT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DayStatus" AS ENUM ('PICKUP', 'DROP', 'BOTH', 'OFF', 'ABSENT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'DISPATCHER', 'DRIVER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('UNREAD', 'READ');

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT 'Karachi',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubArea" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subAreaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "VendorStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "type" "VehicleType" NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "year" TEXT,
    "capacity" INTEGER NOT NULL,
    "vendorId" TEXT,
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "driverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "licenseNumber" TEXT,
    "cnic" TEXT,
    "vendorId" TEXT,
    "shiftType" "DriverShiftType" NOT NULL DEFAULT 'TWELVE_HOUR',
    "shiftLabel" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "maxDailyHours" INTEGER,
    "maxWeeklyHours" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "routeCode" TEXT NOT NULL,
    "routeName" TEXT NOT NULL,
    "areaId" TEXT,
    "subAreaId" TEXT,
    "officeLocation" "OfficeLocation",
    "serviceType" "ServiceType" NOT NULL DEFAULT 'PICK_AND_DROP',
    "maxCapacity" INTEGER NOT NULL,
    "driverId" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "shiftTiming" TEXT,
    "pickupStartTime" TIMESTAMP(3),
    "dropTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "tripNumber" INTEGER NOT NULL DEFAULT 1,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "shiftTiming" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactNumber" TEXT,
    "cnic" TEXT,
    "gender" "Gender",
    "designation" TEXT,
    "entity" "Entity",
    "officeLocation" "OfficeLocation",
    "departmentId" TEXT,
    "areaId" TEXT,
    "subAreaId" TEXT,
    "blockId" TEXT,
    "address" TEXT,
    "serviceType" "ServiceType" NOT NULL DEFAULT 'PICK_AND_DROP',
    "shiftTiming" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklySchedule" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "employeeId" TEXT NOT NULL,
    "routeId" TEXT,
    "tripId" TEXT,
    "serviceType" "ServiceType" NOT NULL DEFAULT 'PICK_AND_DROP',
    "driverId" TEXT,
    "vehicleId" TEXT,
    "vendorId" TEXT,
    "vehicleEntity" "Entity",
    "pickupTime" TEXT,
    "shiftTiming" TEXT,
    "officeArrivalTime" TEXT,
    "dropTime" TEXT,
    "offDay" TEXT,
    "monday" "DayStatus" NOT NULL DEFAULT 'BOTH',
    "tuesday" "DayStatus" NOT NULL DEFAULT 'BOTH',
    "wednesday" "DayStatus" NOT NULL DEFAULT 'BOTH',
    "thursday" "DayStatus" NOT NULL DEFAULT 'BOTH',
    "friday" "DayStatus" NOT NULL DEFAULT 'BOTH',
    "saturday" "DayStatus" NOT NULL DEFAULT 'OFF',
    "sunday" "DayStatus" NOT NULL DEFAULT 'OFF',
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ride" (
    "id" TEXT NOT NULL,
    "rideDate" TIMESTAMP(3) NOT NULL,
    "routeId" TEXT NOT NULL,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "vendorId" TEXT,
    "areaId" TEXT,
    "pickupTime" TEXT,
    "dropTime" TEXT,
    "status" "RideStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RidePassenger" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "address" TEXT,
    "contact" TEXT,

    CONSTRAINT "RidePassenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "rideDate" TIMESTAMP(3) NOT NULL,
    "employeeId" TEXT NOT NULL,
    "rideId" TEXT,
    "arrivalTime" TIMESTAMP(3),
    "delayMinutes" INTEGER,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "rideId" TEXT,
    "category" "ComplaintCategory" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "qr_code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "employeeCode" TEXT,
    "rowNumber" INTEGER,
    "reason" TEXT NOT NULL,
    "rawData" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'UNREAD',
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Area_name_key" ON "Area"("name");

-- CreateIndex
CREATE INDEX "SubArea_areaId_idx" ON "SubArea"("areaId");

-- CreateIndex
CREATE UNIQUE INDEX "SubArea_name_areaId_key" ON "SubArea"("name", "areaId");

-- CreateIndex
CREATE UNIQUE INDEX "Block_name_subAreaId_key" ON "Block"("name", "subAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vehicleNumber_key" ON "Vehicle"("vehicleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_driverId_key" ON "Vehicle"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_cnic_key" ON "Driver"("cnic");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Route_routeCode_key" ON "Route"("routeCode");

-- CreateIndex
CREATE INDEX "Route_areaId_idx" ON "Route"("areaId");

-- CreateIndex
CREATE INDEX "Route_subAreaId_idx" ON "Route"("subAreaId");

-- CreateIndex
CREATE INDEX "Trip_routeId_idx" ON "Trip"("routeId");

-- CreateIndex
CREATE INDEX "Trip_driverId_idx" ON "Trip"("driverId");

-- CreateIndex
CREATE INDEX "Trip_vehicleId_idx" ON "Trip"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_routeId_tripNumber_key" ON "Trip"("routeId", "tripNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeCode_key" ON "Employee"("employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_cnic_key" ON "Employee"("cnic");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "WeeklySchedule_weekStart_idx" ON "WeeklySchedule"("weekStart");

-- CreateIndex
CREATE INDEX "WeeklySchedule_employeeId_idx" ON "WeeklySchedule"("employeeId");

-- CreateIndex
CREATE INDEX "WeeklySchedule_tripId_idx" ON "WeeklySchedule"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklySchedule_employeeId_weekStart_key" ON "WeeklySchedule"("employeeId", "weekStart");

-- CreateIndex
CREATE INDEX "RidePassenger_rideId_idx" ON "RidePassenger"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "RidePassenger_rideId_employeeId_key" ON "RidePassenger"("rideId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_employeeId_rideDate_key" ON "Attendance"("employeeId", "rideDate");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_qr_code_key" ON "User"("qr_code");

-- CreateIndex
CREATE INDEX "ScheduleException_weekStart_idx" ON "ScheduleException"("weekStart");

-- AddForeignKey
ALTER TABLE "SubArea" ADD CONSTRAINT "SubArea_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_subAreaId_fkey" FOREIGN KEY ("subAreaId") REFERENCES "SubArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_subAreaId_fkey" FOREIGN KEY ("subAreaId") REFERENCES "SubArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_subAreaId_fkey" FOREIGN KEY ("subAreaId") REFERENCES "SubArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "Block"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RidePassenger" ADD CONSTRAINT "RidePassenger_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RidePassenger" ADD CONSTRAINT "RidePassenger_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
