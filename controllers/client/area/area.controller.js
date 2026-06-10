

const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse } = require("../../../constants/responses");

const createArea = async (req, res, next) => {
  try {
    const { name, city } = req.body;

    
    const existingArea = await prisma.area.findUnique({
      where: { name },
    });

    if (existingArea) {
      const response = badRequestResponse("Area with this name already exists.");
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.area, {
      name,
      city: city || "Karachi",
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllAreas = async (req, res, next) => {
  try {
    const { skip = 0, take = 10 } = req.query;

    const options = {
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        subAreas: true,
        employees: {
          select: { id: true, name: true },
        },
        routes: {
          select: { id: true, routeName: true },
        },
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.area, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAreaById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.area, id, {
      subAreas: true,
      employees: {
        select: { id: true, name: true, employeeCode: true },
      },
      routes: {
        select: { id: true, routeName: true, routeCode: true },
      },
      rides: {
        select: { id: true, rideDate: true },
      },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Area not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateArea = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, city } = req.body;

    
    const area = await prisma.area.findUnique({ where: { id } });
    if (!area) {
      const errorResponse = badRequestResponse("Area not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (name && name !== area.name) {
      const existingArea = await prisma.area.findUnique({
        where: { name },
      });
      if (existingArea) {
        const errorResponse = badRequestResponse(
          "Area with this name already exists."
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.area, id, {
      ...(name && { name }),
      ...(city && { city }),
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteArea = async (req, res, next) => {
  try {
    const { id } = req.params;

    
    const area = await prisma.area.findUnique({
      where: { id },
      include: { subAreas: true, employees: true, routes: true },
    });

    if (!area) {
      const errorResponse = badRequestResponse("Area not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (area.employees.length > 0 || area.routes.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete area with associated employees or routes."
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.area, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAreaStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const area = await prisma.area.findUnique({
      where: { id },
      include: {
        subAreas: {
          select: { id: true },
        },
        employees: {
          select: { id: true },
        },
        routes: {
          select: { id: true },
        },
        rides: {
          select: { id: true },
        },
      },
    });

    if (!area) {
      const errorResponse = badRequestResponse("Area not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const stats = {
      id: area.id,
      name: area.name,
      city: area.city,
      subAreaCount: area.subAreas.length,
      employeeCount: area.employees.length,
      routeCount: area.routes.length,
      rideCount: area.rides.length,
    };

    const { okResponse } = require("../../../../constants/responses");
    const response = okResponse(stats, "Area statistics retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createArea,
  getAllAreas,
  getAreaById,
  updateArea,
  deleteArea,
  getAreaStats,
};
