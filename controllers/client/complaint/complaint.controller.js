

const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse, okResponse } = require("../../../constants/responses");

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

    
    if (!employeeId && !driverId && !vehicleId) {
      const response = badRequestResponse(
        "At least one of employeeId, driverId, or vehicleId is required."
      );
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.complaint, {
      employeeId,
      driverId,
      vehicleId,
      rideId,
      category: category || "OTHER",
      title,
      description,
      status: status || "OPEN",
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllComplaints = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status, category, employeeId, driverId } =
      req.query;

    const where = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (employeeId) where.employeeId = employeeId;
    if (driverId) where.driverId = driverId;

    const options = {
      where,
  
      include: {
        employee: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        ride: { select: { id: true, rideDate: true } },
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.complaint, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getComplaintById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.complaint, id, {
      employee: true,
      driver: true,
      vehicle: true,
      ride: {
        include: {
          route: { select: { id: true, routeName: true } },
        },
      },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateComplaint = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, category, status, resolution } = req.body;

    
    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updateData = {};
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (category) updateData.category = category;
    if (status) updateData.status = status;
    if (resolution !== undefined) updateData.resolution = resolution;

    const response = await updateRecord(prisma.complaint, id, updateData, {
      employee: true,
      driver: true,
      vehicle: true,
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteComplaint = async (req, res, next) => {
  try {
    const { id } = req.params;

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.complaint, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateComplaintStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, resolution } = req.body;

    const validStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"];
    if (!validStatuses.includes(status)) {
      const response = badRequestResponse("Invalid complaint status.");
      return res.status(response.status.code).json(response);
    }

    const updateData = { status };
    if (resolution) updateData.resolution = resolution;

    const response = await updateRecord(prisma.complaint, id, updateData);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getComplaintsByCategory = async (req, res, next) => {
  try {
    const { category } = req.params;
    const { skip = 0, take = 10 } = req.query;

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

    const options = {
      where: { category },
  
      include: {
        employee: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.complaint, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getComplaintStats = async (req, res, next) => {
  try {
    const totalComplaints = await prisma.complaint.count();
    const statusStats = await prisma.complaint.groupBy({
      by: ["status"],
      _count: true,
    });
    const categoryStats = await prisma.complaint.groupBy({
      by: ["category"],
      _count: true,
    });

    const stats = {
      total: totalComplaints,
      byStatus: statusStats.map((s) => ({
        status: s.status,
        count: s._count,
      })),
      byCategory: categoryStats.map((c) => ({
        category: c.category,
        count: c._count,
      })),
    };

    const response = okResponse(stats, "Complaint statistics retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
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
