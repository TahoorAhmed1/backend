

const { prisma } = require("../../../lib/prisma");
const {
  getRecordById,
  getRecords,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");
const { createEmployeeUser } = require("../../../utils/userAccount");

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
    } = req.body;

    
    const existingEmployee = await prisma.employee.findUnique({
      where: { employeeCode },
    });

    if (existingEmployee) {
      const response = badRequestResponse(
        "Employee with this code already exists."
      );
      return res.status(response.status.code).json(response);
    }

    
    if (cnic) {
      const existingCnic = await prisma.employee.findUnique({
        where: { cnic },
      });
      if (existingCnic) {
        const response = badRequestResponse("Employee with this CNIC already exists.");
        return res.status(response.status.code).json(response);
      }
    }

    const employee = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
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

      return createEmployeeUser(tx, employee);
    });

    const response = createSuccessResponse(employee, "Record created successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error)
    next(error);
  }
};

const getAllEmployees = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status, areaId, departmentId } = req.query;

    const where = {};
    if (status) where.status = status;
    if (areaId) where.areaId = areaId;
    if (departmentId) where.departmentId = departmentId;

    const options = {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        department: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        subArea: { select: { id: true, name: true } },
        block: { select: { id: true, name: true } },
      },  
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.employee, options);
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
      user: true,
      weeklySchedules: true,
      attendances: true,
      rides: true,
      complaints: true,
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

    
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (
      updateData.employeeCode &&
      updateData.employeeCode !== employee.employeeCode
    ) {
      const existingCode = await prisma.employee.findUnique({
        where: { employeeCode: updateData.employeeCode },
      });
      if (existingCode) {
        const errorResponse = badRequestResponse(
          "Employee code already exists."
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    
    if (updateData.cnic && updateData.cnic !== employee.cnic) {
      const existingCnic = await prisma.employee.findUnique({
        where: { cnic: updateData.cnic },
      });
      if (existingCnic) {
        const errorResponse = badRequestResponse(
          "Employee with this CNIC already exists."
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await prisma.$transaction(async (tx) => {
      const updatedEmployee = await tx.employee.update({
        where: { id },
        data: updateData,
        include: { user: true, department: true, area: true, subArea: true, block: true },
      });

      if (updateData.name && updatedEmployee.userId) {
        await tx.user.update({
          where: { id: updatedEmployee.userId },
          data: { name: updateData.name },
        });
      }

      return okResponse(updatedEmployee, "Record updated successfully.");
    });

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
   
    });

    if (!employee) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // prevent FK RESTRICT violations by checking for dependent records
    const ridePassengerCount = await prisma.ridePassenger.count({ where: { employeeId: id } });
    const attendanceCount = await prisma.attendance.count({ where: { employeeId: id } });
    const complaintCount = await prisma.complaint.count({ where: { employeeId: id } });

    const blocking = [];
    if (ridePassengerCount > 0) blocking.push(`${ridePassengerCount} ride passenger(s)`);
    if (attendanceCount > 0) blocking.push(`${attendanceCount} attendance record(s)`);
    if (complaintCount > 0) blocking.push(`${complaintCount} complaint(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete employee: referenced by ${blocking.join(", ")}. Remove related records first.`
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await prisma.$transaction(async (tx) => {
      if (employee.userId) {
        await tx.user.delete({ where: { id: employee.userId } });
      }

      await tx.employee.delete({ where: { id } });
      return okResponse(employee, "Record deleted successfully.");
    });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;

    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        weeklySchedules: {
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
        },
      },
    });

    if (!employee) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        employeeId: employee.id,
        employeeName: employee.name,
        schedules: employee.weeklySchedules,
      },
      "Employee schedule retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { skip = 0, take = 10, status } = req.query;

    const where = { employeeId: id };
    if (status) where.status = status;

    const [attendanceRecords, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(take),
        include: {
          ride: {
            select: { id: true, rideDate: true },
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
          total,
          limit: parseInt(take),
          offset: parseInt(skip),
        },
      },
      "Attendance records retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getEmployeeComplaints = async (req, res, next) => {
  try {
    const { id } = req.params;

    const complaints = await prisma.complaint.findMany({
      where: { employeeId: id },
      include: {
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        ride: { select: { id: true, rideDate: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const response = okResponse(
      {
        employeeId: id,
        complaints,
      },
      "Complaints retrieved successfully."
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
