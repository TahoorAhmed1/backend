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
} = require("../../../constants/responses");

// ============================================================
// TIME FORMATTING HELPERS
// ============================================================

function formatTimeForResponse(value) {
  if (!value) return null;
  
  // If it's already a clean time string like "6:00 PM"
  if (typeof value === 'string' && !value.includes('T') && !value.includes('-')) {
    return value;
  }
  
  // If it's a Date object or ISO string
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      // Check if it's the dummy 1970-01-01 date
      if (date.getFullYear() === 1970 && date.getMonth() === 0 && date.getDate() === 1) {
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'Asia/Karachi'
        });
      }
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

// Format date for display
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

const createRide = async (req, res, next) => {
  try {
    const {
      rideDate,
      routeId,
      driverId,
      vehicleId,
      vendorId,
      areaId,
      pickupTime,
      officeArrivalTime,
      dropTime,
      employeeId,
      status,
    } = req.body;

    const route = await prisma.route.findUnique({ where: { id: routeId } });
    if (!route) {
      const response = badRequestResponse("Route not found.");
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.ride, {
      rideDate,
      routeId,
      driverId,
      vehicleId,
      vendorId,
      areaId,
      pickupTime,
      officeArrivalTime,
      dropTime,
      employeeId,
      status: status || "PENDING",
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllRides = async (req, res, next) => {
  try {
    const {
      skip = 0,
      take = 200,
      status,
      routeId,
      driverId,
    } = req.query;

    const where = {};

    if (status) where.status = status;
    if (routeId) where.routeId = routeId;
    if (driverId) where.driverId = driverId;

    const options = {
      where,
      // skip: Math.max(0, parseInt(skip, 10) || 0),
      // take: Math.max(1, parseInt(take, 10) || 10),

      include: {
        route: {
          select: {
            id: true,
            routeName: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
          },
        },
        vendor: {
          select: {
            id: true,
            name: true,
          },
        },
        area: {
          select: {
            id: true,
            name: true,
          },
        },
        passengers: true,
      },

      orderBy: {
        rideDate: "desc",
      },
    };

    const response = await getRecords(prisma.ride, options);

    // ✅ Format times and dates in the response
    if (response.data && Array.isArray(response.data)) {
      response.data = response.data.map((ride) => ({
        ...ride,
        rideDate: formatDateForResponse(ride.rideDate),
        pickupTime: formatTimeForResponse(ride.pickupTime),
        officeArrivalTime: formatTimeForResponse(ride.officeArrivalTime),
        dropTime: formatTimeForResponse(ride.dropTime),
      }));
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRideById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.ride, id, {
      route: true,
      driver: true,
      vehicle: true,
      vendor: true,
      area: true,
      passengers: {
        include: {
          employee: { select: { id: true, name: true, employeeCode: true } },
        },
      },
      attendances: true,
      complaints: true,
    });

    if (!response) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // ✅ Format times in the response
    if (response.data) {
      response.data.rideDate = formatDateForResponse(response.data.rideDate);
      response.data.pickupTime = formatTimeForResponse(response.data.pickupTime);
      response.data.officeArrivalTime = formatTimeForResponse(response.data.officeArrivalTime);
      response.data.dropTime = formatTimeForResponse(response.data.dropTime);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateRide = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await updateRecord(prisma.ride, id, updateData, {
      route: true,
      driver: true,
      vehicle: true,
    });

    // ✅ Format times in the response
    if (response.data) {
      response.data.rideDate = formatDateForResponse(response.data.rideDate);
      response.data.pickupTime = formatTimeForResponse(response.data.pickupTime);
      response.data.officeArrivalTime = formatTimeForResponse(response.data.officeArrivalTime);
      response.data.dropTime = formatTimeForResponse(response.data.dropTime);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteRide = async (req, res, next) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: { passengers: true, attendances: true },
    });

    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (ride.passengers.length > 0 || ride.attendances.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete ride with passengers or attendance records.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.ride, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const addPassengersToRide = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { passengers } = req.body;

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      const response = badRequestResponse("Ride not found.");
      return res.status(response.status.code).json(response);
    }

    const createdPassengers = await Promise.all(
      passengers.map((passenger) =>
        prisma.ridePassenger.create({
          data: {
            rideId: id,
            employeeId: passenger.employeeId,
            address: passenger.address,
            contact: passenger.contact,
          },
          include: {
            employee: { select: { id: true, name: true } },
          },
        }),
      ),
    );

    const { createSuccessResponse } = require("../../../constants/responses");
    const response = createSuccessResponse(
      createdPassengers,
      `${createdPassengers.length} passengers added to ride.`,
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateRideStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = [
      "PENDING",
      "STARTED",
      "ARRIVED",
      "COMPLETED",
      "CANCELLED",
    ];
    if (!validStatuses.includes(status)) {
      const response = badRequestResponse("Invalid ride status.");
      return res.status(response.status.code).json(response);
    }

    const response = await updateRecord(prisma.ride, id, { status });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRidePassengers = async (req, res, next) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        passengers: {
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
        },
      },
    });

    if (!ride) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        rideId: ride.id,
        passengers: ride.passengers,
      },
      "Ride passengers retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
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