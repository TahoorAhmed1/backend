

const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse, okResponse, createSuccessResponse } = require("../../../constants/responses");



const createVehicle = async (req, res, next) => {
  try {
    const { vehicleNumber, type, make, model, year, capacity, vendorId, driverId, status, notes } = req.body;

    const existingVehicle = await prisma.vehicle.findUnique({ where: { vehicleNumber } });
    if (existingVehicle) {
      const response = badRequestResponse("Vehicle with this number already exists.");
      return res.status(response.status.code).json(response);
    }

    const vehicle = await prisma.$transaction(async (tx) => {
      if (driverId) {
        const driver = await tx.driver.findUnique({ where: { id: driverId } });
        if (!driver) {
          const err = new Error("Driver not found.");
          err.isBadRequest = true;
          throw err;
        }
        await tx.vehicle.updateMany({
          where: { driverId },
          data: { driverId: null },
        });
      }

      return tx.vehicle.create({
        data: { vehicleNumber, type, make, model, year, capacity, vendorId, driverId, status: status || "ACTIVE", notes },
      });
    });

    const response = createSuccessResponse(vehicle, "Record created successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    if (error.isBadRequest) {
      const errorResponse = badRequestResponse  (error.message);
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    next(error);
  }
};

const getAllVehicles = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status, vendorId, type } = req.query;

    const where = {};
    if (status) where.status = status;
    if (vendorId) where.vendorId = vendorId;
    if (type) where.type = type;

    const options = {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        vendor: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        rides: { select: { id: true, rideDate: true } },
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.vehicle, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getVehicleById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.vehicle, id, {
      vendor: true,
      driver: true,
      rides: true,
      complaints: true,
      weeklySchedules: true,
    });

    if (!response) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    
    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (
      updateData.vehicleNumber &&
      updateData.vehicleNumber !== vehicle.vehicleNumber
    ) {
      const existingNumber = await prisma.vehicle.findUnique({
        where: { vehicleNumber: updateData.vehicleNumber },
      });
      if (existingNumber) {
        const errorResponse = badRequestResponse(
          "Vehicle number already exists."
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.vehicle, id, updateData, {
      vendor: true,
      driver: true,
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;

    
    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      include: {
        rides: true,
        weeklySchedules: true,
      },
    });

    if (!vehicle) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (vehicle.rides.length > 0 || vehicle.weeklySchedules.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete vehicle with active rides or schedules."
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.vehicle, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getVehicleRides = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { skip = 0, take = 10, status } = req.query;

    const where = { vehicleId: id };
    if (status) where.status = status;

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(take),
        include: {
          route: { select: { id: true, routeName: true } },
          driver: { select: { id: true, name: true } },
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.ride.count({ where }),
    ]);

    const response = okResponse(
      {
        vehicleId: id,
        rides,
        pagination: {
          total,
          limit: parseInt(take),
          offset: parseInt(skip),
        },
      },
      "Vehicle rides retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateVehicleStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["ACTIVE", "INACTIVE", "MAINTENANCE", "BREAKDOWN"];
    if (!validStatuses.includes(status)) {
      const response = badRequestResponse("Invalid vehicle status.");
      return res.status(response.status.code).json(response);
    }

    const response = await updateRecord(prisma.vehicle, id, { status });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getVehicleComplaints = async (req, res, next) => {
  try {
    const { id } = req.params;

    const complaints = await prisma.complaint.findMany({
      where: { vehicleId: id },
      include: {
        employee: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        ride: { select: { id: true, rideDate: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const response = okResponse(
      {
        vehicleId: id,
        complaints,
      },
      "Vehicle complaints retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createVehicle,
  getAllVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  getVehicleRides,
  updateVehicleStatus,
  getVehicleComplaints,
};
