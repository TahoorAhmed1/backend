const { prisma } = require("../../../lib/prisma");
const { getRecordById, getRecords } = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");
const { createDriverUser } = require("../../../utils/userAccount");

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

    const driver = await prisma.$transaction(async (tx) => {
      const driver = await tx.driver.create({
        data: {
          name,
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

      return createDriverUser(tx, driver);
    });

    const response = createSuccessResponse(
      driver,
      "Record created successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllDrivers = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status } = req.query;

    const where = {};
    if (status) where.status = status;

    const options = { 
      where,
   
      include: {
        vendor: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        routes: true,
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.driver, options);
    
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error)
    next(error);
  }
};

const getDriverById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.driver, id, {
      vendor: true,
      vehicle: true,
      user: true,
      rides: true,
      routes: true,
      complaints: true,
      weeklySchedules: true,
    });

    if (!response) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateDriver = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { vehicleId, ...updateData } = req.body;

    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

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

    const response = await prisma.$transaction(async (tx) => {
      // vehicleId isn't a Driver column — the FK lives on Vehicle.driverId
      if (vehicleId !== undefined) {
        // Free this driver from whatever vehicle currently holds them
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
          await tx.vehicle.update({
            where: { id: vehicleId },
            data: { driverId: id },
          });
        }
      }

      const updatedDriver = await tx.driver.update({
        where: { id },
        data: updateData,
        include: { vendor: true, vehicle: true, user: true },
      });

      if (updateData.name && updatedDriver.userId) {
        await tx.user.update({
          where: { id: updatedDriver.userId },
          data: { name: updateData.name },
        });
      }

      return okResponse(updatedDriver, "Record updated successfully.");
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    if (error.isBadRequest) {
      const errorResponse = badRequestResponse(error.message);
      return res.status(errorResponse.status.code).json(errorResponse);
    }
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
        rides: true,
        routes: true,
      },
    });

    if (!driver) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (driver.rides.length > 0 || driver.routes.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete driver with active rides or routes.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await prisma.$transaction(async (tx) => {
      if (driver.userId) {
        await tx.user.delete({ where: { id: driver.userId } });
      }

      await tx.driver.delete({ where: { id } });
      return okResponse(driver, "Record deleted successfully.");
    });
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error)
    next(error);
  }
};

const getDriverRides = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { skip = 0, take = 10, status } = req.query;

    const where = { driverId: id };
    if (status) where.status = status;

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,

        include: {
          route: { select: { id: true, routeName: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.ride.count({ where }),
    ]);

    const response = okResponse(
      {
        driverId: id,
        rides,
        // pagination: {
        //   total,
        //   limit: parseInt(take),
        //   offset: parseInt(skip),
        // },
      },
      "Driver rides retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getDriverComplaints = async (req, res, next) => {
  try {
    const { id } = req.params;

    const complaints = await prisma.complaint.findMany({
      where: { driverId: id },
      include: {
        employee: { select: { id: true, name: true } },
        ride: { select: { id: true, rideDate: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const response = okResponse(
      {
        driverId: id,
        complaints,
      },
      "Driver complaints retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
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

    const response = await updateRecord(prisma.driver, id, { status });
    return res.status(response.status.code).json(response);
  } catch (error) {
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
