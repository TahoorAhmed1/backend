const { prisma } = require("../../../lib/prisma");
const {
  okResponse,
  badRequestResponse,
  updateSuccessResponse,
  deleteSuccessResponse,
} = require("../../../constants/responses");

const getAllExceptions = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const { weekStart, employeeCode, resolved, search } = req.query;

    const where = {};

    if (resolved !== undefined && resolved !== "") {
      where.resolved = resolved === "true" || resolved === true;
    } else {
      where.resolved = false; // Default to unresolved exceptions
    }

    if (employeeCode) {
      where.employeeCode = { contains: employeeCode, mode: "insensitive" };
    }

    if (weekStart) {
      where.weekStart = new Date(weekStart);
    }

    if (search) {
      where.OR = [
        { employeeCode: { contains: search, mode: "insensitive" } },
        { reason: { contains: search, mode: "insensitive" } },
      ];
    }

    const [exceptions, total] = await Promise.all([
      prisma.scheduleException.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.scheduleException.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json(
      okResponse({
        exceptions,
        pagination: {
          total,
          page,
          limit,
          totalPages,
        },
      })
    );
  } catch (error) {
    next(error);
  }
};

const resolveException = async (req, res, next) => {
  try {
    const { id } = req.params;

    const exception = await prisma.scheduleException.update({
      where: { id },
      data: { resolved: true },
    });

    return res
      .status(200)
      .json(updateSuccessResponse(exception, "Schedule exception marked as resolved."));
  } catch (error) {
    if (error.code === "P2025") {
      const response = badRequestResponse("Schedule exception not found.");
      return res.status(response.status.code).json(response);
    }
    next(error);
  }
};

const deleteException = async (req, res, next) => {
  try {
    const { id } = req.params;

    await prisma.scheduleException.delete({
      where: { id },
    });

    return res
      .status(200)
      .json(deleteSuccessResponse("Schedule exception deleted successfully."));
  } catch (error) {
    if (error.code === "P2025") {
      const response = badRequestResponse("Schedule exception not found.");
      return res.status(response.status.code).json(response);
    }
    next(error);
  }
};

module.exports = {
  getAllExceptions,
  resolveException,
  deleteException,
};
