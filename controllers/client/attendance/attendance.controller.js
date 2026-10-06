const { prisma } = require("../../../lib/prisma");
const {
  calculateVendorLateStatus,
} = require("../../../utils/vendorLateStatus");
const {
  badRequestResponse,
  okResponse,
  createSuccessResponse,
} = require("../../../constants/responses");

// ============================================================
// SCHEMA ENUMS (mirrors schema.prisma)
// ============================================================

const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "NO_SHOW"];
const VENDOR_LATE_STATUSES = [
  "ON_TIME",
  "ON_TIME_LATE",
  "LATE",
  "ONLY_DROP",
  "UNCLASSIFIED",
];
const RIDE_LEGS = ["PICKUP", "DROP"];
// Attendance columns that are safe to sort by.
const SORTABLE_FIELDS = [
  "rideDate",
  "arrivalTime",
  "delayMinutes",
  "status",
  "leg",
  "vendorLateStatus",
  "createdAt",
  "updatedAt",
];

const fail = (res, message) => {
  const response = badRequestResponse(message);
  return res.status(response.status.code).json(response);
};

// ============================================================
// DATE HELPERS (Asia/Karachi operational time)
// ============================================================
// Attendance is unique on (employeeId, rideDate, leg) and rideDate is an exact
// DateTime. The employee controller stores rideDate as Karachi midnight, so
// every write/filter here must normalise the same way — otherwise the same
// day produces duplicate rows and the unique key never matches.

function parseDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

const toKarachiDateParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  return { year: lookup.year, month: lookup.month, day: lookup.day };
};

const startOfDay = (date) => {
  const { year, month, day } = toKarachiDateParts(date);
  return new Date(`${year}-${month}-${day}T00:00:00+05:00`);
};

const endOfDay = (date) => {
  const { year, month, day } = toKarachiDateParts(date);
  return new Date(`${year}-${month}-${day}T23:59:59.999+05:00`);
};

// ============================================================
// FORMATTING HELPERS
// ============================================================

function formatTimeForResponse(value) {
  if (!value) return null;

  if (
    typeof value === "string" &&
    !value.includes("T") &&
    !value.includes("-")
  ) {
    return value;
  }

  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Karachi",
    });
  }

  return String(value);
}

function formatDateForResponse(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    // Explicit timeZone: without it the date depends on the server's TZ, and a
    // Karachi-midnight rideDate renders as the previous day on a UTC server.
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Karachi",
    });
  }
  return String(value);
}

// ============================================================
// VALIDATION HELPERS
// ============================================================

// Query-string params can arrive as arrays/objects; only accept plain strings.
const queryString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

// delayMinutes is `Int?` in the schema: reject NaN, Infinity, decimals, negatives.
function parseDelayMinutes(value) {
  if (value === "" || value === null || value === undefined)
    return { value: null };
  const num = Number(value);
  if (!Number.isFinite(num))
    return { error: "Delay minutes must be a valid number." };
  if (!Number.isInteger(num))
    return { error: "Delay minutes must be a whole number." };
  if (num < 0) return { error: "Delay minutes cannot be negative." };
  return { value: num };
}

// calculateVendorLateStatus's output goes straight into an enum column, so make
// sure whatever it returns is a valid VendorLateStatus.
function resolveVendorLate({ status, vendorLateStatus, delayMinutes }) {
  const result = calculateVendorLateStatus(
    {
      status,
      vendorLateStatus,
      delayMinutes,
    },
    null,
    null
  );

  return {
    status: result.status,
    delayMinutes: result.delayMinutes,
    warnings: result.warnings,
  };
}

// Prisma errors that are the caller's fault, not a server fault.
function handleKnownPrismaError(error, res) {
  if (error?.code === "P2002") {
    return fail(
      res,
      "Attendance record already exists for this employee on this date and leg.",
    );
  }
  if (error?.code === "P2025") {
    return fail(res, "Attendance record not found.");
  }
  if (error?.code === "P2003") {
    return fail(res, "A referenced employee or ride does not exist.");
  }
  return null;
}

// ============================================================
// ATTENDANCE CREATION
// ============================================================

const createAttendance = async (req, res, next) => {
  try {
    const {
      rideDate,
      employeeId,
      rideId,
      arrivalTime,
      delayMinutes,
      status,
      leg,
      vendorLateStatus,
    } = req.body ?? {};

    if (!rideDate) return fail(res, "Ride date is required.");
    const parsedRideDate = parseDate(rideDate);
    if (!parsedRideDate) return fail(res, "Ride date is invalid.");

    if (!employeeId || typeof employeeId !== "string")
      return fail(res, "Employee is required.");

    if (
      status !== undefined &&
      status !== null &&
      status !== "" &&
      !ATTENDANCE_STATUSES.includes(status)
    ) {
      return fail(
        res,
        `Invalid status. Must be one of: ${ATTENDANCE_STATUSES.join(", ")}.`,
      );
    }

    if (
      leg !== undefined &&
      leg !== null &&
      leg !== "" &&
      !RIDE_LEGS.includes(leg)
    ) {
      return fail(res, `Invalid leg. Must be one of: ${RIDE_LEGS.join(", ")}.`);
    }

    let parsedArrival = null;
    if (arrivalTime) {
      parsedArrival = parseDate(arrivalTime);
      if (!parsedArrival) return fail(res, "Arrival time is invalid.");
    }

    const delay = parseDelayMinutes(delayMinutes);
    if (delay.error) return fail(res, delay.error);
    const delayValue = delay.value;

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) return fail(res, "Employee not found.");

    if (rideId) {
      if (typeof rideId !== "string") return fail(res, "Ride ID is invalid.");
      const ride = await prisma.ride.findUnique({
        where: { id: rideId },
        select: { id: true },
      });
      if (!ride) return fail(res, "Ride not found.");
    }

    const normalizedLeg = leg === "DROP" ? "DROP" : "PICKUP";
    const attendanceDate = startOfDay(parsedRideDate);

    const existingRecord = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate_leg: {
          employeeId,
          rideDate: attendanceDate,
          leg: normalizedLeg,
        },
      },
      select: { id: true },
    });
    if (existingRecord) {
      return fail(
        res,
        "Attendance record already exists for this employee on this date and leg.",
      );
    }

    const vendorLateResult = resolveVendorLate({
      status,
      vendorLateStatus,
      delayMinutes: delayValue,
    });

    const attendance = await prisma.attendance.create({
      data: {
        rideDate: attendanceDate,
        employeeId,
        rideId: rideId || null,
        leg: normalizedLeg,
        arrivalTime: parsedArrival,
        delayMinutes: vendorLateResult.delayMinutes ?? delayValue,
        status: status || "PRESENT",
        vendorLateStatus: vendorLateResult.status,
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
    // Lost a race against the unique (employeeId, rideDate, leg) key.
    if (handleKnownPrismaError(error, res)) return;
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
      leg,
      vendorLateStatus,
    } = req.body ?? {};

    if (!employeeId || typeof employeeId !== "string")
      return fail(res, "Employee ID is required.");
    if (!driverQrCode || typeof driverQrCode !== "string")
      return fail(res, "Driver QR code is required.");
    if (!rideDate) return fail(res, "Ride date is required.");

    const parsedRideDate = parseDate(rideDate);
    if (!parsedRideDate) return fail(res, "Ride date is invalid.");

    if (
      status !== undefined &&
      status !== null &&
      status !== "" &&
      !ATTENDANCE_STATUSES.includes(status)
    ) {
      return fail(
        res,
        `Invalid status. Must be one of: ${ATTENDANCE_STATUSES.join(", ")}.`,
      );
    }

    if (
      leg !== undefined &&
      leg !== null &&
      leg !== "" &&
      !RIDE_LEGS.includes(leg)
    ) {
      return fail(res, `Invalid leg. Must be one of: ${RIDE_LEGS.join(", ")}.`);
    }

    let parsedArrival = new Date();
    if (arrivalTime) {
      parsedArrival = parseDate(arrivalTime);
      if (!parsedArrival) return fail(res, "Arrival time is invalid.");
    }

    const delay = parseDelayMinutes(delayMinutes);
    if (delay.error) return fail(res, delay.error);
    const delayValue = delay.value;

    const driverUser = await prisma.user.findUnique({
      where: { qrCode: driverQrCode },
      include: { driver: true },
    });

    if (!driverUser || !driverUser.driver || !driverUser.isActive) {
      return fail(res, "Invalid driver QR code.");
    }

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) return fail(res, "Employee not found.");

    const normalizedLeg = leg === "DROP" ? "DROP" : "PICKUP";
    const attendanceDate = startOfDay(parsedRideDate);

    // Tie the scan to a real ride of the scanned driver so the QR actually
    // proves something: a supplied rideId must belong to that driver; without
    // one, look up the driver's ride that day that lists this employee.
    let resolvedRideId = null;
    if (rideId) {
      if (typeof rideId !== "string") return fail(res, "Ride ID is invalid.");
      const ride = await prisma.ride.findUnique({
        where: { id: rideId },
        select: { id: true, driverId: true },
      });
      if (!ride) return fail(res, "Ride not found.");
      if (ride.driverId !== driverUser.driver.id) {
        return fail(res, "This ride doesn't belong to the scanned driver.");
      }
      resolvedRideId = ride.id;
    } else {
      const ride = await prisma.ride.findFirst({
        where: {
          driverId: driverUser.driver.id,
          rideDate: {
            gte: startOfDay(attendanceDate),
            lte: endOfDay(attendanceDate),
          },
          status: { not: "CANCELLED" },
          passengers: { some: { employeeId, leg: normalizedLeg } },
        },
        orderBy: { rideDate: "desc" },
        select: { id: true },
      });
      resolvedRideId = ride?.id ?? null;
    }

    const existingRecord = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate_leg: {
          employeeId,
          rideDate: attendanceDate,
          leg: normalizedLeg,
        },
      },
      select: { id: true },
    });
    if (existingRecord) {
      return fail(
        res,
        "Attendance record already exists for this employee on this date and leg.",
      );
    }

    const vendorLateResult = resolveVendorLate({
      status,
      vendorLateStatus,
      delayMinutes: delayValue,
    });

    const attendance = await prisma.attendance.create({
      data: {
        rideDate: attendanceDate,
        employeeId,
        rideId: resolvedRideId,
        leg: normalizedLeg,
        arrivalTime: parsedArrival,
        delayMinutes: vendorLateResult.delayMinutes ?? delayValue,
        status: status || (delayValue > 0 ? "LATE" : "PRESENT"),
        vendorLateStatus: vendorLateResult.status,
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
    if (handleKnownPrismaError(error, res)) return;
    next(error);
  }
};

// ============================================================
// GET ALL ATTENDANCE
// ============================================================

const getAllAttendance = async (req, res, next) => {
  try {
    const query = req.query ?? {};
    const employeeId = queryString(query.employeeId);
    const status = queryString(query.status);
    const leg = queryString(query.leg);
    const rideId = queryString(query.rideId);
    const search = queryString(query.search);
    const startDate = queryString(query.startDate);
    const endDate = queryString(query.endDate);

    // Pagination: skip must be derived from the CLAMPED take, otherwise
    // limit=500 (clamped to 100) skips by 500 per page. page<1 / NaN would
    // also produce a negative or NaN skip.
    const page = Math.max(parseInt(query.page) || 1, 1);
    const take = Math.min(Math.max(parseInt(query.limit) || 10, 1), 100);
    const skip = (page - 1) * take;

    // Only allow real Attendance columns; anything else makes Prisma throw.
    const sortBy = SORTABLE_FIELDS.includes(query.sortBy)
      ? query.sortBy
      : "rideDate";
    const sortOrder =
      String(query.sortOrder).toLowerCase() === "asc" ? "asc" : "desc";

    if (status && !ATTENDANCE_STATUSES.includes(status)) {
      return fail(
        res,
        `Invalid status. Must be one of: ${ATTENDANCE_STATUSES.join(", ")}.`,
      );
    }
    if (leg && !RIDE_LEGS.includes(leg)) {
      return fail(res, `Invalid leg. Must be one of: ${RIDE_LEGS.join(", ")}.`);
    }

    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (leg) where.leg = leg;
    if (rideId) where.rideId = rideId;

    // Date range, as whole Karachi days (an endDate of "2026-10-06" must
    // include everything on the 6th).
    if (startDate || endDate) {
      where.rideDate = {};
      if (startDate) {
        const parsed = parseDate(startDate);
        if (!parsed) return fail(res, "Invalid startDate.");
        where.rideDate.gte = startOfDay(parsed);
      }
      if (endDate) {
        const parsed = parseDate(endDate);
        if (!parsed) return fail(res, "Invalid endDate.");
        where.rideDate.lte = endOfDay(parsed);
      }
    }

    if (search) {
      where.OR = [
        { employee: { name: { contains: search, mode: "insensitive" } } },
        {
          employee: { employeeCode: { contains: search, mode: "insensitive" } },
        },
        {
          ride: {
            route: { routeName: { contains: search, mode: "insensitive" } },
          },
        },
        {
          ride: { driver: { name: { contains: search, mode: "insensitive" } } },
        },
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
        // `id` tiebreaker keeps pagination stable when the sort column has ties.
        orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
      }),
      prisma.attendance.count({ where }),
    ]);

    const formattedRecords = attendanceRecords.map((record) => ({
      id: record.id,
      rideDate: formatDateForResponse(record.rideDate),
      // Attendance is per leg: without these two a day's PICKUP and DROP rows
      // are indistinguishable in the list.
      leg: record.leg,
      vendorLateStatus: record.vendorLateStatus,
      rideId: record.rideId,
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
      ride: record.ride
        ? {
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
          }
        : null,
    }));

    const totalPages = Math.ceil(total / take);
    const response = okResponse(
      {
        attendance: formattedRecords,
        pagination: {
          page,
          limit: take,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
      "Attendance records retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
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

    if (!attendance) return fail(res, "Attendance record not found.");

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
    next(error);
  }
};

// ============================================================
// UPDATE ATTENDANCE
// ============================================================

const updateAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { arrivalTime, delayMinutes, status, rideId, leg, vendorLateStatus } =
      req.body ?? {};

    const attendance = await prisma.attendance.findUnique({ where: { id } });
    if (!attendance) return fail(res, "Attendance record not found.");

    const updateData = {};

    if (arrivalTime !== undefined) {
      if (arrivalTime === null || arrivalTime === "") {
        updateData.arrivalTime = null;
      } else {
        const parsed = parseDate(arrivalTime);
        if (!parsed) return fail(res, "Arrival time is invalid.");
        updateData.arrivalTime = parsed;
      }
    }

    // The delay the status calculation should see: the new value if one was
    // sent (including an explicit null to clear it), else the stored one.
    let delayProvided = false;
    let effectiveDelay = attendance.delayMinutes;
    if (delayMinutes !== undefined) {
      const delay = parseDelayMinutes(delayMinutes);
      if (delay.error) return fail(res, delay.error);
      delayProvided = true;
      effectiveDelay = delay.value;
      updateData.delayMinutes = delay.value;
    }

    if (status !== undefined && status !== null && status !== "") {
      if (!ATTENDANCE_STATUSES.includes(status)) {
        return fail(
          res,
          `Invalid status. Must be one of: ${ATTENDANCE_STATUSES.join(", ")}.`,
        );
      }
      updateData.status = status;
    }

    if (rideId !== undefined) {
      if (rideId === null || rideId === "") {
        updateData.rideId = null;
      } else {
        if (typeof rideId !== "string") return fail(res, "Ride ID is invalid.");
        const ride = await prisma.ride.findUnique({
          where: { id: rideId },
          select: { id: true },
        });
        if (!ride) return fail(res, "Ride not found.");
        updateData.rideId = rideId;
      }
    }

    if (leg !== undefined && leg !== null && leg !== "") {
      if (!RIDE_LEGS.includes(leg)) {
        return fail(
          res,
          `Invalid leg. Must be one of: ${RIDE_LEGS.join(", ")}.`,
        );
      }
      if (leg !== attendance.leg) {
        // Changing the leg can collide with the unique (employeeId, rideDate, leg) key.
        const conflict = await prisma.attendance.findUnique({
          where: {
            employeeId_rideDate_leg: {
              employeeId: attendance.employeeId,
              rideDate: attendance.rideDate,
              leg,
            },
          },
          select: { id: true },
        });
        if (conflict) {
          return fail(
            res,
            "Attendance record already exists for this employee on this date and leg.",
          );
        }
      }
      updateData.leg = leg;
    }

    if (
      Object.keys(updateData).length === 0 &&
      vendorLateStatus === undefined
    ) {
      return fail(res, "No fields to update.");
    }

    const vendorLateResult = resolveVendorLate({
      status: vendorLateStatus ?? status ?? attendance.vendorLateStatus,
      delayMinutes: effectiveDelay,
    });

    updateData.vendorLateStatus = vendorLateResult.status;
    if (delayProvided || vendorLateResult.delayMinutes !== null) {
      updateData.delayMinutes = vendorLateResult.delayMinutes ?? effectiveDelay;
    }

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
    if (handleKnownPrismaError(error, res)) return;
    next(error);
  }
};

// ============================================================
// DELETE ATTENDANCE
// ============================================================

const deleteAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;

    // delete() throws P2025 if the row vanished between a find and the delete
    // (double-click / concurrent request); handled below as "not found".
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
    if (handleKnownPrismaError(error, res)) return;
    next(error);
  }
};

// ============================================================
// GET ATTENDANCE SUMMARY
// ============================================================

const getAttendanceSummary = async (req, res, next) => {
  try {
    const query = req.query ?? {};
    const startDate = queryString(query.startDate);
    const endDate = queryString(query.endDate);
    const employeeId = queryString(query.employeeId);

    if (!startDate || !endDate) {
      return fail(res, "startDate and endDate are required.");
    }

    const parsedStart = parseDate(startDate);
    const parsedEnd = parseDate(endDate);
    if (!parsedStart) return fail(res, "Invalid startDate.");
    if (!parsedEnd) return fail(res, "Invalid endDate.");

    const where = {
      rideDate: {
        gte: startOfDay(parsedStart),
        lte: endOfDay(parsedEnd),
      },
    };

    if (employeeId) where.employeeId = employeeId;

    // Aggregate in the database instead of loading every row just to count
    // them and average the delay.
    const [totals, statusCounts] = await Promise.all([
      prisma.attendance.aggregate({
        where,
        _count: { _all: true },
        _sum: { delayMinutes: true },
      }),
      prisma.attendance.groupBy({
        by: ["status"],
        where,
        _count: { status: true },
      }),
    ]);

    const statusMap = {};
    statusCounts.forEach((s) => {
      statusMap[s.status] = s._count.status;
    });

    const totalRecords = totals._count._all;

    const summary = {
      totalRecords,
      present: statusMap.PRESENT || 0,
      late: statusMap.LATE || 0,
      absent: statusMap.ABSENT || 0,
      noShow: statusMap.NO_SHOW || 0,
      // Rows with no delay count as 0 (same as before), so divide by all rows.
      avgDelayMinutes:
        totalRecords > 0
          ? Math.round((totals._sum.delayMinutes || 0) / totalRecords)
          : 0,
      dateRange: {
        startDate: formatDateForResponse(parsedStart),
        endDate: formatDateForResponse(parsedEnd),
      },
    };

    const response = okResponse(
      summary,
      "Attendance summary retrieved successfully.",
    );
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
