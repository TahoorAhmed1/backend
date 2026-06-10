

const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse, okResponse } = require("../../../constants/responses");

const createRoute = async (req, res, next) => {
  try {
    const {
      routeCode,
      routeName,
      areaId,
      subAreaId,
      officeLocation,
      serviceType,
      maxCapacity,
      shiftTiming,
      pickupStartTime,
      dropTime,
      driverId,
      status,
    } = req.body;

    
    const existingRoute = await prisma.route.findUnique({
      where: { routeCode },
    });

    if (existingRoute) {
      const response = badRequestResponse(
        "Route with this code already exists."
      );
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.route, {
      routeCode,
      routeName,
      areaId,
      subAreaId,
      officeLocation,
      serviceType: serviceType || "PICK_AND_DROP",
      maxCapacity,
      shiftTiming,
      pickupStartTime,
      dropTime,
      driverId,
      status: status || "ACTIVE",
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllRoutes = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status, areaId, serviceType } = req.query;

    const where = {};
    if (status) where.status = status;
    if (areaId) where.areaId = areaId;
    if (serviceType) where.serviceType = serviceType;

    const options = {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        area: { select: { id: true, name: true } },
        subArea: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        weeklySchedules: true,
        rides: true,
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.route, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRouteById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.route, id, {
      area: true,
      subArea: true,
      driver: true,
      weeklySchedules: {
        include: {
          employee: { select: { id: true, name: true, employeeCode: true } },
        },
      },
      rides: {
        include: {
          driver: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          passengers: true,
        },
      },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Route not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateRoute = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    
    const route = await prisma.route.findUnique({ where: { id } });
    if (!route) {
      const errorResponse = badRequestResponse("Route not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (updateData.routeCode && updateData.routeCode !== route.routeCode) {
      const existingCode = await prisma.route.findUnique({
        where: { routeCode: updateData.routeCode },
      });
      if (existingCode) {
        const errorResponse = badRequestResponse("Route code already exists.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.route, id, updateData, {
      area: true,
      subArea: true,
      driver: true,
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteRoute = async (req, res, next) => {
  try {
    const { id } = req.params;

    
    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        weeklySchedules: true,
        rides: true,
      },
    });

    if (!route) {
      const errorResponse = badRequestResponse("Route not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (route.weeklySchedules.length > 0 || route.rides.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete route with active schedules or rides."
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.route, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRouteEmployees = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        weeklySchedules: {
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

    if (!route) {
      const errorResponse = badRequestResponse("Route not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        routeId: route.id,
        routeName: route.routeName,
        employees: route.weeklySchedules.map((schedule) => ({
          ...schedule.employee,
          schedule,
        })),
      },
      "Route employees retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRouteRides = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { skip = 0, take = 10, status } = req.query;

    const where = { routeId: id };
    if (status) where.status = status;

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(take),
        include: {
          driver: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          passengers: true,
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.ride.count({ where }),
    ]);

    const response = okResponse(
      {
        routeId: id,
        rides,
        pagination: {
          total,
          limit: parseInt(take),
          offset: parseInt(skip),
        },
      },
      "Route rides retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRouteStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const route = await prisma.route.findUnique({
      where: { id },
      include: {
        weeklySchedules: { select: { id: true } },
        rides: { select: { id: true } },
        driver: { select: { id: true } },
      },
    });

    if (!route) {
      const errorResponse = badRequestResponse("Route not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const stats = {
      id: route.id,
      routeCode: route.routeCode,
      routeName: route.routeName,
      maxCapacity: route.maxCapacity,
      employeeCount: route.weeklySchedules.length,
      totalRides: route.rides.length,
      assignedDriver: route.driver ? route.driver.id : null,
      status: route.status,
    };

    const response = okResponse(
      stats,
      "Route statistics retrieved successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createRoute,
  getAllRoutes,
  getRouteById,
  updateRoute,
  deleteRoute,
  getRouteEmployees,
  getRouteRides,
  getRouteStats,
};
