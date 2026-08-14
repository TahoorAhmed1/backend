const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");

// ---------------------------------------------------------------------------
// Helper: resolve the logged-in employee from the authenticated user.
// Assumes an auth middleware has already run and attached `req.user`
// (the User row) to the request — adjust this if your auth middleware
// exposes the employee differently (e.g. req.user.employeeId).
// ---------------------------------------------------------------------------
const getEmployeeFromReq = async (req) => {
  // req.user is the decoded JWT payload set by verifyUserByToken: { userId, role }
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

// Normalizes any date to the Monday of its week (UTC), matching how
// WeeklySchedule.weekStart is stored.
const mondayOf = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff, 0, 0, 0, 0));
};

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

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

    // Employees can self-edit contact/personal details only. Designation,
    // department, entity, office location, and service type stay
    // dispatch/HR-managed, matching the schema's ownership.
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
        ...(name && { name }),
        ...(contactNumber && { contactNumber }),
        ...(cnic && { cnic }),
        ...(gender && { gender }),
        ...(address && { address }),
      },
    });

    const response = okResponse(updated, "Profile updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Today's ride
// ---------------------------------------------------------------------------

// Maps JS Date#getUTCDay() (0 = Sunday) to WeeklySchedule's day columns.
const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

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

    // Live ride already exists (dispatch/driver has started today's run) —
    // this is the authoritative, trackable version.
    if (ridePassenger) {
      const response = okResponse(
        { ...ridePassenger.ride, source: "RIDE" },
        "Today's ride retrieved successfully.",
      );
      return res.status(response.status.code).json(response);
    }

    // No live Ride yet. Fall back to this week's WeeklySchedule so the
    // employee can still see today's planned pickup/drop, route, driver,
    // and vehicle ahead of dispatch actually creating the Ride row.
    const weekStart = mondayOf();
    const schedule = await prisma.weeklySchedule.findUnique({
      where: { employeeId_weekStart: { employeeId: employee.id, weekStart } },
      include: {
        route: {
          select: { id: true, routeName: true, routeCode: true, officeLocation: true },
        },
        driver: { select: { id: true, name: true, phone: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
    });

    const todayKey = DAY_KEYS[new Date().getUTCDay()];
    const todayStatus = schedule?.[todayKey];

    if (!schedule || !todayStatus || todayStatus === "OFF" || schedule.status !== "ACTIVE") {
      const errorResponse = badRequestResponse("No ride scheduled for today.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        id: null,
        rideDate: startOfDay(),
        status: "SCHEDULED",
        dayStatus: todayStatus,
        pickupTime: schedule.pickupTime,
        dropTime: schedule.dropTime,
        route: schedule.route,
        driver: schedule.driver,
        vehicle: schedule.vehicle,
        source: "SCHEDULE",
      },
      "Today's scheduled ride retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// Pickup confirmation isn't tracked by its own model/column yet — we log
// it to AuditLog (generic action/before/after trail) so dispatch has a
// record without needing a schema change. Swap this for a dedicated
// column/table if confirmations need to drive other logic later.
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
      select: { rideId: true },
    });

    if (!ridePassenger) {
      const errorResponse = badRequestResponse(
        "Today's ride hasn't been dispatched yet. Please check back closer to your pickup time.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
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
      { rideId: ridePassenger.rideId, confirmed },
      confirmed
        ? "Pickup confirmed."
        : "Pickup declined. Dispatch has been notified.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// GET /rides — paginated ride history for this employee, via their
// RidePassenger links (Employee has no direct Ride relation).
const getMyRides = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { skip = 0, take = 10, status, startDate, endDate } = req.query;

    const ridePassengers = await prisma.ridePassenger.findMany({
      where: {
        employeeId: employee.id,
        ride: {
          ...(status && { status }),
          ...((startDate || endDate) && {
            rideDate: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }),
        },
      },
      skip: parseInt(skip),
      take: parseInt(take),
      orderBy: { ride: { rideDate: "desc" } },
      include: {
        ride: {
          include: {
            route: { select: { id: true, routeName: true } },
            driver: { select: { id: true, name: true, phone: true } },
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
      },
    });

    const response = okResponse(
      ridePassengers.map((rp) => rp.ride),
      "Rides retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// GET /rides/:id — a single ride this employee is/was a passenger on.
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

// Same "no dedicated confirmation model" situation as confirmTodayRide —
// accept/reject on any ride (not just today's) is logged to AuditLog.
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
    });
    if (!ridePassenger) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: confirmed ? "RIDE_ACCEPTED_BY_EMPLOYEE" : "RIDE_REJECTED_BY_EMPLOYEE",
        model: "Ride",
        recordId: rideId,
        after: { employeeId: employee.id, ...(reason && { reason: String(reason).trim() }) },
      },
    });

    const response = okResponse(
      { rideId, confirmed },
      confirmed ? "Ride accepted." : "Ride rejected. Dispatch has been notified.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const acceptRide = (req, res, next) => setRideResponse(req, res, next, { confirmed: true });
const rejectRide = (req, res, next) => setRideResponse(req, res, next, { confirmed: false });

// ---------------------------------------------------------------------------
// Weekly schedule
// ---------------------------------------------------------------------------

const getWeeklySchedule = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const weekStart = req.query.weekStart
      ? mondayOf(new Date(req.query.weekStart))
      : mondayOf();

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { employeeId_weekStart: { employeeId: employee.id, weekStart } },
      include: {
        route: { select: { id: true, routeName: true } },
        driver: { select: { id: true, name: true, phone: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
      },
    });

    if (!schedule) {
      const errorResponse = badRequestResponse(
        "No schedule found for that week.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      schedule,
      "Weekly schedule retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// This-week snapshot for the home screen: rides completed/remaining and
// attendance rate, derived from Attendance rows in the current week.
const getWeekSummary = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const weekStart = mondayOf();
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        rideDate: { gte: weekStart, lte: weekEnd },
      },
      select: { status: true },
    });

    const totalMarked = attendances.length;
    const present = attendances.filter((a) =>
      ["PRESENT", "LATE"].includes(a.status),
    ).length;

    const schedule = await prisma.weeklySchedule.findUnique({
      where: { employeeId_weekStart: { employeeId: employee.id, weekStart } },
      select: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: true,
      },
    });

    const scheduledDayCount = schedule
      ? Object.values(schedule).filter((s) => s !== "OFF").length
      : 0;

    const response = okResponse(
      {
        ridesCompleted: present,
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

// ---------------------------------------------------------------------------
// Attendance (self-scan)
// ---------------------------------------------------------------------------

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

    const ridePassenger = await prisma.ridePassenger.findFirst({
      where: {
        employeeId: employee.id,
        ride: { rideDate: { gte: startOfDay(), lte: endOfDay() } },
      },
      select: { rideId: true },
    });

    if (!ridePassenger) {
      const errorResponse = badRequestResponse(
        "Today's ride hasn't been dispatched yet, so attendance can't be scanned.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

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

    const response = okResponse(attendance, "Attendance marked successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

const createComplaint = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { category, title, description, rideId } = req.body;

    if (!title || !title.trim()) {
      const errorResponse = badRequestResponse("Title is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    if (!description || !description.trim()) {
      const errorResponse = badRequestResponse("Description is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (rideId) {
      const ridePassenger = await prisma.ridePassenger.findUnique({
        where: { rideId_employeeId: { rideId, employeeId: employee.id } },
      });
      if (!ridePassenger) {
        const errorResponse = badRequestResponse(
          "That ride isn't associated with your account.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await createRecord(prisma.complaint, {
      employeeId: employee.id,
      category: category || "OTHER",
      title: title.trim(),
      description: description.trim(),
      ...(rideId && { rideId }),
    });

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

    const { skip = 0, take = 10, status } = req.query;

    const options = {
      where: {
        employeeId: employee.id,
        ...(status && { status }),
      },
      skip: parseInt(skip),
      take: parseInt(take),
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.complaint, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// Recent rides an employee can tie a complaint to (used by the "Related
// Ride" dropdown on the complaint screen).
const getRecentRides = async (req, res, next) => {
  try {
    const employee = await getEmployeeFromReq(req);
    if (!employee) {
      const errorResponse = badRequestResponse("Employee profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { take = 5 } = req.query;

    const ridePassengers = await prisma.ridePassenger.findMany({
      where: { employeeId: employee.id },
      take: parseInt(take),
      orderBy: { ride: { rideDate: "desc" } },
      include: {
        ride: {
          select: {
            id: true,
            rideDate: true,
            route: { select: { routeName: true } },
          },
        },
      },
    });

    const rides = ridePassengers.map((rp) => ({
      id: rp.ride.id,
      rideDate: rp.ride.rideDate,
      routeName: rp.ride.route.routeName,
    }));

    const response = okResponse(rides, "Recent rides retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const errorResponse = badRequestResponse("User not authenticated.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { limit = 10, skip = 0, status } = req.query;

    const notifications = await prisma.notification.findMany({
      where: {
        userId,
        ...(status && { status }),
      },
      take: parseInt(limit),
      skip: parseInt(skip),
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.notification.count({
      where: {
        userId,
        ...(status && { status }),
      },
    });

    const response = okResponse(
      { data:notifications, total, limit: parseInt(limit), skip: parseInt(skip) },
      "Notifications retrieved successfully.",
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
  getWeekSummary,
  markMyAttendance,
  createComplaint,
  getMyComplaints,
  getRecentRides,
  getNotifications,
};