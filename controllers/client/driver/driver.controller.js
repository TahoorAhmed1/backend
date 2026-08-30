const { prisma } = require("../../../lib/prisma");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");
const { hashPassword } = require("../../../services/auth.service");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const QR_DIR = path.join(__dirname, "..", "..", "qrcodes", "drivers");
const DRIVER_EMAIL_DOMAIN = "ibex.com";
const DEFAULT_DRIVER_PASSWORD = "12345678";

// Ensure QR directory exists
fs.mkdirSync(QR_DIR, { recursive: true });

const createDriver = async (req, res, next) => {
  try {
    const {
      name,
      phone,
      licenseNumber,
      cnic,
      vendorId,
      shiftType,
      shiftLabel,
      status,
      notes,
    } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      const response = badRequestResponse("Driver name is required.");
      return res.status(response.status.code).json(response);
    }

    if (cnic) {
      const existingDriver = await prisma.driver.findUnique({
        where: { cnic },
      });
      if (existingDriver) {
        const response = badRequestResponse(
          "Driver with this CNIC already exists.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    if (licenseNumber) {
      const existingLicense = await prisma.driver.findUnique({
        where: { licenseNumber },
      });
      if (existingLicense) {
        const response = badRequestResponse(
          "Driver with this license number already exists.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    const driver = await prisma.$transaction(async (tx) => {
      // Create driver
      const newDriver = await tx.driver.create({
        data: {
          name: name.trim(),
          phone,
          licenseNumber,
          cnic,
          vendorId,
          shiftType: shiftType || "TWELVE_HOUR",
          shiftLabel,
          status: status || "AVAILABLE",
          notes,
        },
      });

      // Generate QR token
      const qrToken = crypto.randomBytes(32).toString("hex");
      
      // Create user account with QR code
      const email = cnic 
        ? `${cnic.replace(/[^0-9]/g, "")}@${DRIVER_EMAIL_DOMAIN}`
        : `${newDriver.id}@${DRIVER_EMAIL_DOMAIN}`;
      
      const hashedPassword = await hashPassword(DEFAULT_DRIVER_PASSWORD);
      
      const user = await tx.user.create({
        data: {
          email,
          name: newDriver.name,
          passwordHash: hashedPassword,
          role: "DRIVER",
          qrCode: qrToken,
          isActive: true,
        },
      });

      // Link user to driver
      const updatedDriver = await tx.driver.update({
        where: { id: newDriver.id },
        data: { userId: user.id },
        include: {
          vendor: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          user: { select: { id: true, email: true, role: true, qrCode: true } },
        },
      });

      return {
        driver: updatedDriver,
        qrToken,
        defaultPassword: DEFAULT_DRIVER_PASSWORD,
      };
    });

    // Generate QR code image after transaction succeeds
    let qrImagePath = null;
    let qrImageUrl = null;
    
    try {
      const safeName = driver.driver.name.replace(/\s+/g, "").replace(/[\\/:*?"<>|]/g, "");
      const qrFileName = `${safeName}-${driver.driver.id}.png`;
      qrImagePath = path.join(QR_DIR, qrFileName);
      
      // Generate QR code with structured data
      const qrData = JSON.stringify({
        type: "DRIVER_AUTH",
        token: driver.qrToken,
        userId: driver.driver.userId,
        driverId: driver.driver.id,
        version: 1,
      });
      
      await QRCode.toFile(qrImagePath, qrData, {
        width: 400,
        margin: 2,
        errorCorrectionLevel: "H",
      });
      
      qrImageUrl = `/qrcodes/drivers/${qrFileName}`;
    } catch (qrError) {
      console.error("QR code generation failed:", qrError);
      // Don't fail the whole request if QR generation fails
      // The token is still in the database and can be regenerated
    }

    const response = createSuccessResponse(
      {
        ...driver.driver,
        qrCode: driver.qrToken,
        qrImageUrl,
        defaultPassword: DEFAULT_DRIVER_PASSWORD,
        loginEmail: driver.driver.user.email,
      },
      "Driver created successfully with QR code.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getAllDrivers = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search,
      vendorId,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    // Filters
    if (status) where.status = status;
    if (vendorId) where.vendorId = vendorId;

    // Search functionality
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { cnic: { contains: search, mode: "insensitive" } },
        { licenseNumber: { contains: search, mode: "insensitive" } },
        { shiftLabel: { contains: search, mode: "insensitive" } },
      ];
    }

    const [drivers, total] = await Promise.all([
      prisma.driver.findMany({
        where,
        skip,
        take,
        include: {
          vendor: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true, type: true } },
          user: { 
            select: { 
              id: true, 
              email: true, 
              role: true, 
              isActive: true,
              qrCode: true,
            } 
          },
          _count: {
            select: {
              rides: true,
              complaints: true,
              weeklySchedules: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.driver.count({ where }),
    ]);

    // Map drivers to include counts and QR info
    const driversWithCounts = drivers.map((driver) => ({
      ...driver,
      rideCount: driver._count.rides,
      complaintCount: driver._count.complaints,
      scheduleCount: driver._count.weeklySchedules,
      hasQRCode: Boolean(driver.user?.qrCode),
      _count: undefined,
    }));

    const response = okResponse(
      {
        drivers: driversWithCounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Drivers retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getDriverById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const driver = await prisma.driver.findUnique({
      where: { id },
      include: {
        vendor: true,
        vehicle: true,
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            isActive: true,
            qrCode: true,
            createdAt: true,
          },
        },
        rides: {
          take: 10,
          orderBy: { rideDate: "desc" },
          include: {
            route: { select: { id: true, routeName: true, routeCode: true } },
          },
        },
        trips: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        complaints: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        weeklySchedules: {
          take: 10,
          orderBy: { weekStart: "desc" },
        },
        _count: {
          select: {
            rides: true,
            complaints: true,
            weeklySchedules: true,
          },
        },
      },
    });

    if (!driver) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const driverWithCounts = {
      ...driver,
      rideCount: driver._count.rides,
      complaintCount: driver._count.complaints,
      scheduleCount: driver._count.weeklySchedules,
      hasQRCode: Boolean(driver.user?.qrCode),
      qrImageUrl: driver.user?.qrCode 
        ? `/qrcodes/drivers/${driver.name.replace(/\s+/g, "")}-${driver.id}.png`
        : null,
      _count: undefined,
    };

    const response = okResponse(
      driverWithCounts,
      "Driver retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const updateDriver = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { vehicleId, resetPassword, regenerateQR, ...updateData } = req.body;

    const driver = await prisma.driver.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!driver) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check CNIC uniqueness
    if (updateData.cnic && updateData.cnic !== driver.cnic) {
      const existingCnic = await prisma.driver.findUnique({
        where: { cnic: updateData.cnic },
      });
      if (existingCnic) {
        const errorResponse = badRequestResponse(
          "Driver with this CNIC already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    // Check license number uniqueness
    if (updateData.licenseNumber && updateData.licenseNumber !== driver.licenseNumber) {
      const existingLicense = await prisma.driver.findUnique({
        where: { licenseNumber: updateData.licenseNumber },
      });
      if (existingLicense) {
        const errorResponse = badRequestResponse(
          "Driver with this license number already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Handle vehicle assignment
      if (vehicleId !== undefined) {
        await tx.vehicle.updateMany({
          where: { driverId: id },
          data: { driverId: null },
        });

        if (vehicleId) {
          const targetVehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
          if (!targetVehicle) {
            const err = new Error("Vehicle not found.");
            err.isBadRequest = true;
            throw err;
          }

          if (targetVehicle.driverId && targetVehicle.driverId !== id) {
            const err = new Error("Vehicle is already assigned to another driver.");
            err.isBadRequest = true;
            throw err;
          }

          await tx.vehicle.update({
            where: { id: vehicleId },
            data: { driverId: id },
          });
        }
      }

      const updatedDriver = await tx.driver.update({
        where: { id },
        data: updateData,
        include: {
          vendor: true,
          vehicle: true,
          user: { select: { id: true, email: true, role: true, qrCode: true } },
        },
      });

      // Update user account
      if (driver.userId) {
        const userUpdateData = {};
        
        if (updateData.name) userUpdateData.name = updateData.name;
        
        // Reset password if requested
        if (resetPassword) {
          userUpdateData.passwordHash = await hashPassword(DEFAULT_DRIVER_PASSWORD);
        }
        
        // Regenerate QR code if requested
        if (regenerateQR) {
          userUpdateData.qrCode = crypto.randomBytes(32).toString("hex");
        }
        
        if (Object.keys(userUpdateData).length > 0) {
          await tx.user.update({
            where: { id: driver.userId },
            data: userUpdateData,
          });
        }
      }

      return updatedDriver;
    });

    // Regenerate QR image if requested
    if (regenerateQR && result.user?.qrCode) {
      try {
        const safeName = result.name.replace(/\s+/g, "").replace(/[\\/:*?"<>|]/g, "");
        const qrPath = path.join(QR_DIR, `${safeName}-${result.id}.png`);
        
        const qrData = JSON.stringify({
          type: "DRIVER_AUTH",
          token: result.user.qrCode,
          userId: result.user.id,
          driverId: result.id,
          version: 1,
        });
        
        await QRCode.toFile(qrPath, qrData, {
          width: 400,
          margin: 2,
          errorCorrectionLevel: "H",
        });
      } catch (qrError) {
        console.error("QR code regeneration failed:", qrError);
      }
    }

    const response = okResponse(result, "Driver updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    if (error.isBadRequest) {
      const errorResponse = badRequestResponse(error.message);
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    console.log('error', error);
    next(error);
  }
};

const deleteDriver = async (req, res, next) => {
  try {
    const { id } = req.params;

    const driver = await prisma.driver.findUnique({
      where: { id },
      include: {
        user: true,
        vehicle: true,
        _count: {
          select: {
            rides: true,
            trips: true,
            complaints: true,
            weeklySchedules: true,
          },
        },
      },
    });

    if (!driver) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check for dependent records
    const blocking = [];
    if (driver._count.rides > 0) blocking.push(`${driver._count.rides} ride(s)`);
    if (driver._count.trips > 0) blocking.push(`${driver._count.trips} trip(s)`);
    if (driver._count.complaints > 0) blocking.push(`${driver._count.complaints} complaint(s)`);
    if (driver._count.weeklySchedules > 0) blocking.push(`${driver._count.weeklySchedules} schedule(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete driver: referenced by ${blocking.join(", ")}. Remove related records first.`
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Unassign vehicle if assigned
      if (driver.vehicle) {
        await tx.vehicle.update({
          where: { id: driver.vehicle.id },
          data: { driverId: null },
        });
      }

      // Delete user account
      if (driver.userId) {
        // Delete device tokens
        await tx.deviceToken.deleteMany({
          where: { userId: driver.userId },
        });
        
        // Delete notifications
        await tx.notification.deleteMany({
          where: { userId: driver.userId },
        });
        
        // Delete user
        await tx.user.delete({ where: { id: driver.userId } });
      }

      // Delete driver
      await tx.driver.delete({ where: { id } });
      
      return driver;
    });

    // Delete QR code image file if exists
    try {
      const safeName = result.name.replace(/\s+/g, "").replace(/[\\/:*?"<>|]/g, "");
      const qrPath = path.join(QR_DIR, `${safeName}-${result.id}.png`);
      if (fs.existsSync(qrPath)) {
        fs.unlinkSync(qrPath);
      }
    } catch (fileError) {
      console.error("Failed to delete QR code file:", fileError);
    }

    const response = okResponse(
      { id: result.id, name: result.name },
      "Driver and associated user deleted successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getDriverRides = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      page = 1,
      limit = 10,
      status,
      fromDate,
      toDate,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { driverId: id };
    if (status) where.status = status;
    
    if (fromDate || toDate) {
      where.rideDate = {};
      if (fromDate) where.rideDate.gte = new Date(fromDate);
      if (toDate) where.rideDate.lte = new Date(toDate);
    }

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        skip,
        take,
        include: {
          route: { select: { id: true, routeName: true, routeCode: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          _count: {
            select: { passengers: true },
          },
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.ride.count({ where }),
    ]);

    const ridesWithCounts = rides.map((ride) => ({
      ...ride,
      passengerCount: ride._count.passengers,
      _count: undefined,
    }));

    const response = okResponse(
      {
        driverId: id,
        rides: ridesWithCounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Driver rides retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getDriverComplaints = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { driverId: id };
    if (status) where.status = status;

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        skip,
        take,
        include: {
          employee: { select: { id: true, name: true, employeeCode: true } },
          ride: { select: { id: true, rideDate: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.complaint.count({ where }),
    ]);

    const response = okResponse(
      {
        driverId: id,
        complaints,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Driver complaints retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const updateDriverStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["AVAILABLE", "ON_RIDE", "OFFLINE", "INACTIVE"];
    if (!validStatuses.includes(status)) {
      const response = badRequestResponse("Invalid driver status.");
      return res.status(response.status.code).json(response);
    }

    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updatedDriver = await prisma.driver.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        name: true,
        status: true,
        updatedAt: true,
      },
    });

    const response = okResponse(
      updatedDriver,
      "Driver status updated successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

module.exports = {
  createDriver,
  getAllDrivers,
  getDriverById,
  updateDriver,
  deleteDriver,
  getDriverRides,
  getDriverComplaints,
  updateDriverStatus,
};