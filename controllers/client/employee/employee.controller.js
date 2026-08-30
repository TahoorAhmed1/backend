const { prisma } = require("../../../lib/prisma");
const { getRecordById } = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");
const { hashPassword } = require("../../../services/auth.service");

const EMAIL_DOMAIN = "ibex.com";
const DEFAULT_PASSWORD = "12345678";

const createEmployee = async (req, res, next) => {
  try {
    const {
      employeeCode,
      name,
      contactNumber,
      cnic,
      gender,
      designation,
      departmentId,
      entity,
      officeLocation,
      areaId,
      subAreaId,
      blockId,
      address,
      serviceType,
      shiftTiming,
      status,
      role = "EMPLOYEE",
    } = req.body;

    // Auto-generate email from employeeCode
    const email = `${employeeCode}@${EMAIL_DOMAIN}`;

    // Check if user with this email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      const response = badRequestResponse(
        `User with email ${email} already exists.`,
      );
      return res.status(response.status.code).json(response);
    }

    const existingEmployee = await prisma.employee.findUnique({
      where: { employeeCode },
    });

    if (existingEmployee) {
      const response = badRequestResponse(
        "Employee with this code already exists.",
      );
      return res.status(response.status.code).json(response);
    }

    if (cnic) {
      const existingCnic = await prisma.employee.findUnique({
        where: { cnic },
      });
      if (existingCnic) {
        const response = badRequestResponse(
          "Employee with this CNIC already exists.",
        );
        return res.status(response.status.code).json(response);
      }
    }

    const employee = await prisma.$transaction(async (tx) => {
      // Create employee first
      const newEmployee = await tx.employee.create({
        data: {
          employeeCode,
          name,
          contactNumber,
          cnic,
          gender,
          designation,
          departmentId,
          entity,
          officeLocation,
          areaId,
          subAreaId,
          blockId,
          address,
          serviceType: serviceType || "PICK_AND_DROP",
          shiftTiming,
          status: status || "ACTIVE",
        },
      });

      // Always create user account with auto-generated email
      const hashedPassword = await hashPassword(DEFAULT_PASSWORD);

      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash: hashedPassword,
          role: role,
          isActive: true,
        },
      });

      // Link user to employee
      const updatedEmployee = await tx.employee.update({
        where: { id: newEmployee.id },
        data: { userId: user.id },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              isActive: true,
            },
          },
        },
      });

      return {
        ...updatedEmployee,
        defaultPassword: DEFAULT_PASSWORD, // Send password in response for admin to share
      };
    });

    const response = createSuccessResponse(
      employee,
      "Employee created successfully with user account.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

const getAllEmployees = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      areaId,
      departmentId,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    // Filters
    if (status) where.status = status;
    if (areaId) where.areaId = areaId;
    if (departmentId) where.departmentId = departmentId;

    // Search functionality
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { employeeCode: { contains: search, mode: "insensitive" } },
        { cnic: { contains: search, mode: "insensitive" } },
        { contactNumber: { contains: search, mode: "insensitive" } },
        { designation: { contains: search, mode: "insensitive" } },
      ];
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        skip,
        take,
        include: {
          department: { select: { id: true, name: true } },
          area: { select: { id: true, name: true } },
          subArea: { select: { id: true, name: true } },
          block: { select: { id: true, name: true } },
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              isActive: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.employee.count({ where }),
    ]);

    const response = okResponse(
      {
        data: employees,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Employees retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.employee, id, {
      department: true,
      area: true,
      subArea: true,
      block: true,
      user: {
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      weeklySchedules: {
        take: 10,
        orderBy: { weekStart: "desc" },
      },
      attendances: {
        take: 10,
        orderBy: { rideDate: "desc" },
      },
      complaints: {
        take: 10,
        orderBy: { createdAt: "desc" },
      },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateEmployee = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const { role: userRole, resetPassword, ...employeeData } = updateData;

    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!employee) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check employee code uniqueness
    if (
      employeeData.employeeCode &&
      employeeData.employeeCode !== employee.employeeCode
    ) {
      const existingCode = await prisma.employee.findUnique({
        where: { employeeCode: employeeData.employeeCode },
      });
      if (existingCode) {
        const errorResponse = badRequestResponse(
          "Employee code already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    // Check CNIC uniqueness
    if (employeeData.cnic && employeeData.cnic !== employee.cnic) {
      const existingCnic = await prisma.employee.findUnique({
        where: { cnic: employeeData.cnic },
      });
      if (existingCnic) {
        const errorResponse = badRequestResponse(
          "Employee with this CNIC already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Update employee data
      const updatedEmployee = await tx.employee.update({
        where: { id },
        data: employeeData,
        include: {
          user: true,
          department: true,
          area: true,
          subArea: true,
          block: true,
        },
      });

      // Handle user account updates
      if (employee.userId) {
        const userUpdateData = {};

        // Update name if employee name changed
        if (employeeData.name) userUpdateData.name = employeeData.name;

        // Update email if employeeCode changed
        if (employeeData.employeeCode) {
          userUpdateData.email = `${employeeData.employeeCode}@${EMAIL_DOMAIN}`;
        }

        // Update role if provided
        if (userRole) userUpdateData.role = userRole;

        // Reset password if requested
        if (resetPassword) {
          userUpdateData.passwordHash = await hashPassword(DEFAULT_PASSWORD);
        }

        if (Object.keys(userUpdateData).length > 0) {
          await tx.user.update({
            where: { id: employee.userId },
            data: userUpdateData,
          });
        }
      } else {
        // Create user if employee doesn't have one
        const email = `${updatedEmployee.employeeCode}@${EMAIL_DOMAIN}`;
        const hashedPassword = await hashPassword(DEFAULT_PASSWORD);

        const newUser = await tx.user.create({
          data: {
            email,
            name: updatedEmployee.name,
            passwordHash: hashedPassword,
            role: userRole || "EMPLOYEE",
            isActive: true,
          },
        });

        await tx.employee.update({
          where: { id },
          data: { userId: newUser.id },
        });
      }

      return updatedEmployee;
    });

    const response = okResponse(result, "Record updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteEmployee = async (req, res, next) => {
  try {
    const { id } = req.params;

    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!employee) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Prevent FK RESTRICT violations by checking for dependent records
    const ridePassengerCount = await prisma.ridePassenger.count({
      where: { employeeId: id },
    });
    const attendanceCount = await prisma.attendance.count({
      where: { employeeId: id },
    });
    const complaintCount = await prisma.complaint.count({
      where: { employeeId: id },
    });
    const weeklyScheduleCount = await prisma.weeklySchedule.count({
      where: { employeeId: id },
    });

    const blocking = [];
    if (ridePassengerCount > 0)
      blocking.push(`${ridePassengerCount} ride passenger(s)`);
    if (attendanceCount > 0)
      blocking.push(`${attendanceCount} attendance record(s)`);
    if (complaintCount > 0) blocking.push(`${complaintCount} complaint(s)`);
    if (weeklyScheduleCount > 0)
      blocking.push(`${weeklyScheduleCount} weekly schedule(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete employee: referenced by ${blocking.join(", ")}. Remove related records first.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Delete associated user if exists
      if (employee.userId) {
        // Delete device tokens first
        await tx.deviceToken.deleteMany({
          where: { userId: employee.userId },
        });

        // Delete notifications
        await tx.notification.deleteMany({
          where: { userId: employee.userId },
        });

        // Delete user
        await tx.user.delete({
          where: { id: employee.userId },
        });
      }

      // Delete employee
      await tx.employee.delete({ where: { id } });

      return employee;
    });

    const response = okResponse(
      result,
      "Employee and associated user deleted successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const employee = await prisma.employee.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!employee) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const [schedules, total] = await Promise.all([
      prisma.weeklySchedule.findMany({
        where: { employeeId: id },
        skip,
        take: parseInt(limit),
        include: {
          route: {
            select: { id: true, routeName: true, routeCode: true },
          },
          driver: {
            select: { id: true, name: true },
          },
          vehicle: {
            select: { id: true, vehicleNumber: true },
          },
        },
        orderBy: { weekStart: "desc" },
      }),
      prisma.weeklySchedule.count({ where: { employeeId: id } }),
    ]);

    const response = okResponse(
      {
        employee,
        schedules,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      },
      "Employee schedule retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status, fromDate, toDate } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { employeeId: id };
    if (status) where.status = status;
    if (fromDate || toDate) {
      where.rideDate = {};
      if (fromDate) where.rideDate.gte = new Date(fromDate);
      if (toDate) where.rideDate.lte = new Date(toDate);
    }

    const [attendanceRecords, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          ride: {
            select: {
              id: true,
              rideDate: true,
              route: {
                select: { routeName: true, routeCode: true },
              },
            },
          },
        },
        orderBy: { rideDate: "desc" },
      }),
      prisma.attendance.count({ where }),
    ]);

    const response = okResponse(
      {
        employeeId: id,
        records: attendanceRecords,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasNextPage: parseInt(page) < Math.ceil(total / parseInt(limit)),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Attendance records retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeComplaints = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { employeeId: id };
    if (status) where.status = status;

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          driver: { select: { id: true, name: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          ride: { select: { id: true, rideDate: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.complaint.count({ where }),
    ]);

    const response = okResponse(
      {
        employeeId: id,
        complaints,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      },
      "Complaints retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createEmployee,
  getAllEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  getEmployeeSchedule,
  getEmployeeAttendance,
  getEmployeeComplaints,
};
