const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");
const {
  notifyUser,
  notifyRoles,
  ADMIN_NOTIFY_ROLES,
} = require("../../../services/notification.service");

// Roles that should be told about complaints — anything without
// one obvious single recipient.
// Sourced from the notification service so this can't silently drift
// out of sync with the role set the service itself uses for notifyAdmins.
const STAFF_ROLES = ADMIN_NOTIFY_ROLES;

const getEmployeeFromReq = async (req) => {
  const userId = req.user?.userId;
  if (!userId) return null;
  return prisma.employee.findUnique({ where: { userId } });
};

const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
};

const endOfDay = (date = new Date()) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
};

// Saturday as week start
const saturdayOf = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  
  const diff = day === 6 ? 0 : -(day + 1);
  
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff, 0, 0, 0, 0));
};

const LATE_GRACE_MINUTES = 10;

function parsePickupTimeToMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, "").toUpperCase();
  const match = s.match(/^(\d{1,2}):?(\d{2})?:?(AM|PM)?$/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) return null;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function computeArrivalStatus(pickupTime, scannedAt = new Date()) {
  const scheduledMinutes = parsePickupTimeToMinutes(pickupTime);
  if (scheduledMinutes === null) return "PRESENT";
  const scannedMinutes = scannedAt.getHours() * 60 + scannedAt.getMinutes();
  return scannedMinutes > scheduledMinutes + LATE_GRACE_MINUTES ? "LATE" : "PRESENT";
}

function isValidDate(date) {
  return date instanceof Date && !isNaN(date.getTime());
}

function parsePagination(query) {
  const skip = parseInt(query.skip) || 0;
  const take = parseInt(query.take) || 10;
  return { skip: Math.max(0, skip), take: Math.max(1, Math.min(take, 100)) };
}

const markNotificationAsRead = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const errorResponse = badRequestResponse("User not authenticated.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification || notification.userId !== userId) {
      const errorResponse = badRequestResponse("Notification not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updated = await prisma.notification.update({
      where: { id: req.params.id },
      data: { status: "READ" },
    });

    // ✅ NO Pusher events - just return success
    const response = okResponse(updated, "Notification marked as read.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteNotification = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const errorResponse = badRequestResponse("User not authenticated.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification || notification.userId !== userId) {
      const errorResponse = badRequestResponse("Notification not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    await prisma.notification.delete({ where: { id: req.params.id } });

    const response = okResponse(null, "Notification deleted successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyProfile = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const record = await prisma.employee.findUnique({
      where: { id: employee.id },
      include: {
        department: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        subArea: { select: { id: true, name: true } },
        block: { select: { id: true, name: true } },
      },
    });

    if (!record) {
      const errorResponse = badRequestResponse("Employee not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(record, "Profile retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateMyProfile = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { name, contactNumber, cnic, gender, address } = req.body;

    if (cnic && cnic !== employee.cnic) {
      const existing = await prisma.employee.findUnique({ where: { cnic } });
      if (existing) {
        const errorResponse = badRequestResponse(
          "Another employee is already registered with this CNIC.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: {
        ...(name !== undefined && { name }),
        ...(contactNumber !== undefined && { contactNumber }),
        ...(cnic !== undefined && { cnic }),
        ...(gender !== undefined && { gender }),
        ...(address !== undefined && { address }),
      },
    });

    notifyRoles(STAFF_ROLES, {
      title: "Employee profile updated",
      body: `${updated.name} updated their profile.`,
      data: { employeeId: employee.id, type: "EMPLOYEE_PROFILE_UPDATED" },
      event: "notification-created",
    }).catch((err) => console.error("[employee_controller] notifyRoles failed:", err));

    const response = okResponse(updated, "Profile updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTodayRide = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ridePassenger = await prisma.ridePassenger.findFirst({
      where: {
        employeeId: employee.id,
        ride: { rideDate: { gte: startOfDay(), lte: endOfDay() } },
      },
      include: {
        ride: {
          include: {
            route: {
              select: {
                id: true,
                routeName: true,
                routeCode: true,
                officeLocation: true,
              },
            },
            driver: { select: { id: true, name: true, phone: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
      },
    });

    if (!ridePassenger) {
      const response = okResponse(null, "No ride scheduled for today.");
      return res.status(response.status.code).json(response);
    }

    const response = okResponse(
      {
        ...ridePassenger.ride,
        confirmationStatus: ridePassenger.confirmationStatus,
        confirmedAt: ridePassenger.confirmedAt,
        source: "RIDE",
      },
      "Today's ride retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const confirmTodayRide = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { confirmed } = req.body;
    if (typeof confirmed !== "boolean") {
      const errorResponse = badRequestResponse(
        "`confirmed` (true/false) is required.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ridePassenger = await prisma.ridePassenger.findFirst({
      where: {
        employeeId: employee.id,
        ride: { rideDate: { gte: startOfDay(), lte: endOfDay() } },
      },
      select: {
        id: true,
        rideId: true,
        ride: {
          select: {
            driver: { select: { userId: true } },
            route: { select: { routeName: true } },
          },
        },
      },
    });

    if (!ridePassenger) {
      const errorResponse = badRequestResponse(
        "Today's ride hasn't been dispatched yet. Please check back closer to your pickup time.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updated = await prisma.ridePassenger.update({
      where: { id: ridePassenger.id },
      data: {
        confirmationStatus: confirmed ? "CONFIRMED" : "DECLINED",
        confirmedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: "RIDE_PICKUP_CONFIRMATION",
        model: "Ride",
        recordId: ridePassenger.rideId,
        after: { employeeId: employee.id, confirmed },
      },
    });

    const driverUserId = ridePassenger.ride?.driver?.userId;
    if (driverUserId) {
      const routeName = ridePassenger.ride?.route?.routeName ?? "today's ride";
      notifyUser(driverUserId, {
        title: confirmed ? "Pickup confirmed" : "Pickup declined",
        body: `${employee.name} ${confirmed ? "confirmed" : "declined"} pickup for ${routeName}.`,
        data: { rideId: ridePassenger.rideId, type: confirmed ? "PICKUP_CONFIRMED" : "PICKUP_DECLINED" },
        event: "ride-response",
      }).catch((err) => console.error("[employee_controller] notifyUser failed:", err));
    }

    const response = okResponse(
      {
        rideId: ridePassenger.rideId,
        confirmed,
        confirmationStatus: updated.confirmationStatus,
        confirmedAt: updated.confirmedAt,
      },
      confirmed
        ? "Pickup confirmed."
        : "Pickup declined. Dispatch has been notified.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyRides = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { skip, take } = parsePagination(req.query);
    const { status, startDate, endDate } = req.query;

    let dateFilter = {};
    if (startDate) {
      const parsedStart = new Date(startDate);
      if (!isValidDate(parsedStart)) {
        const errorResponse = badRequestResponse("Invalid startDate.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      dateFilter.gte = startOfDay(parsedStart);
    }
    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (!isValidDate(parsedEnd)) {
        const errorResponse = badRequestResponse("Invalid endDate.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      dateFilter.lte = endOfDay(parsedEnd);
    }

    const where = {
      employeeId: employee.id,
      ride: {
        ...(status && { status }),
        ...(Object.keys(dateFilter).length > 0 && { rideDate: dateFilter }),
      },
    };

    const [ridePassengers, total] = await Promise.all([
      prisma.ridePassenger.findMany({
        where,
        orderBy: { ride: { rideDate: "desc" } },
        skip,
        take,
        include: {
          ride: {
            include: {
              route: { select: { id: true, routeName: true } },
              driver: { select: { id: true, name: true, phone: true } },
              vehicle: { select: { id: true, vehicleNumber: true } },
            },
          },
        },
      }),
      prisma.ridePassenger.count({ where }),
    ]);

    const response = okResponse(
      { data: ridePassengers.map((rp) => rp.ride), total, skip, take },
      "Rides retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRideDetails = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ridePassenger = await prisma.ridePassenger.findUnique({
      where: { rideId_employeeId: { rideId: req.params.id, employeeId: employee.id } },
      include: {
        ride: {
          include: {
            route: { select: { id: true, routeName: true, officeLocation: true } },
            driver: { select: { id: true, name: true, phone: true } },
            vehicle: { select: { id: true, vehicleNumber: true, make: true, model: true } },
          },
        },
      },
    });

    if (!ridePassenger) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(ridePassenger.ride, "Ride retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const setRideResponse = async (req, res, next, { confirmed }) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId } = req.params;
    const { reason } = req.body;

    if (!confirmed && (!reason || !String(reason).trim())) {
      const errorResponse = badRequestResponse("A reason is required to reject a ride.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ridePassenger = await prisma.ridePassenger.findUnique({
      where: { rideId_employeeId: { rideId, employeeId: employee.id } },
      include: {
        ride: {
          select: {
            driver: { select: { userId: true } },
            route: { select: { routeName: true } },
          },
        },
      },
    });
    if (!ridePassenger) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const updated = await prisma.ridePassenger.update({
      where: { id: ridePassenger.id },
      data: {
        confirmationStatus: confirmed ? "CONFIRMED" : "DECLINED",
        confirmedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: confirmed ? "RIDE_ACCEPTED_BY_EMPLOYEE" : "RIDE_REJECTED_BY_EMPLOYEE",
        model: "Ride",
        recordId: rideId,
        after: { employeeId: employee.id, ...(reason && { reason: String(reason).trim() }) },
      },
    });

    const driverUserId = ridePassenger.ride?.driver?.userId;
    if (driverUserId) {
      const routeName = ridePassenger.ride?.route?.routeName ?? "the ride";
      notifyUser(driverUserId, {
        title: confirmed ? "Ride accepted" : "Ride rejected",
        body: confirmed
          ? `${employee.name} accepted the ride for ${routeName}.`
          : `${employee.name} rejected the ride for ${routeName}${reason ? `: ${String(reason).trim()}` : "."}`,
        data: { rideId, type: confirmed ? "RIDE_ACCEPTED" : "RIDE_REJECTED" },
        event: "ride-response",
      }).catch((err) => console.error("[employee_controller] notifyUser failed:", err));
    }

    const response = okResponse(
      { rideId, confirmed, confirmationStatus: updated.confirmationStatus },
      confirmed ? "Ride accepted." : "Ride rejected. Dispatch has been notified.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const acceptRide = (req, res, next) => setRideResponse(req, res, next, { confirmed: true });
const rejectRide = (req, res, next) => setRideResponse(req, res, next, { confirmed: false });

// UPDATED: Saturday to Friday week
const getWeeklySchedule = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const weekStart = req.query.weekStart
      ? saturdayOf(new Date(req.query.weekStart))
      : saturdayOf();
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    const [schedule, attendances] = await Promise.all([
      prisma.weeklySchedule.findUnique({
        where: { employeeId_weekStart: { employeeId: employee.id, weekStart } },
        include: {
          route: { select: { id: true, routeName: true } },
          driver: { select: { id: true, name: true, phone: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
      }),
      prisma.attendance.findMany({
        where: {
          employeeId: employee.id,
          rideDate: { gte: weekStart, lte: weekEnd },
        },
        select: { rideDate: true, status: true },
      }),
    ]);

    if (!schedule) {
      const response = okResponse(null, "No schedule found for that week.");
      return res.status(response.status.code).json(response);
    }

    const WEEK_FIELD_ORDER = [
      "saturday",
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
    ];
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const attendanceByDay = {};
    for (const a of attendances) {
      const offset = Math.round((startOfDay(a.rideDate).getTime() - weekStart.getTime()) / MS_PER_DAY);
      const key = WEEK_FIELD_ORDER[offset];
      if (key) attendanceByDay[key] = a.status;
    }

    const response = okResponse(
      { ...schedule, attendanceByDay },
      "Weekly schedule retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// NEW: Get all weekly schedules (multiple weeks)
const getAllWeeklySchedules = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const schedules = await prisma.weeklySchedule.findMany({
      where: { employeeId: employee.id },
      orderBy: { weekStart: "desc" },
      include: {
        route: { select: { id: true, routeName: true } },
        driver: { select: { id: true, name: true, phone: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
    });

    if (schedules.length === 0) {
      const response = okResponse([], "No schedules found.");
      return res.status(response.status.code).json(response);
    }

    const firstWeekStart = schedules[schedules.length - 1].weekStart;
    const lastWeekEnd = new Date(schedules[0].weekStart);
    lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() + 6);
    lastWeekEnd.setUTCHours(23, 59, 59, 999);

    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        rideDate: { gte: firstWeekStart, lte: lastWeekEnd },
      },
      select: { rideDate: true, status: true },
    });

    const WEEK_FIELD_ORDER = [
      "saturday",
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
    ];
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const schedulesWithAttendance = schedules.map((schedule) => {
      const attendanceByDay = {};
      for (const a of attendances) {
        const offset = Math.round(
          (startOfDay(a.rideDate).getTime() - schedule.weekStart.getTime()) / MS_PER_DAY
        );
        if (offset >= 0 && offset < 7) {
          const key = WEEK_FIELD_ORDER[offset];
          if (key) attendanceByDay[key] = a.status;
        }
      }
      return { ...schedule, attendanceByDay };
    });

    const response = okResponse(
      schedulesWithAttendance,
      "All weekly schedules retrieved successfully.",
    );
    console.log('schedulesWithAttendance', schedulesWithAttendance)
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// UPDATED: Saturday to Friday week summary
const getWeekSummary = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const weekStart = saturdayOf();
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        rideDate: { gte: weekStart, lte: weekEnd },
      },
      select: {
        status: true,
        ride: { select: { status: true } },
      },
    });

    const totalMarked = attendances.length;
    const present = attendances.filter((a) =>
      ["PRESENT", "LATE"].includes(a.status),
    ).length;

    const completed = attendances.filter(
      (a) => ["PRESENT", "LATE"].includes(a.status) && a.ride?.status === "COMPLETED",
    ).length;

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { employeeId_weekStart: { employeeId: employee.id, weekStart } },
      select: {
        saturday: true,
        sunday: true,
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
      },
    });

    const scheduledDayCount = schedule
      ? Object.values(schedule).filter((s) => s !== "OFF").length
      : 0;

    const response = okResponse(
      {
        ridesCompleted: completed,
        ridesRemaining: Math.max(0, scheduledDayCount - totalMarked),
        attendanceRate:
          totalMarked > 0
            ? `${Math.round((present / totalMarked) * 100)}%`
            : "N/A",
      },
      "Week summary retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const markAttendanceByQr = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { qrCode } = req.body;
    if (!qrCode) {
      const errorResponse = badRequestResponse("No QR code was scanned.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const scannedUser = await prisma.user.findUnique({
      where: { qrCode },
      include: { driver: { select: { id: true, name: true } } },
    });

    if (!scannedUser?.driver) {
      const errorResponse = badRequestResponse(
        "That doesn't look like a driver's QR code. Ask your driver to show their attendance code.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findFirst({
      where: {
        driverId: scannedUser.driver.id,
        status: { in: ["STARTED", "ARRIVED"] },
        rideDate: { gte: startOfDay(), lte: endOfDay() },
      },
      orderBy: { rideDate: "desc" },
      select: { id: true, rideDate: true, pickupTime: true, route: { select: { routeName: true } } },
    });

    if (!ride) {
      const errorResponse = badRequestResponse(
        `${scannedUser.driver.name} doesn't have a ride in progress right now.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const passenger = await prisma.ridePassenger.findUnique({
      where: { rideId_employeeId: { rideId: ride.id, employeeId: employee.id } },
    });
    if (!passenger) {
      const errorResponse = badRequestResponse(
        `You're not listed as a passenger on ${scannedUser.driver.name}'s ride. Contact dispatch if this looks wrong.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const now = new Date();
    const status = computeArrivalStatus(ride.pickupTime, now);
    const rideDate = startOfDay(ride.rideDate);

    const attendance = await prisma.attendance.upsert({
      where: { employeeId_rideDate: { employeeId: employee.id, rideDate } },
      update: { status, rideId: ride.id, arrivalTime: now },
      create: { employeeId: employee.id, rideId: ride.id, rideDate, status, arrivalTime: now },
    });

    // scannedUser IS the driver's user account (that's what the QR encodes),
    // so scannedUser.id is already the driverUserId — no extra
    // driver -> userId join needed here, unlike markMyAttendance below
    // where we only have the driver relation and must pull .driver.userId.
    const driverUserId = scannedUser.id;
    notifyUser(driverUserId, {
      title: "Passenger checked in",
      body: `${employee.name} checked in for ${ride.route?.routeName ?? "the ride"}${status === "LATE" ? " (late)" : ""}.`,
      // type aligned with driver_controller's attendance notifications
      // (ATTENDANCE_UPDATED) — both represent the same underlying
      // Attendance-record change, just triggered by different actors.
      data: { rideId: ride.id, type: "ATTENDANCE_UPDATED", status },
      event: "attendance-updated",
    }).catch((err) => console.error("[employee_controller] notifyUser failed:", err));

    const response = okResponse(
      { ...attendance, routeName: ride.route?.routeName, driverName: scannedUser.driver.name },
      status === "LATE"
        ? `Marked present (late) for ${ride.route?.routeName ?? "your ride"}.`
        : `Marked present for ${ride.route?.routeName ?? "your ride"}.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const markMyAttendance = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { status = "PRESENT" } = req.body;
    if (!["PRESENT", "LATE"].includes(status)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ridePassengers = await prisma.ridePassenger.findMany({
      where: {
        employeeId: employee.id,
        ride: {
          rideDate: { gte: startOfDay(), lte: endOfDay() },
          status: { in: ["STARTED", "ARRIVED"] },
        },
      },
      select: {
        rideId: true,
        ride: {
          select: {
            driver: { select: { userId: true } },
            route: { select: { routeName: true } },
          },
        },
      },
    });

    if (ridePassengers.length === 0) {
      const errorResponse = badRequestResponse(
        "No ride is currently in progress for you — attendance can only be scanned once your driver has started the ride.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (ridePassengers.length > 1) {
      const errorResponse = badRequestResponse(
        "You're listed on more than one active ride right now — this is a scheduling conflict. Please contact dispatch before marking attendance.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ridePassenger = ridePassengers[0];
    const rideDate = startOfDay();

    const attendance = await prisma.attendance.upsert({
      where: {
        employeeId_rideDate: { employeeId: employee.id, rideDate },
      },
      update: { status, rideId: ridePassenger.rideId, arrivalTime: new Date() },
      create: {
        employeeId: employee.id,
        rideId: ridePassenger.rideId,
        rideDate,
        status,
        arrivalTime: new Date(),
      },
    });

    const driverUserId = ridePassenger.ride?.driver?.userId;
    if (driverUserId) {
      const routeName = ridePassenger.ride?.route?.routeName ?? "the ride";
      notifyUser(driverUserId, {
        title: "Passenger checked in",
        body: `${employee.name} checked in for ${routeName}${status === "LATE" ? " (late)" : ""}.`,
        // type aligned with driver_controller's attendance notifications
        // (ATTENDANCE_UPDATED) — both represent the same underlying
        // Attendance-record change, just triggered by different actors.
        data: { rideId: ridePassenger.rideId, type: "ATTENDANCE_UPDATED", status },
        event: "attendance-updated",
      }).catch((err) => console.error("[employee_controller] notifyUser failed:", err));
    }

    const response = okResponse(attendance, "Attendance marked successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const createComplaint = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { category, title, description, rideId } = req.body;
    const resolvedCategory = category || "OTHER";

    if (!title || !title.trim()) {
      const errorResponse = badRequestResponse("Title is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (["DRIVER_BEHAVIOUR", "VEHICLE_CONDITION"].includes(resolvedCategory) && !rideId) {
      const errorResponse = badRequestResponse(
        resolvedCategory === "DRIVER_BEHAVIOUR"
          ? "Please select the related ride so we know which driver this is about."
          : "Please select the related ride so we know which vehicle this is about.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    let driverId;
    let vehicleId;

    if (rideId) {
      const ridePassenger = await prisma.ridePassenger.findUnique({
        where: { rideId_employeeId: { rideId, employeeId: employee.id } },
        include: { ride: { select: { driverId: true, vehicleId: true } } },
      });
      if (!ridePassenger) {
        const errorResponse = badRequestResponse(
          "That ride isn't associated with your account.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      driverId = ridePassenger.ride.driverId ?? undefined;
      vehicleId = ridePassenger.ride.vehicleId ?? undefined;
    }

    const response = await createRecord(prisma.complaint, {
      employeeId: employee.id,
      category: resolvedCategory,
      title: title.trim(),
      description: description?.trim() || null,
      ...(rideId && { rideId }),
      ...(driverId && { driverId }),
      ...(vehicleId && { vehicleId }),
    });

    const complaint = response?.data;
    notifyRoles(STAFF_ROLES, {
      title: "New complaint filed",
      body: `${employee.name} filed a complaint: ${title.trim()}`,
      data: { complaintId: complaint?.id, type: "COMPLAINT_CREATED" },
      event: "notification-created",
    }).catch((err) => console.error("[employee_controller] notifyRoles failed:", err));

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyComplaints = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { skip, take } = parsePagination(req.query);
    const { status } = req.query;

    const where = {
      employeeId: employee.id,
      ...(status && { status }),
    };

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.complaint.count({ where }),
    ]);

    const response = okResponse(
      { data: complaints, total, skip, take },
      "Complaints retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRecentRides = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const take = Math.min(parseInt(req.query.take) || 5, 20);

    const ridePassengers = await prisma.ridePassenger.findMany({
      where: { employeeId: employee.id },
      take,
      orderBy: { ride: { rideDate: "desc" } },
      include: {
        ride: {
          select: {
            id: true,
            rideDate: true,
            route: { select: { routeName: true } },
            driver: { select: { id: true, name: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
      },
    });

    const rides = ridePassengers.map((rp) => ({
      id: rp.ride.id,
      rideDate: rp.ride.rideDate,
      routeName: rp.ride.route.routeName,
      driver: rp.ride.driver ? { id: rp.ride.driver.id, name: rp.ride.driver.name } : null,
      vehicle: rp.ride.vehicle
        ? { id: rp.ride.vehicle.id, vehicleNumber: rp.ride.vehicle.vehicleNumber }
        : null,
    }));

    const response = okResponse(rides, "Recent rides retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const errorResponse = badRequestResponse("User not authenticated.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { skip, take } = parsePagination(req.query);
    const { status } = req.query;

    const where = {
      userId,
      ...(status && { status }),
    };

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.notification.count({ where }),
    ]);

    const response = okResponse(
      { data: notifications, total, skip, take },
      "Notifications retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const markAllNotificationsAsRead = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const errorResponse = badRequestResponse("User not authenticated.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { count } = await prisma.notification.updateMany({
      where: { 
        userId, 
        status: 'UNREAD' 
      },
      data: { status: 'READ' },
    });

    // ✅ NO Pusher events - just return success
    const response = okResponse(
      { markedCount: count }, 
      `${count} notification(s) marked as read.`
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error)
    next(error);
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile,
  getTodayRide,
  confirmTodayRide,
  getWeeklySchedule,
  getAllWeeklySchedules,
  markAllNotificationsAsRead,
  getWeekSummary,
  markMyAttendance,
  markAttendanceByQr,
  createComplaint,
  getMyComplaints,
  getRecentRides,
  getNotifications,
  acceptRide,
  rejectRide,
  getRideDetails,
  getMyRides,
  markNotificationAsRead,
  deleteNotification,
};