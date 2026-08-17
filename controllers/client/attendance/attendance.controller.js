

const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse, okResponse } = require("../../../constants/responses");

const createAttendance = async (req, res, next) => {
  try {
    const { rideDate, employeeId, rideId, arrivalTime, delayMinutes, status } =
      req.body;

    
    const existingRecord = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate: {
          employeeId,
          rideDate: new Date(rideDate),
        },
      },
    });

    if (existingRecord) {
      const response = badRequestResponse(
        "Attendance record already exists for this employee on this date."
      );
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.attendance, {
      rideDate: new Date(rideDate),
      employeeId,
      rideId,
      arrivalTime: arrivalTime ? new Date(arrivalTime) : null,
      delayMinutes,
      status: status || "PRESENT",
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const scanAttendanceByQrCode = async (req, res, next) => {
  try {
    const { employeeId, driverQrCode, rideId, rideDate, arrivalTime, delayMinutes, status } = req.body;

    const driverUser = await prisma.user.findUnique({
      where: { qr_code: driverQrCode },
      include: { driver: true },
    });

    if (!driverUser || !driverUser.driver) {
      const response = badRequestResponse("Invalid driver QR code.");
      return res.status(response.status.code).json(response);
    }

    const attendanceDate = new Date(rideDate);
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
        "Attendance record already exists for this employee on this date."
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
        status: status || (delayMinutes ? "LATE" : "PRESENT"),
      },
    });

    const response = okResponse(
      {
        attendance,
        scannedDriver: {
          id: driverUser.driver.id,
          name: driverUser.driver.name,
          qrCode: driverUser.qrCode,
        },
      },
      "Attendance scanned successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllAttendance = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, employeeId, status, startDate, endDate } =
      req.query;

    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (startDate && endDate) {
      where.rideDate = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }

    const options = {
      where,
  
      include: {
        employee: {
          select: { id: true, name: true, employeeCode: true },
        },
        ride: {
          select: { id: true, rideDate: true },
        },
      },
      orderBy: { rideDate: "desc" },
    };

    const response = await getRecords(prisma.attendance, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAttendanceById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.attendance, id, {
      employee: true,
      ride: {
        include: {
          route: { select: { id: true, routeName: true } },
          driver: { select: { id: true, name: true } },
        },
      },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Attendance record not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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

    const response = await updateRecord(prisma.attendance, id, updateData, {
      employee: true,
      ride: true,
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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

    const response = await deleteRecord(prisma.attendance, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAttendanceSummary = async (req, res, next) => {
  try {
    const { startDate, endDate, employeeId } = req.query;

    if (!startDate || !endDate) {
      const response = badRequestResponse(
        "startDate and endDate are required."
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

    const records = await prisma.attendance.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true } },
      },
    });

    
    const summary = {
      totalRecords: records.length,
      present: records.filter((r) => r.status === "PRESENT").length,
      late: records.filter((r) => r.status === "LATE").length,
      absent: records.filter((r) => r.status === "ABSENT").length,
      noShow: records.filter((r) => r.status === "NO_SHOW").length,
      avgDelayMinutes: Math.round(
        records.reduce((sum, r) => sum + (r.delayMinutes || 0), 0) /
          records.length
      ),
    };

    const response = okResponse(summary, "Attendance summary retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
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
