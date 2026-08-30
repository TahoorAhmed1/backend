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

// ============================================================
// TIME FORMATTING HELPERS
// ============================================================

function formatTimeForResponse(value) {
  if (!value) return null;
  
  if (typeof value === 'string' && !value.includes('T') && !value.includes('-')) {
    return value;
  }
  
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Karachi'
      });
    }
  } catch (e) {
    // ignore
  }
  
  return String(value);
}

function formatDateForResponse(value) {
  if (!value) return null;
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    }
  } catch (e) {
    // ignore
  }
  return String(value);
}

// ============================================================
// ATTENDANCE CREATION
// ============================================================

const createAttendance = async (req, res, next) => {
  try {
    const { rideDate, employeeId, rideId, arrivalTime, delayMinutes, status } = req.body;

    // Validate required fields
    if (!rideDate) {
      const response = badRequestResponse("Ride date is required.");
      return res.status(response.status.code).json(response);
    }

    if (!employeeId) {
      const response = badRequestResponse("Employee is required.");
      return res.status(response.status.code).json(response);
    }

    // Validate employee exists
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      const response = badRequestResponse("Employee not found.");
      return res.status(response.status.code).json(response);
    }

    const attendanceDate = new Date(rideDate);

    // Check for existing record
    const existingRecord = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate: {
          employeeId,
          rideDate: attendanceDate,
        },
      },
    });

    if (existingRecord) {
      const response = badRequestResponse(
        "Attendance record already exists for this employee on this date.",
      );
      return res.status(response.status.code).json(response);
    }

    const attendance = await prisma.attendance.create({
      data: {
        rideDate: attendanceDate,
        employeeId,
        rideId: rideId || null,
        arrivalTime: arrivalTime ? new Date(arrivalTime) : null,
        delayMinutes: delayMinutes ?? null,
        status: status || "PRESENT",
      },
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
        ride: {
          select: { id: true, rideDate: true },
        },
      },
    });

    const response = createSuccessResponse(
      {
        ...attendance,
        rideDate: formatDateForResponse(attendance.rideDate),
        arrivalTime: formatTimeForResponse(attendance.arrivalTime),
      },
      "Attendance record created successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// SCAN ATTENDANCE BY QR CODE
// ============================================================

const scanAttendanceByQrCode = async (req, res, next) => {
  try {
    const {
      employeeId,
      driverQrCode,
      rideId,
      rideDate,
      arrivalTime,
      delayMinutes,
      status,
    } = req.body;

    // Validate required fields
    if (!employeeId) {
      const response = badRequestResponse("Employee ID is required.");
      return res.status(response.status.code).json(response);
    }

    if (!driverQrCode) {
      const response = badRequestResponse("Driver QR code is required.");
      return res.status(response.status.code).json(response);
    }

    if (!rideDate) {
      const response = badRequestResponse("Ride date is required.");
      return res.status(response.status.code).json(response);
    }

    // Find driver by QR code
    const driverUser = await prisma.user.findUnique({
      where: { qrCode: driverQrCode },
      include: { driver: true },
    });

    if (!driverUser || !driverUser.driver) {
      const response = badRequestResponse("Invalid driver QR code.");
      return res.status(response.status.code).json(response);
    }

    // Validate employee exists
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      const response = badRequestResponse("Employee not found.");
      return res.status(response.status.code).json(response);
    }

    const attendanceDate = new Date(rideDate);

    // Check for existing record
    const existingRecord = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate: {
          employeeId,
          rideDate: attendanceDate,
        },
      },
    });

    if (existingRecord) {
      const response = badRequestResponse(
        "Attendance record already exists for this employee on this date.",
      );
      return res.status(response.status.code).json(response);
    }

    const attendance = await prisma.attendance.create({
      data: {
        rideDate: attendanceDate,
        employeeId,
        rideId: rideId || null,
        arrivalTime: arrivalTime ? new Date(arrivalTime) : new Date(),
        delayMinutes: delayMinutes ?? null,
        status: status || (delayMinutes ? "LATE" : "PRESENT"),
      },
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
      },
    });

    const response = createSuccessResponse(
      {
        attendance: {
          ...attendance,
          rideDate: formatDateForResponse(attendance.rideDate),
          arrivalTime: formatTimeForResponse(attendance.arrivalTime),
        },
        scannedDriver: {
          id: driverUser.driver.id,
          name: driverUser.driver.name,
        },
      },
      "Attendance scanned successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET ALL ATTENDANCE
// ============================================================

const getAllAttendance = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      employeeId,
      status,
      rideId,
      search,
      startDate,
      endDate,
      sortBy = "rideDate",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

    const where = {};

    // Filters
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (rideId) where.rideId = rideId;

    // Date range filter
    if (startDate || endDate) {
      where.rideDate = {};
      if (startDate) where.rideDate.gte = new Date(startDate);
      if (endDate) where.rideDate.lte = new Date(endDate);
    }

    // Search functionality
    if (search) {
      where.OR = [
        { employee: { name: { contains: search, mode: "insensitive" } } },
        { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
        { ride: { route: { routeName: { contains: search, mode: "insensitive" } } } },
        { ride: { driver: { name: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const [attendanceRecords, total] = await Promise.all([
      prisma.attendance.findMany({
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
              area: { select: { name: true } },
              subArea: { select: { name: true } },
            },
          },
          ride: {
            select: {
              id: true,
              rideDate: true,
              pickupTime: true,
              dropTime: true,
              status: true,
              route: {
                select: {
                  id: true,
                  routeCode: true,
                  routeName: true,
                  serviceType: true,
                },
              },
              driver: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                  licenseNumber: true,
                  status: true,
                  shiftType: true,
                },
              },
              vehicle: {
                select: {
                  id: true,
                  vehicleNumber: true,
                  type: true,
                  make: true,
                  model: true,
                  capacity: true,
                },
              },
              vendor: {
                select: {
                  id: true,
                  name: true,
                  shortName: true,
                },
              },
              trip: {
                select: {
                  id: true,
                  tripNumber: true,
                  shiftTiming: true,
                },
              },
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.attendance.count({ where }),
    ]);

    // Transform data
    const formattedRecords = attendanceRecords.map((record) => ({
      id: record.id,
      rideDate: formatDateForResponse(record.rideDate),
      arrivalTime: formatTimeForResponse(record.arrivalTime),
      delayMinutes: record.delayMinutes,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      employee: {
        id: record.employee?.id,
        name: record.employee?.name,
        employeeCode: record.employee?.employeeCode,
        contactNumber: record.employee?.contactNumber,
        area: record.employee?.area?.name,
        subArea: record.employee?.subArea?.name,
      },
      ride: record.ride ? {
        id: record.ride.id,
        rideDate: formatDateForResponse(record.ride.rideDate),
        pickupTime: formatTimeForResponse(record.ride.pickupTime),
        dropTime: formatTimeForResponse(record.ride.dropTime),
        status: record.ride.status,
        route: record.ride.route,
        driver: record.ride.driver,
        vehicle: record.ride.vehicle,
        vendor: record.ride.vendor,
        tripNumber: record.ride.trip?.tripNumber,
      } : null,
    }));

    const response = okResponse(
      {
        attendance: formattedRecords,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Attendance records retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET ATTENDANCE BY ID
// ============================================================

const getAttendanceById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const attendance = await prisma.attendance.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            contactNumber: true,
            area: { select: { name: true } },
            subArea: { select: { name: true } },
          },
        },
        ride: {
          include: {
            route: { select: { id: true, routeName: true, routeCode: true } },
            driver: { select: { id: true, name: true, phone: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
      },
    });

    if (!attendance) {
      const errorResponse = badRequestResponse("Attendance record not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        ...attendance,
        rideDate: formatDateForResponse(attendance.rideDate),
        arrivalTime: formatTimeForResponse(attendance.arrivalTime),
      },
      "Attendance record retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// UPDATE ATTENDANCE
// ============================================================

const updateAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { arrivalTime, delayMinutes, status, rideId } = req.body;

    const attendance = await prisma.attendance.findUnique({ where: { id } });
    if (!attendance) {
      const errorResponse = badRequestResponse("Attendance record not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updateData = {};
    if (arrivalTime) updateData.arrivalTime = new Date(arrivalTime);
    if (delayMinutes !== undefined) updateData.delayMinutes = delayMinutes;
    if (status) updateData.status = status;
    if (rideId) updateData.rideId = rideId;

    const updatedAttendance = await prisma.attendance.update({
      where: { id },
      data: updateData,
      include: {
        employee: { select: { id: true, name: true, employeeCode: true } },
        ride: {
          select: {
            id: true,
            rideDate: true,
            route: { select: { routeName: true } },
          },
        },
      },
    });

    const response = okResponse(
      {
        ...updatedAttendance,
        rideDate: formatDateForResponse(updatedAttendance.rideDate),
        arrivalTime: formatTimeForResponse(updatedAttendance.arrivalTime),
      },
      "Attendance record updated successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// DELETE ATTENDANCE
// ============================================================

const deleteAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;

    const attendance = await prisma.attendance.findUnique({
      where: { id },
    });

    if (!attendance) {
      const errorResponse = badRequestResponse("Attendance record not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const deletedAttendance = await prisma.attendance.delete({
      where: { id },
    });

    const response = okResponse(
      { 
        id: deletedAttendance.id, 
        rideDate: deletedAttendance.rideDate,
        employeeId: deletedAttendance.employeeId,
      },
      "Attendance record deleted successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

// ============================================================
// GET ATTENDANCE SUMMARY
// ============================================================

const getAttendanceSummary = async (req, res, next) => {
  try {
    const { startDate, endDate, employeeId } = req.query;

    if (!startDate || !endDate) {
      const response = badRequestResponse(
        "startDate and endDate are required.",
      );
      return res.status(response.status.code).json(response);
    }

    const where = {
      rideDate: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
    };

    if (employeeId) where.employeeId = employeeId;

    const [records, statusCounts] = await Promise.all([
      prisma.attendance.findMany({
        where,
        select: {
          id: true,
          status: true,
          delayMinutes: true,
          employeeId: true,
          employee: { select: { name: true } },
        },
      }),
      prisma.attendance.groupBy({
        by: ['status'],
        where,
        _count: { status: true },
      }),
    ]);

    const statusMap = {};
    statusCounts.forEach((s) => {
      statusMap[s.status] = s._count.status;
    });

    const summary = {
      totalRecords: records.length,
      present: statusMap.PRESENT || 0,
      late: statusMap.LATE || 0,
      absent: statusMap.ABSENT || 0,
      noShow: statusMap.NO_SHOW || 0,
      avgDelayMinutes: records.length > 0
        ? Math.round(
            records.reduce((sum, r) => sum + (r.delayMinutes || 0), 0) / records.length
          )
        : 0,
      dateRange: {
        startDate: formatDateForResponse(startDate),
        endDate: formatDateForResponse(endDate),
      },
    };

    const response = okResponse(
      summary,
      "Attendance summary retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

module.exports = {
  createAttendance,
  scanAttendanceByQrCode,
  getAllAttendance,
  getAttendanceById,
  updateAttendance,
  deleteAttendance,
  getAttendanceSummary,
};