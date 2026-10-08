const { prisma } = require("../../../lib/prisma");
const {
  okResponse,
  badRequestResponse,
  updateSuccessResponse,
  serverErrorResponse,
} = require("../../../constants/responses");
const { hashPassword } = require("../../../services/auth.service");

const getAllUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const { role, isActive, search } = req.query;

    const where = {};

    if (role) {
      where.role = role.toUpperCase();
    }

    if (isActive !== undefined && isActive !== "") {
      where.isActive = isActive === "true" || isActive === true;
    }

    if (search) {
      where.OR = [
        { email: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          qrCode: true,
          createdAt: true,
          updatedAt: true,
          employee: {
            select: {
              id: true,
              employeeCode: true,
              name: true,
              status: true,
              department: { select: { id: true, name: true } },
              area: { select: { id: true, name: true } },
            },
          },
          driver: {
            select: {
              id: true,
              name: true,
              status: true,
              licenseNumber: true,
              vendor: { select: { id: true, name: true } },
              vehicle: { select: { id: true, vehicleNumber: true } },
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json(
      okResponse({
        users,
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

const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        qrCode: true,
        createdAt: true,
        updatedAt: true,
        employee: {
          include: {
            department: true,
            area: true,
            subArea: true,
            block: true,
          },
        },
        driver: {
          include: {
            vendor: true,
            vehicle: true,
          },
        },
      },
    });

    if (!user) {
      const response = badRequestResponse("User not found.");
      return res.status(response.status.code).json(response);
    }

    return res.status(200).json(okResponse(user));
  } catch (error) {
    next(error);
  }
};

const updateUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ["ADMIN", "MANAGER", "DISPATCHER", "DRIVER", "EMPLOYEE"];
    if (!role || !validRoles.includes(role.toUpperCase())) {
      const response = badRequestResponse(
        `Invalid role. Must be one of: ${validRoles.join(", ")}`
      );
      return res.status(response.status.code).json(response);
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role: role.toUpperCase() },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return res
      .status(200)
      .json(updateSuccessResponse(updatedUser, "User role updated successfully."));
  } catch (error) {
    if (error.code === "P2025") {
      const response = badRequestResponse("User not found.");
      return res.status(response.status.code).json(response);
    }
    next(error);
  }
};

const updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      const response = badRequestResponse("isActive must be a boolean.");
      return res.status(response.status.code).json(response);
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { isActive },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return res
      .status(200)
      .json(
        updateSuccessResponse(
          updatedUser,
          `User ${isActive ? "activated" : "deactivated"} successfully.`
        )
      );
  } catch (error) {
    if (error.code === "P2025") {
      const response = badRequestResponse("User not found.");
      return res.status(response.status.code).json(response);
    }
    next(error);
  }
};

const resetUserPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (typeof password !== "string" || password.length < 6) {
      const response = badRequestResponse(
        "Password must be a string with at least 6 characters."
      );
      return res.status(response.status.code).json(response);
    }

    const passwordHash = await hashPassword(password);

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { passwordHash },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    return res.status(200).json(
      updateSuccessResponse(
        {
          userId: updatedUser.id,
          email: updatedUser.email,
        },
        "Password updated successfully."
      )
    );
  } catch (error) {
    if (error.code === "P2025") {
      const response = badRequestResponse("User not found.");
      return res.status(response.status.code).json(response);
    }
    next(error);
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  updateUserRole,
  updateUserStatus,
  resetUserPassword,
};
