const { prisma } = require("../../../lib/prisma");
const { createRecord } = require("../../../utils/crudHelper");
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

// ─────────────────────────────────────────────────────────────
// Enum value lists (mirrors schema.prisma). Query/body values are
// validated against these so a bad client value returns a 400
// instead of a Prisma validation error (500).
// ─────────────────────────────────────────────────────────────
const RIDE_STATUSES = [
  "PENDING",
  "STARTED",
  "ARRIVED",
  "COMPLETED",
  "CANCELLED",
];
const COMPLAINT_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"];
const COMPLAINT_CATEGORIES = [
  "DRIVER_BEHAVIOUR",
  "VEHICLE_CONDITION",
  "ROUTE_ISSUE",
  "TIMING_DELAY",
  "SCHEDULING",
  "OTHER",
];
const NOTIFICATION_STATUSES = ["UNREAD", "READ"];
const GENDERS = ["MALE", "FEMALE", "OTHER"];
const RIDE_LEGS = ["PICKUP", "DROP"];
// Days that do NOT count as a scheduled ride day.
const NON_RIDE_DAY_STATUSES = ["OFF", "ABSENT"];

const fail = (res, message) => {
  const errorResponse = badRequestResponse(message);
  return res.status(errorResponse.status.code).json(errorResponse);
};

const getEmployeeFromReq = async (req) => {
  const userId = req.user?.userId;
  if (!userId) return null;
  return prisma.employee.findUnique({ where: { userId } });
};

function isValidDate(date) {
  return date instanceof Date && !isNaN(date.getTime());
}

const toKarachiDateParts = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date(date));
  const lookup = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
  };
};

const startOfDay = (date = new Date()) => {
  const { year, month, day } = toKarachiDateParts(date);
  return new Date(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+05:00`,
  );
};

const endOfDay = (date = new Date()) => {
  const { year, month, day } = toKarachiDateParts(date);
  return new Date(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:59.999+05:00`,
  );
};

const addKarachiDays = (date, days) => {
  const { year, month, day } = toKarachiDateParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return startOfDay(shifted);
};

// Saturday as week start in Asia/Karachi operational time
const saturdayOf = (date = new Date()) => {
  const { year, month, day } = toKarachiDateParts(date);
  const karachiWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceSaturday = (karachiWeekday + 1) % 7;
  return addKarachiDays(date, -daysSinceSaturday);
};

const LATE_GRACE_MINUTES = 10;

function computeArrivalStatus(pickupTime, scannedAt = new Date()) {
  if (!isValidDate(pickupTime) || !isValidDate(scannedAt)) return "PRESENT";
  const gracePeriodMs = LATE_GRACE_MINUTES * 60 * 1000;
  return scannedAt.getTime() > pickupTime.getTime() + gracePeriodMs
    ? "LATE"
    : "PRESENT";
}

function parsePagination(query) {
  const skip = parseInt(query.skip) || 0;
  const take = parseInt(query.take) || 10;
  return { skip: Math.max(0, skip), take: Math.max(1, Math.min(take, 100)) };
}

// Trim a string; "" -> null; null -> null; anything else -> undefined (invalid).
const optionalString = (value) => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
};

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

// Attendance has one row per (employee, day, LEG), so a day can have two rows.
// Returns:
//  - attendanceByDay:        { monday: "PRESENT", ... } (PICKUP leg wins, else DROP)
//  - attendanceByDayAndLeg:  { monday: { PICKUP: "PRESENT", DROP: "LATE" }, ... }
function buildAttendanceMaps(attendances, weekStart) {
  const attendanceByDay = {};
  const attendanceByDayAndLeg = {};

  for (const a of attendances) {
    const offset = Math.round(
      (startOfDay(a.rideDate).getTime() - weekStart.getTime()) / MS_PER_DAY,
    );
    if (offset < 0 || offset >= WEEK_FIELD_ORDER.length) continue;
    const key = WEEK_FIELD_ORDER[offset];

    (attendanceByDayAndLeg[key] ??= {})[a.leg] = a.status;
    if (a.leg === "PICKUP" || attendanceByDay[key] === undefined) {
      attendanceByDay[key] = a.status;
    }
  }

  return { attendanceByDay, attendanceByDayAndLeg };
}

// An employee can be a passenger on both legs of the same ride
// (unique key is rideId + employeeId + leg), so lookups by ride id must not
// assume the PICKUP leg exists (DROP_ONLY employees only have a DROP row).
const findEmployeePassengerForRide = (rideId, employeeId, args = {}) =>
  prisma.ridePassenger.findFirst({
    where: { rideId, employeeId },
    orderBy: { leg: "asc" }, // enum order: PICKUP before DROP
    ...args,
  });

const markNotificationAsRead = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return fail(res, "User not authenticated.");

    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification || notification.userId !== userId) {
      return fail(res, "Notification not found.");
    }

    const updated = await prisma.notification.update({
      where: { id: req.params.id },
      data: { status: "READ" },
    });

    const response = okResponse(updated, "Notification marked as read.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteNotification = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return fail(res, "User not authenticated.");

    // Single atomic, ownership-scoped delete (no find-then-delete race).
    const { count } = await prisma.notification.deleteMany({
      where: { id: req.params.id, userId },
    });
    if (count === 0) return fail(res, "Notification not found.");

    const response = okResponse(null, "Notification deleted successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyProfile = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return fail(res, "Employee profile not found.");

    const record = await prisma.employee.findUnique({
      where: { userId },
      include: {
        department: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        subArea: { select: { id: true, name: true } },
        block: { select: { id: true, name: true } },
      },
    });

    if (!record) return fail(res, "Employee profile not found.");

    const response = okResponse(record, "Profile retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateMyProfile = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

    const { name, contactNumber, cnic, gender, address } = req.body ?? {};
    const data = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return fail(res, "Name must be a non-empty string.");
      }
      data.name = name.trim();
    }

    if (contactNumber !== undefined) {
      const parsed = optionalString(contactNumber);
      if (parsed === undefined) return fail(res, "Invalid contact number.");
      data.contactNumber = parsed;
    }

    if (address !== undefined) {
      const parsed = optionalString(address);
      if (parsed === undefined) return fail(res, "Invalid address.");
      data.address = parsed;
    }

    if (gender !== undefined) {
      if (gender === null) {
        data.gender = null;
      } else {
        const normalizedGender = String(gender).trim().toUpperCase();
        if (!GENDERS.includes(normalizedGender)) {
          return fail(res, `Gender must be one of: ${GENDERS.join(", ")}.`);
        }
        data.gender = normalizedGender;
      }
    }

    if (cnic !== undefined) {
      // "" is stored as null: Employee.cnic is @unique, so multiple "" rows
      // would collide with each other.
      const parsed = optionalString(cnic);
      if (parsed === undefined) return fail(res, "Invalid CNIC.");

      if (parsed && parsed !== employee.cnic) {
        const existing = await prisma.employee.findUnique({
          where: { cnic: parsed },
        });
        if (existing && existing.id !== employee.id) {
          return fail(
            res,
            "Another employee is already registered with this CNIC.",
          );
        }
      }
      data.cnic = parsed;
    }

    let updated;
    try {
      updated = await prisma.employee.update({
        where: { id: employee.id },
        data,
      });
    } catch (err) {
      // Lost a race against another writer on the unique CNIC.
      if (err?.code === "P2002") {
        return fail(
          res,
          "Another employee is already registered with this CNIC.",
        );
      }
      throw err;
    }

    notifyRoles(STAFF_ROLES, {
      title: "Employee profile updated",
      body: `${updated.name} updated their profile.`,
      data: { employeeId: employee.id, type: "EMPLOYEE_PROFILE_UPDATED" },
      event: "notification-created",
    }).catch((err) =>
      console.error("[employee_controller] notifyRoles failed:", err),
    );

    const response = okResponse(updated, "Profile updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTodayRide = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

    const ridePassenger = await prisma.ridePassenger.findFirst({
      where: {
        employeeId: employee.id,
        ride: {
          rideDate: { gte: startOfDay(), lte: endOfDay() },
          status: { not: "CANCELLED" },
        },
      },
      // Deterministic when there are several rows today (multiple trips / both legs).
      orderBy: [{ ride: { rideDate: "asc" } }, { leg: "asc" }],
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
        leg: ridePassenger.leg,
        scheduledTime: ridePassenger.scheduledTime,
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
    if (!employee) return fail(res, "Employee profile not found.");

    const { confirmed } = req.body ?? {};
    if (typeof confirmed !== "boolean") {
      return fail(res, "`confirmed` (true/false) is required.");
    }

    const ridePassenger = await prisma.ridePassenger.findFirst({
      where: {
        employeeId: employee.id,
        ride: {
          rideDate: { gte: startOfDay(), lte: endOfDay() },
          status: { notIn: ["CANCELLED", "COMPLETED"] },
        },
      },
      orderBy: [{ ride: { rideDate: "asc" } }, { leg: "asc" }],
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
      return fail(
        res,
        "Today's ride hasn't been dispatched yet. Please check back closer to your pickup time.",
      );
    }

    const confirmationStatus = confirmed ? "CONFIRMED" : "DECLINED";
    const confirmedAt = new Date();

    // Apply to every leg of this ride so PICKUP/DROP rows never disagree.
    await prisma.ridePassenger.updateMany({
      where: { rideId: ridePassenger.rideId, employeeId: employee.id },
      data: { confirmationStatus, confirmedAt },
    });

    const driverUserId = ridePassenger.ride?.driver?.userId;
    if (driverUserId) {
      const routeName = ridePassenger.ride?.route?.routeName ?? "today's ride";
      notifyUser(driverUserId, {
        title: confirmed ? "Pickup confirmed" : "Pickup declined",
        body: `${employee.name} ${confirmed ? "confirmed" : "declined"} pickup for ${routeName}.`,
        data: {
          rideId: ridePassenger.rideId,
          type: confirmed ? "PICKUP_CONFIRMED" : "PICKUP_DECLINED",
        },
        event: "ride-response",
      }).catch((err) =>
        console.error("[employee_controller] notifyUser failed:", err),
      );
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: "RIDE_PICKUP_CONFIRMATION",
        model: "Ride",
        recordId: ridePassenger.rideId,
        after: { employeeId: employee.id, confirmed },
      },
    });

    const response = okResponse(
      {
        rideId: ridePassenger.rideId,
        confirmed,
        confirmationStatus,
        confirmedAt,
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
    if (!employee) return fail(res, "Employee profile not found.");

    const { skip, take } = parsePagination(req.query);
    const { status, startDate, endDate } = req.query;

    if (status !== undefined && !RIDE_STATUSES.includes(status)) {
      return fail(
        res,
        `Invalid status. Must be one of: ${RIDE_STATUSES.join(", ")}.`,
      );
    }

    const dateFilter = {};
    if (startDate) {
      const parsedStart = new Date(startDate);
      if (!isValidDate(parsedStart)) return fail(res, "Invalid startDate.");
      dateFilter.gte = startOfDay(parsedStart);
    }
    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (!isValidDate(parsedEnd)) return fail(res, "Invalid endDate.");
      dateFilter.lte = endOfDay(parsedEnd);
    }

    // Query Ride directly (not RidePassenger): an employee with both a PICKUP
    // and a DROP row on the same ride would otherwise produce duplicate rides
    // and inflate `total`.
    const where = {
      passengers: { some: { employeeId: employee.id } },
      ...(status && { status }),
      ...(Object.keys(dateFilter).length > 0 && { rideDate: dateFilter }),
    };

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        orderBy: { rideDate: "desc" },
        skip,
        take,
        include: {
          route: { select: { id: true, routeName: true } },
          driver: { select: { id: true, name: true, phone: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
          // Only THIS employee's own passenger rows (never other passengers).
          passengers: {
            where: { employeeId: employee.id },
            select: {
              leg: true,
              scheduledTime: true,
              confirmationStatus: true,
              confirmedAt: true,
            },
          },
        },
      }),
      prisma.ride.count({ where }),
    ]);

    const response = okResponse(
      { data: rides, total, skip, take },
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
    if (!employee) return fail(res, "Employee profile not found.");

    const ridePassenger = await findEmployeePassengerForRide(
      req.params.id,
      employee.id,
      {
        include: {
          ride: {
            include: {
              route: {
                select: { id: true, routeName: true, officeLocation: true },
              },
              driver: { select: { id: true, name: true, phone: true } },
              vehicle: {
                select: {
                  id: true,
                  vehicleNumber: true,
                  make: true,
                  model: true,
                },
              },
            },
          },
        },
      },
    );

    if (!ridePassenger) return fail(res, "Ride not found.");

    const response = okResponse(
      {
        ...ridePassenger.ride,
        leg: ridePassenger.leg,
        confirmationStatus: ridePassenger.confirmationStatus,
        confirmedAt: ridePassenger.confirmedAt,
      },
      "Ride retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const setRideResponse = async (req, res, next, { confirmed }) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

    const { id: rideId } = req.params;
    const { reason } = req.body ?? {};
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";

    if (!confirmed && !trimmedReason) {
      return fail(res, "A reason is required to reject a ride.");
    }

    const ridePassenger = await findEmployeePassengerForRide(
      rideId,
      employee.id,
      {
        include: {
          ride: {
            select: {
              status: true,
              driver: { select: { userId: true } },
              route: { select: { routeName: true } },
            },
          },
        },
      },
    );
    if (!ridePassenger) return fail(res, "Ride not found.");

    if (["CANCELLED", "COMPLETED"].includes(ridePassenger.ride?.status)) {
      return fail(
        res,
        `This ride is already ${ridePassenger.ride.status.toLowerCase()} and can no longer be ${confirmed ? "accepted" : "rejected"}.`,
      );
    }

    const confirmationStatus = confirmed ? "CONFIRMED" : "DECLINED";

    // Apply to every leg of this ride the employee is on.
    await prisma.ridePassenger.updateMany({
      where: { rideId, employeeId: employee.id },
      data: { confirmationStatus, confirmedAt: new Date() },
    });

    const driverUserId = ridePassenger.ride?.driver?.userId;
    if (driverUserId) {
      const routeName = ridePassenger.ride?.route?.routeName ?? "the ride";
      notifyUser(driverUserId, {
        title: confirmed ? "Ride accepted" : "Ride rejected",
        body: confirmed
          ? `${employee.name} accepted the ride for ${routeName}.`
          : `${employee.name} rejected the ride for ${routeName}: ${trimmedReason}`,
        data: { rideId, type: confirmed ? "RIDE_ACCEPTED" : "RIDE_REJECTED" },
        event: "ride-response",
      }).catch((err) =>
        console.error("[employee_controller] notifyUser failed:", err),
      );
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: confirmed
          ? "RIDE_ACCEPTED_BY_EMPLOYEE"
          : "RIDE_REJECTED_BY_EMPLOYEE",
        model: "Ride",
        recordId: rideId,
        after: {
          employeeId: employee.id,
          ...(trimmedReason && { reason: trimmedReason }),
        },
      },
    });

    const response = okResponse(
      { rideId, confirmed, confirmationStatus },
      confirmed
        ? "Ride accepted."
        : "Ride rejected. Dispatch has been notified.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const acceptRide = (req, res, next) =>
  setRideResponse(req, res, next, { confirmed: true });
const rejectRide = (req, res, next) =>
  setRideResponse(req, res, next, { confirmed: false });

// Saturday to Friday week
const getWeeklySchedule = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

    let requestedDate = new Date();
    if (req.query.weekStart) {
      requestedDate = new Date(req.query.weekStart);
      // An invalid Date makes Intl.DateTimeFormat throw a RangeError (500).
      if (!isValidDate(requestedDate)) return fail(res, "Invalid weekStart.");
    }

    const weekStart = saturdayOf(requestedDate);
    const weekEnd = endOfDay(addKarachiDays(weekStart, 6));

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
        select: { rideDate: true, leg: true, status: true },
      }),
    ]);

    if (!schedule) {
      const response = okResponse(null, "No schedule found for that week.");
      return res.status(response.status.code).json(response);
    }

    const { attendanceByDay, attendanceByDayAndLeg } = buildAttendanceMaps(
      attendances,
      weekStart,
    );

    const response = okResponse(
      { ...schedule, attendanceByDay, attendanceByDayAndLeg },
      "Weekly schedule retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// All weekly schedules (multiple weeks)
const getAllWeeklySchedules = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

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
    const lastWeekEnd = endOfDay(addKarachiDays(schedules[0].weekStart, 6));

    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        rideDate: { gte: firstWeekStart, lte: lastWeekEnd },
      },
      select: { rideDate: true, leg: true, status: true },
    });

    const schedulesWithAttendance = schedules.map((schedule) => ({
      ...schedule,
      ...buildAttendanceMaps(attendances, schedule.weekStart),
    }));

    const response = okResponse(
      schedulesWithAttendance,
      "All weekly schedules retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// Saturday to Friday week summary
const getWeekSummary = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

    const weekStart = saturdayOf();
    const weekEnd = endOfDay(addKarachiDays(weekStart, 6));

    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        rideDate: { gte: weekStart, lte: weekEnd },
      },
      select: {
        rideDate: true,
        status: true,
        ride: { select: { status: true } },
      },
    });

    // Attendance is stored per LEG (PICKUP/DROP), but the summary is per DAY:
    // collapse rows to one entry per Karachi day so a day with both legs
    // isn't counted twice.
    const days = new Map();
    for (const a of attendances) {
      const dayKey = startOfDay(a.rideDate).getTime();
      const entry = days.get(dayKey) ?? { attended: false, completed: false };
      if (["PRESENT", "LATE"].includes(a.status)) {
        entry.attended = true;
        if (a.ride?.status === "COMPLETED") entry.completed = true;
      }
      days.set(dayKey, entry);
    }

    const totalMarked = days.size;
    const present = [...days.values()].filter((d) => d.attended).length;
    const completed = [...days.values()].filter((d) => d.completed).length;

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

    // DayStatus also has ABSENT, which is not a ride day.
    const scheduledDayCount = schedule
      ? Object.values(schedule).filter(
          (s) => !NON_RIDE_DAY_STATUSES.includes(s),
        ).length
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
    if (!employee) return fail(res, "Employee profile not found.");

    const { qrCode, leg } = req.body ?? {};
    if (!qrCode || typeof qrCode !== "string") {
      return fail(res, "No QR code was scanned.");
    }

    if (leg !== undefined && leg !== null && !RIDE_LEGS.includes(leg)) {
      return fail(res, `Invalid leg. Must be one of: ${RIDE_LEGS.join(", ")}.`);
    }
    const normalizedLeg = leg === "DROP" ? "DROP" : "PICKUP";

    const scannedUser = await prisma.user.findUnique({
      where: { qrCode },
      include: { driver: { select: { id: true, name: true } } },
    });

    if (!scannedUser?.driver || !scannedUser.isActive) {
      return fail(
        res,
        "That doesn't look like a driver's QR code. Ask your driver to show their attendance code.",
      );
    }

    // A driver can run several rides/trips in a day. Only match the one this
    // employee is actually a passenger on for this leg — otherwise the first
    // unrelated ride wins and the employee is wrongly told they're not listed.
    const ride = await prisma.ride.findFirst({
      where: {
        driverId: scannedUser.driver.id,
        status: { in: ["STARTED", "ARRIVED"] },
        rideDate: { gte: startOfDay(), lte: endOfDay() },
        passengers: { some: { employeeId: employee.id, leg: normalizedLeg } },
      },
      orderBy: { rideDate: "desc" },
      select: {
        id: true,
        rideDate: true,
        pickupTime: true,
        route: { select: { routeName: true } },
        passengers: {
          where: { employeeId: employee.id, leg: normalizedLeg },
          select: { scheduledTime: true },
        },
      },
    });

    if (!ride) {
      return fail(
        res,
        `${scannedUser.driver.name} doesn't have a ride in progress that you're listed on for this ${normalizedLeg === "DROP" ? "drop" : "pickup"}. Contact dispatch if this looks wrong.`,
      );
    }

    const rideDate = startOfDay(ride.rideDate);

    // Idempotent: a repeat scan must not overwrite the original arrival time
    // (a later re-scan could flip PRESENT -> LATE).
    const existing = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate_leg: {
          employeeId: employee.id,
          rideDate,
          leg: normalizedLeg,
        },
      },
    });
    if (existing && ["PRESENT", "LATE"].includes(existing.status)) {
      const response = okResponse(
        {
          ...existing,
          routeName: ride.route?.routeName,
          driverName: scannedUser.driver.name,
        },
        "Attendance was already marked.",
      );
      return res.status(response.status.code).json(response);
    }

    const now = new Date();
    // Lateness is only meaningful for the pickup leg.
    const scheduledTime = ride.passengers[0]?.scheduledTime ?? ride.pickupTime;
    const status =
      normalizedLeg === "PICKUP"
        ? computeArrivalStatus(scheduledTime, now)
        : "PRESENT";

    const attendance = await prisma.attendance.upsert({
      where: {
        employeeId_rideDate_leg: {
          employeeId: employee.id,
          rideDate,
          leg: normalizedLeg,
        },
      },
      update: { status, rideId: ride.id, arrivalTime: now },
      create: {
        employeeId: employee.id,
        rideId: ride.id,
        rideDate,
        leg: normalizedLeg,
        status,
        arrivalTime: now,
      },
    });

    // scannedUser IS the driver's user account (that's what the QR encodes),
    // so scannedUser.id is already the driverUserId — no extra
    // driver -> userId join needed here, unlike markMyAttendance below
    // where we only have the driver relation and must pull .driver.userId.
    notifyUser(scannedUser.id, {
      title: "Passenger checked in",
      body: `${employee.name} checked in for ${ride.route?.routeName ?? "the ride"}${status === "LATE" ? " (late)" : ""}.`,
      // type aligned with driver_controller's attendance notifications
      // (ATTENDANCE_UPDATED) — both represent the same underlying
      // Attendance-record change, just triggered by different actors.
      data: { rideId: ride.id, type: "ATTENDANCE_UPDATED", status },
      event: "attendance-updated",
    }).catch((err) =>
      console.error("[employee_controller] notifyUser failed:", err),
    );

    const response = okResponse(
      {
        ...attendance,
        routeName: ride.route?.routeName,
        driverName: scannedUser.driver.name,
      },
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
    if (!employee) return fail(res, "Employee profile not found.");

    const { status = "PRESENT", leg } = req.body ?? {};
    if (!["PRESENT", "LATE"].includes(status)) {
      return fail(res, "Invalid attendance status.");
    }

    if (leg !== undefined && leg !== null && !RIDE_LEGS.includes(leg)) {
      return fail(res, `Invalid leg. Must be one of: ${RIDE_LEGS.join(", ")}.`);
    }
    const normalizedLeg = leg === "DROP" ? "DROP" : "PICKUP";

    const ridePassengers = await prisma.ridePassenger.findMany({
      where: {
        employeeId: employee.id,
        leg: normalizedLeg,
        ride: {
          rideDate: { gte: startOfDay(), lte: endOfDay() },
          status: { in: ["STARTED", "ARRIVED"] },
        },
      },
      select: {
        rideId: true,
        leg: true,
        ride: {
          select: {
            rideDate: true,
            driver: { select: { userId: true } },
            route: { select: { routeName: true } },
          },
        },
      },
    });

    if (ridePassengers.length === 0) {
      return fail(
        res,
        "No ride is currently in progress for you — attendance can only be scanned once your driver has started the ride.",
      );
    }

    if (ridePassengers.length > 1) {
      return fail(
        res,
        "You're listed on more than one active ride right now — this is a scheduling conflict. Please contact dispatch before marking attendance.",
      );
    }

    const ridePassenger = ridePassengers[0];
    const rideDate = startOfDay(ridePassenger.ride?.rideDate ?? new Date());

    // Idempotent: don't overwrite an existing PRESENT/LATE record.
    const existing = await prisma.attendance.findUnique({
      where: {
        employeeId_rideDate_leg: {
          employeeId: employee.id,
          rideDate,
          leg: normalizedLeg,
        },
      },
    });
    if (existing && ["PRESENT", "LATE"].includes(existing.status)) {
      const response = okResponse(existing, "Attendance was already marked.");
      return res.status(response.status.code).json(response);
    }

    const arrivalTime = new Date();
    const attendance = await prisma.attendance.upsert({
      where: {
        employeeId_rideDate_leg: {
          employeeId: employee.id,
          rideDate,
          leg: normalizedLeg,
        },
      },
      update: { status, rideId: ridePassenger.rideId, arrivalTime },
      create: {
        employeeId: employee.id,
        rideId: ridePassenger.rideId,
        rideDate,
        leg: normalizedLeg,
        status,
        arrivalTime,
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
        data: {
          rideId: ridePassenger.rideId,
          type: "ATTENDANCE_UPDATED",
          status,
        },
        event: "attendance-updated",
      }).catch((err) =>
        console.error("[employee_controller] notifyUser failed:", err),
      );
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
    if (!employee) return fail(res, "Employee profile not found.");

    const { category, title, description, rideId } = req.body ?? {};
    const resolvedCategory = category || "OTHER";

    if (!COMPLAINT_CATEGORIES.includes(resolvedCategory)) {
      return fail(
        res,
        `Invalid category. Must be one of: ${COMPLAINT_CATEGORIES.join(", ")}.`,
      );
    }

    // typeof check first: `.trim()` on a non-string would throw a TypeError (500).
    if (typeof title !== "string" || !title.trim()) {
      return fail(res, "Title is required.");
    }

    if (
      description !== undefined &&
      description !== null &&
      typeof description !== "string"
    ) {
      return fail(res, "Description must be text.");
    }

    if (rideId !== undefined && rideId !== null && typeof rideId !== "string") {
      return fail(res, "Invalid rideId.");
    }

    if (
      ["DRIVER_BEHAVIOUR", "VEHICLE_CONDITION"].includes(resolvedCategory) &&
      !rideId
    ) {
      return fail(
        res,
        resolvedCategory === "DRIVER_BEHAVIOUR"
          ? "Please select the related ride so we know which driver this is about."
          : "Please select the related ride so we know which vehicle this is about.",
      );
    }

    let driverId;
    let vehicleId;

    if (rideId) {
      // Any leg counts — DROP_ONLY employees have no PICKUP row.
      const ridePassenger = await findEmployeePassengerForRide(
        rideId,
        employee.id,
        {
          include: { ride: { select: { driverId: true, vehicleId: true } } },
        },
      );
      if (!ridePassenger) {
        return fail(res, "That ride isn't associated with your account.");
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

    // Only notify staff if the complaint was actually created.
    const complaint = response?.data;
    if (complaint?.id) {
      notifyRoles(STAFF_ROLES, {
        title: "New complaint filed",
        body: `${employee.name} filed a complaint: ${title.trim()}`,
        data: { complaintId: complaint.id, type: "COMPLAINT_CREATED" },
        event: "notification-created",
      }).catch((err) =>
        console.error("[employee_controller] notifyRoles failed:", err),
      );
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyComplaints = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) return fail(res, "Employee profile not found.");

    const { skip, take } = parsePagination(req.query);
    const { status } = req.query;

    if (status !== undefined && !COMPLAINT_STATUSES.includes(status)) {
      return fail(
        res,
        `Invalid status. Must be one of: ${COMPLAINT_STATUSES.join(", ")}.`,
      );
    }

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
    if (!employee) return fail(res, "Employee profile not found.");

    const take = Math.max(1, Math.min(parseInt(req.query.take) || 5, 20));

    // Query Ride directly so a ride with both PICKUP and DROP rows for this
    // employee is returned once, not twice.
    const rides = await prisma.ride.findMany({
      where: { passengers: { some: { employeeId: employee.id } } },
      take,
      orderBy: { rideDate: "desc" },
      select: {
        id: true,
        rideDate: true,
        status: true,
        route: { select: { routeName: true } },
        driver: { select: { id: true, name: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
    });

    const data = rides.map((ride) => ({
      id: ride.id,
      rideDate: ride.rideDate,
      status: ride.status,
      routeName: ride.route?.routeName ?? null,
      driver: ride.driver
        ? { id: ride.driver.id, name: ride.driver.name }
        : null,
      vehicle: ride.vehicle
        ? { id: ride.vehicle.id, vehicleNumber: ride.vehicle.vehicleNumber }
        : null,
    }));

    const response = okResponse(data, "Recent rides retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return fail(res, "User not authenticated.");

    const { skip, take } = parsePagination(req.query);
    const { status } = req.query;

    if (status !== undefined && !NOTIFICATION_STATUSES.includes(status)) {
      return fail(
        res,
        `Invalid status. Must be one of: ${NOTIFICATION_STATUSES.join(", ")}.`,
      );
    }

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
    if (!userId) return fail(res, "User not authenticated.");

    const { count } = await prisma.notification.updateMany({
      where: { userId, status: "UNREAD" },
      data: { status: "READ" },
    });

    const response = okResponse(
      { markedCount: count },
      `${count} notification(s) marked as read.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
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
