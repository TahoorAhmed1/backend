const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { 
  badRequestResponse, 
  okResponse, 
  createSuccessResponse 
} = require("../../../constants/responses");

const createVehicle = async (req, res, next) => {
  try {
    const { 
      vehicleNumber, 
      type, 
      make, 
      model, 
      year, 
      capacity, 
      vendorId, 
      driverId, 
      status, 
      notes,
      vehicleEntity,
    } = req.body;

    // Validate required fields
    if (!vehicleNumber || !vehicleNumber.trim()) {
      const response = badRequestResponse("Vehicle number is required.");
      return res.status(response.status.code).json(response);
    }

    if (!type) {
      const response = badRequestResponse("Vehicle type is required.");
      return res.status(response.status.code).json(response);
    }

    if (!capacity || capacity < 1) {
      const response = badRequestResponse("Vehicle capacity must be at least 1.");
      return res.status(response.status.code).json(response);
    }

    // Check if vehicle number exists
    const existingVehicle = await prisma.vehicle.findUnique({ 
      where: { vehicleNumber: vehicleNumber.trim() } 
    });
    if (existingVehicle) {
      const response = badRequestResponse("Vehicle with this number already exists.");
      return res.status(response.status.code).json(response);
    }

    // Validate vendor if provided
    if (vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        const response = badRequestResponse("Vendor not found.");
        return res.status(response.status.code).json(response);
      }
    }

    const vehicle = await prisma.$transaction(async (tx) => {
      // Handle driver assignment
      if (driverId) {
        const driver = await tx.driver.findUnique({ where: { id: driverId } });
        if (!driver) {
          const err = new Error("Driver not found.");
          err.isBadRequest = true;
          throw err;
        }

        // Check if driver is already assigned to another vehicle
        const existingAssignment = await tx.vehicle.findFirst({
          where: { driverId, id: { not: undefined } },
        });
        
        if (existingAssignment) {
          const err = new Error("Driver is already assigned to another vehicle.");
          err.isBadRequest = true;
          throw err;
        }
      }

      // Create vehicle
      const newVehicle = await tx.vehicle.create({
        data: {
          vehicleNumber: vehicleNumber.trim(),
          type,
          make,
          model,
          year,
          capacity: parseInt(capacity),
          vendorId,
          driverId,
          status: status || "ACTIVE",
          notes,
          vehicleEntity: vehicleEntity || null,
        },
        include: {
          vendor: { select: { id: true, name: true } },
          driver: { select: { id: true, name: true } },
        },
      });

      return newVehicle;
    });

    const response = createSuccessResponse(
      vehicle, 
      "Vehicle created successfully."
    );
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

const getAllVehicles = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      vendorId,
      type,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      // Add this parameter to filter unassigned vehicles
      unassignedOnly = false,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    // Filters
    if (status) where.status = status;
    if (vendorId) where.vendorId = vendorId;
    if (type) where.type = type;

    // Filter unassigned vehicles (no driver assigned)
    if (unassignedOnly === 'true') {
      where.driverId = null;
    }

    // Search functionality
    if (search) {
      where.OR = [
        { vehicleNumber: { contains: search, mode: "insensitive" } },
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
      ];
    }

    const [vehicles, total] = await Promise.all([
      prisma.vehicle.findMany({
        where,
        skip,
        take,
        include: {
          vendor: { select: { id: true, name: true } },
          driver: { select: { id: true, name: true, phone: true } },
          _count: {
            select: {
              rides: true,
              complaints: true,
              weeklySchedules: true,
              trips: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.vehicle.count({ where }),
    ]);

    // Map vehicles to include counts
    const vehiclesWithCounts = vehicles.map((vehicle) => ({
      ...vehicle,
      rideCount: vehicle._count.rides,
      complaintCount: vehicle._count.complaints,
      scheduleCount: vehicle._count.weeklySchedules,
      tripCount: vehicle._count.trips,
      _count: undefined,
    }));

    const response = okResponse(
      {
        vehicles: vehiclesWithCounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Vehicles retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getVehicleById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      include: {
        vendor: true,
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
            status: true,
          },
        },
        rides: {
          take: 10,
          orderBy: { rideDate: "desc" },
          include: {
            route: { select: { id: true, routeName: true } },
          },
        },
        complaints: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        weeklySchedules: {
          take: 10,
          orderBy: { weekStart: "desc" },
        },
        trips: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            rides: true,
            complaints: true,
            weeklySchedules: true,
            trips: true,
          },
        },
      },
    });

    if (!vehicle) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const vehicleWithCounts = {
      ...vehicle,
      rideCount: vehicle._count.rides,
      complaintCount: vehicle._count.complaints,
      scheduleCount: vehicle._count.weeklySchedules,
      tripCount: vehicle._count.trips,
      _count: undefined,
    };

    const response = okResponse(
      vehicleWithCounts,
      "Vehicle retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const updateVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const vehicle = await prisma.vehicle.findUnique({ 
      where: { id },
      include: { driver: true },
    });

    if (!vehicle) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check vehicle number uniqueness
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

    // Validate vendor if provided
    if (updateData.vendorId) {
      const vendor = await prisma.vendor.findUnique({ 
        where: { id: updateData.vendorId } 
      });
      if (!vendor) {
        const errorResponse = badRequestResponse("Vendor not found.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    // Handle driver reassignment
    const response = await prisma.$transaction(async (tx) => {
      if (updateData.driverId !== undefined) {
        const newDriverId = updateData.driverId || null;
        
        if (newDriverId) {
          // Check if new driver exists
          const driver = await tx.driver.findUnique({ 
            where: { id: newDriverId } 
          });
          if (!driver) {
            const err = new Error("Driver not found.");
            err.isBadRequest = true;
            throw err;
          }

          // Check if driver is assigned to another vehicle
          const existingAssignment = await tx.vehicle.findFirst({
            where: { 
              driverId: newDriverId,
              id: { not: id },
            },
          });
          
          if (existingAssignment) {
            const err = new Error("Driver is already assigned to another vehicle.");
            err.isBadRequest = true;
            throw err;
          }
        }
      }

      const updatedVehicle = await tx.vehicle.update({
        where: { id },
        data: updateData,
        include: {
          vendor: { select: { id: true, name: true } },
          driver: { select: { id: true, name: true, phone: true } },
        },
      });

      return updatedVehicle;
    });

    return res.status(okResponse(
      response,
      "Vehicle updated successfully."
    ).status.code).json(okResponse(response, "Vehicle updated successfully."));
  } catch (error) {
    if (error.isBadRequest) {
      const errorResponse = badRequestResponse(error.message);
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    console.log('error', error);
    next(error);
  }
};

const deleteVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;

    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            rides: true,
            weeklySchedules: true,
            trips: true,
            complaints: true,
          },
        },
      },
    });

    if (!vehicle) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check for dependent records
    const blocking = [];
    if (vehicle._count.rides > 0) blocking.push(`${vehicle._count.rides} ride(s)`);
    if (vehicle._count.weeklySchedules > 0) blocking.push(`${vehicle._count.weeklySchedules} schedule(s)`);
    if (vehicle._count.trips > 0) blocking.push(`${vehicle._count.trips} trip(s)`);
    if (vehicle._count.complaints > 0) blocking.push(`${vehicle._count.complaints} complaint(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete vehicle: referenced by ${blocking.join(", ")}. Remove related records first.`
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const deletedVehicle = await prisma.vehicle.delete({
      where: { id },
    });

    const response = okResponse(
      { id: deletedVehicle.id, vehicleNumber: deletedVehicle.vehicleNumber },
      "Vehicle deleted successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getVehicleRides = async (req, res, next) => {
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

    const where = { vehicleId: id };
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
          driver: { select: { id: true, name: true } },
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
        vehicleId: id,
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
      "Vehicle rides retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
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

    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) {
      const errorResponse = badRequestResponse("Vehicle not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updatedVehicle = await prisma.vehicle.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        vehicleNumber: true,
        status: true,
        updatedAt: true,
      },
    });

    const response = okResponse(
      updatedVehicle,
      "Vehicle status updated successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getVehicleComplaints = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { vehicleId: id };
    if (status) where.status = status;

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        skip,
        take,
        include: {
          employee: { select: { id: true, name: true, employeeCode: true } },
          driver: { select: { id: true, name: true } },
          ride: { select: { id: true, rideDate: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.complaint.count({ where }),
    ]);

    const response = okResponse(
      {
        vehicleId: id,
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
      "Vehicle complaints retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
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