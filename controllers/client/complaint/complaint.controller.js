const { prisma } = require("../../../lib/prisma");

const { 
  badRequestResponse, 
  okResponse, 
  createSuccessResponse 
} = require("../../../constants/responses");

// ============================================================
// COMPLAINT CREATION
// ============================================================

const createComplaint = async (req, res, next) => {
  try {
    const {
      employeeId,
      driverId,
      vehicleId,
      rideId,
      category,
      title,
      description,
      status,
    } = req.body;

    // Validate required fields
    if (!title || !title.trim()) {
      const response = badRequestResponse("Complaint title is required.");
      return res.status(response.status.code).json(response);
    }

    if (!employeeId && !driverId && !vehicleId && !rideId) {
      const response = badRequestResponse(
        "At least one of employeeId, driverId, vehicleId, or rideId is required."
      );
      return res.status(response.status.code).json(response);
    }

    // Validate referenced entities
    if (employeeId) {
      const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) {
        const response = badRequestResponse("Employee not found.");
        return res.status(response.status.code).json(response);
      }
    }

    if (driverId) {
      const driver = await prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) {
        const response = badRequestResponse("Driver not found.");
        return res.status(response.status.code).json(response);
      }
    }

    if (vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!vehicle) {
        const response = badRequestResponse("Vehicle not found.");
        return res.status(response.status.code).json(response);
      }
    }

    if (rideId) {
      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      if (!ride) {
        const response = badRequestResponse("Ride not found.");
        return res.status(response.status.code).json(response);
      }
    }

    const complaint = await prisma.complaint.create({
      data: {
        employeeId: employeeId || null,
        driverId: driverId || null,
        vehicleId: vehicleId || null,
        rideId: rideId || null,
        category: category || "OTHER",
        title: title.trim(),
        description: description?.trim() || null,
        status: status || "OPEN",
      },
      include: {
        employee: { select: { id: true, name: true, employeeCode: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        ride: { select: { id: true, rideDate: true } },
      },
    });

    const response = createSuccessResponse(
      complaint,
      "Complaint created successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET ALL COMPLAINTS
// ============================================================

const getAllComplaints = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      category,
      employeeId,
      driverId,
      vehicleId,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

    const where = {};

    // Filters
    if (status) where.status = status;
    if (category) where.category = category;
    if (employeeId) where.employeeId = employeeId;
    if (driverId) where.driverId = driverId;
    if (vehicleId) where.vehicleId = vehicleId;

    // Search functionality
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { employee: { name: { contains: search, mode: "insensitive" } } },
        { driver: { name: { contains: search, mode: "insensitive" } } },
        { vehicle: { vehicleNumber: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
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
            } 
          },
          driver: { 
            select: { 
              id: true, 
              name: true, 
              phone: true,
            } 
          },
          vehicle: { 
            select: { 
              id: true, 
              vehicleNumber: true, 
              type: true,
            } 
          },
          ride: { 
            select: { 
              id: true, 
              rideDate: true,
              route: { select: { routeName: true } },
            } 
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.complaint.count({ where }),
    ]);

    console.log('JSON', JSON.stringify(complaints));
    const response = okResponse(
      {
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
      "Complaints retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET COMPLAINT BY ID
// ============================================================

const getComplaintById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const complaint = await prisma.complaint.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            contactNumber: true,
            designation: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
            licenseNumber: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
            type: true,
            make: true,
            model: true,
          },
        },
        ride: {
          include: {
            route: { select: { id: true, routeName: true, routeCode: true } },
            driver: { select: { id: true, name: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
      },
    });

    if (!complaint) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      complaint,
      "Complaint retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// UPDATE COMPLAINT
// ============================================================

const updateComplaint = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, resolution, title, description, category } = req.body;

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (resolution !== undefined) updateData.resolution = resolution;
    if (title) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description?.trim() || null;
    if (category) updateData.category = category;

    const updatedComplaint = await prisma.complaint.update({
      where: { id },
      data: updateData,
      include: {
        employee: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        ride: { select: { id: true, rideDate: true } },
      },
    });

    const response = okResponse(
      updatedComplaint,
      "Complaint updated successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// DELETE COMPLAINT
// ============================================================

const deleteComplaint = async (req, res, next) => {
  try {
    const { id } = req.params;

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const deletedComplaint = await prisma.complaint.delete({
      where: { id },
    });

    const response = okResponse(
      { id: deletedComplaint.id, title: deletedComplaint.title },
      "Complaint deleted successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// UPDATE COMPLAINT STATUS
// ============================================================

const updateComplaintStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, resolution } = req.body;

    const validStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"];
    if (!validStatuses.includes(status)) {
      const response = badRequestResponse("Invalid complaint status.");
      return res.status(response.status.code).json(response);
    }

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updateData = { status };
    if (resolution !== undefined) updateData.resolution = resolution;

    const updatedComplaint = await prisma.complaint.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        title: true,
        status: true,
        resolution: true,
        updatedAt: true,
      },
    });

    const response = okResponse(
      updatedComplaint,
      "Complaint status updated successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET COMPLAINTS BY CATEGORY
// ============================================================

const getComplaintsByCategory = async (req, res, next) => {
  try {
    const { category } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const validCategories = [
      "DRIVER_BEHAVIOUR",
      "VEHICLE_CONDITION",
      "ROUTE_ISSUE",
      "TIMING_DELAY",
      "SCHEDULING",
      "OTHER",
    ];

    if (!validCategories.includes(category)) {
      const response = badRequestResponse("Invalid complaint category.");
      return res.status(response.status.code).json(response);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { category };

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        skip,
        take,
        include: {
          employee: { select: { id: true, name: true } },
          driver: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.complaint.count({ where }),
    ]);

    const response = okResponse(
      {
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
      "Complaints retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET COMPLAINT STATS
// ============================================================

const getComplaintStats = async (req, res, next) => {
  try {
    const [totalComplaints, statusStats, categoryStats] = await Promise.all([
      prisma.complaint.count(),
      prisma.complaint.groupBy({
        by: ["status"],
        _count: { status: true },
      }),
      prisma.complaint.groupBy({
        by: ["category"],
        _count: { category: true },
      }),
    ]);

    const stats = {
      total: totalComplaints,
      byStatus: statusStats.map((s) => ({
        status: s.status,
        count: s._count.status,
      })),
      byCategory: categoryStats.map((c) => ({
        category: c.category,
        count: c._count.category,
      })),
    };

    const response = okResponse(
      stats,
      "Complaint statistics retrieved successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

module.exports = {
  createComplaint,
  getAllComplaints,
  getComplaintById,
  updateComplaint,
  deleteComplaint,
  updateComplaintStatus,
  getComplaintsByCategory,
  getComplaintStats,
};