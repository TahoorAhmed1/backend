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
  createSuccessResponse,
} = require("../../../constants/responses");

// ============================================================
// TIME FORMATTING HELPERS
// ============================================================

function formatTimeForResponse(value) {
  if (!value) return null;
  
  if (typeof value === 'string' && !value.includes('T') && !value.includes('-')) {
    return value;
  }
  
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Karachi'
      });
    }
  } catch (e) {
    // ignore
  }
  
  return String(value);
}

function formatDateForResponse(value) {
  if (!value) return null;
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    }
  } catch (e) {
    // ignore
  }
  return String(value);
}

// ============================================================
// RIDE CREATION
// ============================================================

const createRide = async (req, res, next) => {
  try {
    const {
      rideDate,
      routeId,
      driverId,
      vehicleId,
      vendorId,
      areaId,
      subAreaId,
      tripId,
      pickupTime,
      officeArrivalTime,
      dropTime,
      status,
    } = req.body;

    // Validate required fields
    if (!rideDate) {
      const response = badRequestResponse("Ride date is required.");
      return res.status(response.status.code).json(response);
    }

    if (!routeId) {
      const response = badRequestResponse("Route is required.");
      return res.status(response.status.code).json(response);
    }

    // Validate route exists
    const route = await prisma.route.findUnique({ where: { id: routeId } });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    // Validate driver if provided
    if (driverId) {
      const driver = await prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) {
        const response = badRequestResponse("Driver not found.");
        return res.status(response.status.code).json(response);
      }
    }

    // Validate vehicle if provided
    if (vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!vehicle) {
        const response = badRequestResponse("Vehicle not found.");
        return res.status(response.status.code).json(response);
      }
    }

    const ride = await prisma.ride.create({
      data: {
        rideDate: new Date(rideDate),
        routeId,
        driverId: driverId || null,
        vehicleId: vehicleId || null,
        vendorId: vendorId || null,
        areaId: areaId || null,
        subAreaId: subAreaId || null,
        tripId: tripId || null,
        pickupTime: pickupTime ? new Date(pickupTime) : null,
        officeArrivalTime: officeArrivalTime ? new Date(officeArrivalTime) : null,
        dropTime: dropTime ? new Date(dropTime) : null,
        status: status || "PENDING",
      },
      include: {
        route: { select: { id: true, routeName: true, routeCode: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        vendor: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
      },
    });

    const response = createSuccessResponse(
      {
        ...ride,
        rideDate: formatDateForResponse(ride.rideDate),
        pickupTime: formatTimeForResponse(ride.pickupTime),
        officeArrivalTime: formatTimeForResponse(ride.officeArrivalTime),
        dropTime: formatTimeForResponse(ride.dropTime),
      },
      "Ride created successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET ALL RIDES
// ============================================================

const getAllRides = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      routeId,
      driverId,
      vehicleId,
      search,
      fromDate,
      toDate,
      sortBy = "rideDate",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

    const where = {};

    // Filters
    if (status) where.status = status;
    if (routeId) where.routeId = routeId;
    if (driverId) where.driverId = driverId;
    if (vehicleId) where.vehicleId = vehicleId;

    // Date range filter
    if (fromDate || toDate) {
      where.rideDate = {};
      if (fromDate) where.rideDate.gte = new Date(fromDate);
      if (toDate) where.rideDate.lte = new Date(toDate);
    }

    // Search functionality
    if (search) {
      where.OR = [
        { route: { routeName: { contains: search, mode: "insensitive" } } },
        { route: { routeCode: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        { vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        skip,
        take,
        include: {
          route: {
            select: { id: true, routeName: true, routeCode: true },
          },
          driver: {
            select: { id: true, name: true, phone: true },
          },
          vehicle: {
            select: { id: true, vehicleNumber: true, type: true },
          },
          vendor: {
            select: { id: true, name: true },
          },
          area: {
            select: { id: true, name: true },
          },
          subArea: {
            select: { id: true, name: true },
          },
          _count: {
            select: {
              passengers: true,
              attendances: true,
              complaints: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.ride.count({ where }),
    ]);

    // Format rides with counts
    const formattedRides = rides.map((ride) => ({
      ...ride,
      rideDate: formatDateForResponse(ride.rideDate),
      pickupTime: formatTimeForResponse(ride.pickupTime),
      officeArrivalTime: formatTimeForResponse(ride.officeArrivalTime),
      dropTime: formatTimeForResponse(ride.dropTime),
      passengerCount: ride._count.passengers,
      attendanceCount: ride._count.attendances,
      complaintCount: ride._count.complaints,
      _count: undefined,
    }));

    const response = okResponse(
      {
        rides: formattedRides,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Rides retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET RIDE BY ID
// ============================================================

const getRideById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        route: true,
        driver: true,
        vehicle: true,
        vendor: true,
        area: true,
        subArea: true,
        trip: true,
        passengers: {
          include: {
            employee: { 
              select: { 
                id: true, 
                name: true, 
                employeeCode: true,
                contactNumber: true,
              } 
            },
          },
        },
        attendances: {
          include: {
            employee: { select: { id: true, name: true } },
          },
        },
        complaints: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            passengers: true,
            attendances: true,
            complaints: true,
          },
        },
      },
    });

    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const formattedRide = {
      ...ride,
      rideDate: formatDateForResponse(ride.rideDate),
      pickupTime: formatTimeForResponse(ride.pickupTime),
      officeArrivalTime: formatTimeForResponse(ride.officeArrivalTime),
      dropTime: formatTimeForResponse(ride.dropTime),
      passengerCount: ride._count.passengers,
      attendanceCount: ride._count.attendances,
      complaintCount: ride._count.complaints,
      _count: undefined,
    };

    const response = okResponse(
      formattedRide,
      "Ride retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// UPDATE RIDE
// ============================================================

const updateRide = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Convert dates if provided
    const dataToUpdate = { ...updateData };
    if (dataToUpdate.rideDate) dataToUpdate.rideDate = new Date(dataToUpdate.rideDate);
    if (dataToUpdate.pickupTime) dataToUpdate.pickupTime = new Date(dataToUpdate.pickupTime);
    if (dataToUpdate.officeArrivalTime) dataToUpdate.officeArrivalTime = new Date(dataToUpdate.officeArrivalTime);
    if (dataToUpdate.dropTime) dataToUpdate.dropTime = new Date(dataToUpdate.dropTime);

    const updatedRide = await prisma.ride.update({
      where: { id },
      data: dataToUpdate,
      include: {
        route: { select: { id: true, routeName: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    const response = okResponse(
      {
        ...updatedRide,
        rideDate: formatDateForResponse(updatedRide.rideDate),
        pickupTime: formatTimeForResponse(updatedRide.pickupTime),
        officeArrivalTime: formatTimeForResponse(updatedRide.officeArrivalTime),
        dropTime: formatTimeForResponse(updatedRide.dropTime),
      },
      "Ride updated successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// DELETE RIDE
// ============================================================

const deleteRide = async (req, res, next) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            passengers: true,
            attendances: true,
            complaints: true,
          },
        },
      },
    });

    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const blocking = [];
    if (ride._count.passengers > 0) blocking.push(`${ride._count.passengers} passenger(s)`);
    if (ride._count.attendances > 0) blocking.push(`${ride._count.attendances} attendance record(s)`);
    if (ride._count.complaints > 0) blocking.push(`${ride._count.complaints} complaint(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete ride: referenced by ${blocking.join(", ")}. Remove related records first.`
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const deletedRide = await prisma.ride.delete({
      where: { id },
    });

    const response = okResponse(
      { id: deletedRide.id, rideDate: deletedRide.rideDate },
      "Ride deleted successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// ADD PASSENGERS TO RIDE
// ============================================================

const addPassengersToRide = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { passengers } = req.body;

    if (!Array.isArray(passengers) || passengers.length === 0) {
      const response = badRequestResponse("Passengers array is required.");
      return res.status(response.status.code).json(response);
    }

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      const response = badRequestResponse("Ride not found.");
      return res.status(response.status.code).json(response);
    }

    // Validate all employees exist
    const employeeIds = passengers.map((p) => p.employeeId);
    const employees = await prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, name: true, employeeCode: true },
    });

    const employeeMap = new Map(employees.map((e) => [e.id, e]));

    const createdPassengers = await prisma.$transaction(
      passengers.map((passenger) => {
        const employee = employeeMap.get(passenger.employeeId);
        return prisma.ridePassenger.create({
          data: {
            rideId: id,
            employeeId: passenger.employeeId,
            employeeName: employee?.name || null,
            address: passenger.address || null,
            contact: passenger.contact || employee?.contactNumber || null,
            area: passenger.area || null,
            subArea: passenger.subArea || null,
          },
          include: {
            employee: { select: { id: true, name: true, employeeCode: true } },
          },
        });
      })
    );

    const response = createSuccessResponse(
      createdPassengers,
      `${createdPassengers.length} passengers added to ride.`,
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// UPDATE RIDE STATUS
// ============================================================

const updateRideStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["PENDING", "STARTED", "ARRIVED", "COMPLETED", "CANCELLED"];
    if (!validStatuses.includes(status)) {
      const response = badRequestResponse("Invalid ride status.");
      return res.status(response.status.code).json(response);
    }

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updatedRide = await prisma.ride.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        rideDate: true,
        status: true,
        updatedAt: true,
      },
    });

    const response = okResponse(
      {
        ...updatedRide,
        rideDate: formatDateForResponse(updatedRide.rideDate),
      },
      "Ride status updated successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET RIDE PASSENGERS
// ============================================================

const getRidePassengers = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, search } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { rideId: id };
    if (search) {
      where.OR = [
        { employeeName: { contains: search, mode: "insensitive" } },
        { employee: { name: { contains: search, mode: "insensitive" } } },
        { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [passengers, total] = await Promise.all([
      prisma.ridePassenger.findMany({
        where,
        skip,
        take,
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeCode: true,
              contactNumber: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.ridePassenger.count({ where }),
    ]);

    const response = okResponse(
      {
        rideId: id,
        passengers,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Ride passengers retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

module.exports = {
  createRide,
  getAllRides,
  getRideById,
  updateRide,
  deleteRide,
  addPassengersToRide,
  updateRideStatus,
  getRidePassengers,
};