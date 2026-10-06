const { prisma } = require("../../../lib/prisma");
const { okResponse } = require("../../../constants/responses");

const getAllAuditLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const { model, action, userId, fromDate, toDate, search } = req.query;

    const where = {};

    if (model) {
      where.model = { equals: model, mode: "insensitive" };
    }

    if (action) {
      where.action = { equals: action, mode: "insensitive" };
    }

    if (userId) {
      where.userId = userId;
    }

    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) {
        where.createdAt.gte = new Date(fromDate);
      }
      if (toDate) {
        where.createdAt.lte = new Date(toDate);
      }
    }

    if (search) {
      where.OR = [
        { model: { contains: search, mode: "insensitive" } },
        { action: { contains: search, mode: "insensitive" } },
        { recordId: { contains: search, mode: "insensitive" } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditLog.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json(
      okResponse({
        logs,
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

module.exports = {
  getAllAuditLogs,
};
