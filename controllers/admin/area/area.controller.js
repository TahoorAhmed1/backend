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

const createArea = async (req, res, next) => {
  try {
    const { name, city } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      const response = badRequestResponse("Area name is required.");
      return res.status(response.status.code).json(response);
    }

    const trimmedName = name.trim();

    const existingArea = await prisma.area.findUnique({
      where: { name: trimmedName },
    });

    if (existingArea) {
      const response = badRequestResponse(
        "Area with this name already exists.",
      );
      return res.status(response.status.code).json(response);
    }

    const area = await prisma.area.create({
      data: {
        name: trimmedName,
        city: city?.trim() || "Karachi",
      },
    });

    const response = createSuccessResponse(area, "Area created successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

const getAllAreas = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      city,
      sortBy = "createdAt",
      sortOrder = "desc",
      // For dropdown/select usage - return all matching areas without pagination
      all = false,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    // Search functionality - search across name and city
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
        // Optionally search by area ID if search term looks like an ID
        ...(search.length === 24 || search.length === 36
          ? [{ id: search }]
          : []),
      ];
    }

    // City filter
    if (city) {
      where.city = { equals: city, mode: "insensitive" };
    }

    // For dropdown/select (all=true), only return id and name
    if (all) {
      const [areas, total] = await Promise.all([
        prisma.area.findMany({
          where,
          take: 100, // Limit to 100 for dropdown
          select: {
            id: true,
            name: true,
            city: true, // add this
            subAreas: {
              select: {
                id: true,
                name: true,
                blocks: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
        }),
        prisma.area.count({ where }),
      ]);

      const response = okResponse(areas, "Areas retrieved successfully.");
      return res.status(response.status.code).json(response);
    }

    // Full response with pagination, counts, and nested data
    const selectFields = {
      id: true,
      name: true,
      city: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          subAreas: true,
          employees: true,
          routes: true,
          rides: true,
        },
      },
      subAreas: {
        select: {
          id: true,
          name: true,
          _count: {
            select: { blocks: true },
          },
          blocks: {
            select: {
              id: true,
              name: true,
              _count: {
                select: { employees: true },
              },
            },
          },
        },
      },
    };

    const [areas, total] = await Promise.all([
      prisma.area.findMany({
        where,
        skip,
        take,
        select: selectFields,
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.area.count({ where }),
    ]);

    const areasWithCounts = areas.map((area) => ({
      id: area.id,
      name: area.name,
      city: area.city,
      createdAt: area.createdAt,
      updatedAt: area.updatedAt,
      subAreaCount: area._count.subAreas,
      employeeCount: area._count.employees,
      routeCount: area._count.routes,
      rideCount: area._count.rides,
      subAreas: area.subAreas.map((subArea) => ({
        id: subArea.id,
        name: subArea.name,
        blockCount: subArea._count.blocks,
        blocks: subArea.blocks.map((block) => ({
          id: block.id,
          name: block.name,
          employeeCount: block._count.employees,
        })),
      })),
      _count: undefined,
    }));

    const response = okResponse(
      {
        areas: areasWithCounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
        filters: {
          search: search || null,
          city: city || null,
        },
      },
      "Areas retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

const getAreaById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const area = await prisma.area.findUnique({
      where: { id },
      include: {
        subAreas: {
          include: {
            blocks: {
              select: {
                id: true,
                name: true,
                _count: {
                  select: { employees: true },
                },
              },
            },
            _count: {
              select: {
                blocks: true,
                employees: true,
              },
            },
          },
        },
        employees: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            designation: true,
          },
        },
        routes: {
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            status: true,
          },
        },
        rides: {
          take: 10,
          orderBy: { rideDate: "desc" },
          select: {
            id: true,
            rideDate: true,
            status: true,
          },
        },
        _count: {
          select: {
            subAreas: true,
            employees: true,
            routes: true,
            rides: true,
          },
        },
      },
    });

    if (!area) {
      const errorResponse = badRequestResponse("Area not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const areaWithCounts = {
      ...area,
      subAreaCount: area._count.subAreas,
      employeeCount: area._count.employees,
      routeCount: area._count.routes,
      rideCount: area._count.rides,
      subAreas: area.subAreas.map((subArea) => ({
        ...subArea,
        blockCount: subArea._count.blocks,
        employeeCount: subArea._count.employees,
        blocks: subArea.blocks.map((block) => ({
          ...block,
          employeeCount: block._count.employees,
          _count: undefined,
        })),
        _count: undefined,
      })),
      _count: undefined,
    };

    const response = okResponse(areaWithCounts, "Area retrieved successfully.");

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
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

    // Check name uniqueness
    if (name && name.trim() !== area.name) {
      const trimmedName = name.trim();
      const existingArea = await prisma.area.findUnique({
        where: { name: trimmedName },
      });
      if (existingArea) {
        const errorResponse = badRequestResponse(
          "Area with this name already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const updateData = {};
    if (name) updateData.name = name.trim();
    if (city) updateData.city = city.trim();

    const updatedArea = await prisma.area.update({
      where: { id },
      data: updateData,
      include: {
        _count: {
          select: {
            subAreas: true,
            employees: true,
            routes: true,
          },
        },
      },
    });

    const areaWithCounts = {
      ...updatedArea,
      subAreaCount: updatedArea._count.subAreas,
      employeeCount: updatedArea._count.employees,
      routeCount: updatedArea._count.routes,
      _count: undefined,
    };

    const response = okResponse(areaWithCounts, "Area updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

const deleteArea = async (req, res, next) => {
  try {
    const { id } = req.params;

    const area = await prisma.area.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            subAreas: true,
            employees: true,
            routes: true,
            rides: true,
          },
        },
      },
    });

    if (!area) {
      const errorResponse = badRequestResponse("Area not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check for dependent records
    const blocking = [];
    if (area._count.subAreas > 0)
      blocking.push(`${area._count.subAreas} sub-area(s)`);
    if (area._count.employees > 0)
      blocking.push(`${area._count.employees} employee(s)`);
    if (area._count.routes > 0) blocking.push(`${area._count.routes} route(s)`);
    if (area._count.rides > 0) blocking.push(`${area._count.rides} ride(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete area: referenced by ${blocking.join(", ")}. Remove related records first.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const deletedArea = await prisma.area.delete({
      where: { id },
    });

    const response = okResponse(
      { id: deletedArea.id, name: deletedArea.name },
      "Area deleted successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
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
        _count: {
          select: {
            subAreas: true,
            employees: true,
            routes: true,
            rides: true,
          },
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
      subAreaCount: area._count.subAreas,
      employeeCount: area._count.employees,
      routeCount: area._count.routes,
      rideCount: area._count.rides,
      createdAt: area.createdAt,
      updatedAt: area.updatedAt,
    };

    const response = okResponse(
      stats,
      "Area statistics retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
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
