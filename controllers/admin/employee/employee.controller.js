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

// Pickup times are free-text (e.g. "6:00 PM", "8:00AM", "1: 30PM" — see the
// same tolerant parsing in home.tsx on the driver app). Grace period before
// a scan counts as LATE rather than PRESENT.
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

// Decides PRESENT vs LATE from the ride's scheduled pickup time rather than
// trusting whatever status the client sends — a scan is proof of *when*
// someone showed up, so the server should be the one deciding what that
// means, not the app. Unparsable/missing pickup times fall back to PRESENT
// rather than guessing.
//
// NOTE: pickupTime strings ("6:00 PM" etc.) are operational/local times, so
// this compares against the server's local wall clock, not UTC — unlike
// startOfDay/endOfDay above, which deliberately use UTC for date-bucketing.
// If this server ever runs with TZ=UTC while pickup times are meant in
// local (e.g. Asia/Karachi) time, this comparison will be off by the UTC
// offset — worth confirming your deployment's TZ env var before relying on
// this in production.
function computeArrivalStatus(pickupTime, scannedAt = new Date()) {
  const scheduledMinutes = parsePickupTimeToMinutes(pickupTime);
  if (scheduledMinutes === null) return "PRESENT";
  const scannedMinutes = scannedAt.getHours() * 60 + scannedAt.getMinutes();
  return scannedMinutes > scheduledMinutes + LATE_GRACE_MINUTES ? "LATE" : "PRESENT";
}

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

// The Ride (PENDING or later) is provisioned by dispatch the moment the
// WeeklySchedule is assigned (see services/ridePlanning.js), so — same as
// driver_controller's getTodayRide — there is no WeeklySchedule fallback
// here anymore. Employee and driver now read from the exact same source
// of truth for "does a ride exist today", so they can no longer disagree
// about whether today has a ride. A missing Ride is a normal "day off /
// not dispatched yet" state, not an error, so this returns 200 + null
// rather than a 400 (matching driver_controller's convention) so the app
// can render its empty state instead of an error banner.
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
        // These live on RidePassenger, not Ride — this is the employee's own
        // pickup confirmation, separate from the ride's dispatch status
        // (Ride.status), so it has to be spread in explicitly here.
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

// Confirmation now lives on RidePassenger.confirmationStatus (see
// schema.prisma) instead of only being logged to AuditLog — the AuditLog
// write stays for the historical "who/when" trail, but confirmationStatus
// is what the app actually reads back, so tapping Confirm/Decline has a
// visible, persistent effect.
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
      select: { id: true, rideId: true },
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

// A missing WeeklySchedule row (week not planned yet, employee is new,
// or the requested week is simply in the past/future with nothing
// assigned) is a normal empty state, not an error — same convention as
// getTodayRide above. Returning 400 here made every client call for an
// unplanned week fail, which surfaced as a false "API error" banner on
// the home screen and made it impossible to render "no schedule yet"
// as a normal UI state instead of an error.
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
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

    const [schedule, attendances] = await Promise.all([
      prisma.weeklySchedule.findUnique({
        where: { employeeId_weekStart: { employeeId: employee.id, weekStart } },
        include: {
          route: { select: { id: true, routeName: true } },
          driver: { select: { id: true, name: true, phone: true } },
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
      }),
      // The schedule's own day fields (PICKUP/DROP/BOTH/OFF) only describe
      // the plan, not what actually happened — pull real Attendance rows
      // for the week so the client can show a day as genuinely completed
      // (PRESENT/LATE), missed (NO_SHOW), or absent, instead of just
      // echoing back the static plan forever, even for days long past.
      prisma.attendance.findMany({
        where: {
          employeeId: employee.id,
          rideDate: { gte: weekStart, lte: endOfDay(weekEnd) },
        },
        select: { rideDate: true, status: true },
      }),
    ]);

    if (!schedule) {
      const response = okResponse(null, "No schedule found for that week.");
      return res.status(response.status.code).json(response);
    }

    // weekStart is always a Monday (see mondayOf), so the offset in days
    // from weekStart maps directly onto this fixed field order — no need
    // to look at the actual weekday of rideDate.
    const WEEK_FIELD_ORDER = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
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

// This-week snapshot for the home screen: rides completed/remaining and
// attendance rate. "Completed" is driven by the ride's own Ride.status
// (only true once the driver ends the ride), not by this employee's
// Attendance row alone — attendance PRESENT/LATE just confirms pickup.
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
      select: {
        status: true,
        // Need the linked ride's own status to tell "employee scanned in"
        // apart from "ride is actually finished" — see `completed` below.
        ride: { select: { status: true } },
      },
    });

    const totalMarked = attendances.length;
    const present = attendances.filter((a) =>
      ["PRESENT", "LATE"].includes(a.status),
    ).length;

    // A ride only counts as "completed" once the driver has actually
    // ended it (Ride.status === "COMPLETED"). Attendance being
    // PRESENT/LATE only means this employee's QR scan was recorded at
    // pickup — the ride can still be STARTED/ARRIVED for a while after
    // that, so it must not be counted as completed yet. (Attendance
    // rows created before Trips/rideId linking existed may have no
    // `ride` at all; those can't be confirmed completed, so they're
    // excluded here same as an in-progress ride would be.)
    const completed = attendances.filter(
      (a) => ["PRESENT", "LATE"].includes(a.status) && a.ride?.status === "COMPLETED",
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

// ---------------------------------------------------------------------------
// Attendance (self-scan)
// ---------------------------------------------------------------------------

// POST /employees/me/attendance/scan — employee scans the DRIVER's QR code
// (shown on the driver's own /scan screen) with their camera. This is a
// stronger disambiguation than markMyAttendance below: instead of inferring
// "which ride" from the employee's own schedule for today (which still
// needs a fallback if they're somehow a passenger on more than one active
// ride), the scanned code identifies the exact driver standing in front of
// them, and from there their exact active ride — there's no guessing.
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

    // Resolve the scanned code to a driver. User.qrCode is the same token
    // rendered on GET /drivers/me/qr-code (driver_controller.js), so this
    // is the driver's badge, not the employee's own.
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

    // A driver can only ever have ONE ride STARTED/ARRIVED at a time
    // (enforced in driver_controller.js's applyRideStatusTransition), so
    // this is guaranteed to resolve to at most one ride.
    const ride = await prisma.ride.findFirst({
      where: {
        driverId: scannedUser.driver.id,
        status: { in: ["STARTED", "ARRIVED"] },
      },
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

    // Only match against a ride that's actually STARTED/ARRIVED right now.
    // A driver can only ever have one active ride at a time (enforced in
    // driver_controller.js's applyRideStatusTransition), so filtering on
    // that status is what guarantees at most one candidate here — matching
    // on "any ride today" (the old behavior) was the root cause of
    // attendance silently landing on the wrong ride when an employee
    // happened to be listed on more than one trip for the day.
    const ridePassengers = await prisma.ridePassenger.findMany({
      where: {
        employeeId: employee.id,
        ride: {
          rideDate: { gte: startOfDay(), lte: endOfDay() },
          status: { in: ["STARTED", "ARRIVED"] },
        },
      },
      select: { rideId: true },
    });

    if (ridePassengers.length === 0) {
      const errorResponse = badRequestResponse(
        "No ride is currently in progress for you — attendance can only be scanned once your driver has started the ride.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (ridePassengers.length > 1) {
      // Should be effectively impossible given the one-active-ride-per-driver
      // rule, but if two different drivers somehow have active rides that
      // both list this employee, don't guess — surface it as a scheduling
      // conflict instead of silently picking one.
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
    const resolvedCategory = category || "OTHER";

    if (!title || !title.trim()) {
      const errorResponse = badRequestResponse("Title is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    if (!description || !description.trim()) {
      const errorResponse = badRequestResponse("Description is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Driver/vehicle complaints are only useful if we know *which* driver
    // or vehicle — and the only source of truth for that is the selected
    // ride (Complaint has no other way to point at a specific driver).
    // Without this, these categories would save with a title/description
    // but no driverId/vehicleId, same as the bug that was happening before.
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
      // Also pulls the ride's driverId/vehicleId so the complaint can be
      // attached to them directly. Derived server-side from the validated
      // ride record rather than trusted from the client — the client has
      // no reliable way to know these IDs, and shouldn't be able to set
      // them directly on a Complaint anyway.
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
      description: description.trim(),
      ...(rideId && { rideId }),
      ...(driverId && { driverId }),
      ...(vehicleId && { vehicleId }),
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
      { data:notifications ?? [], total, limit: parseInt(limit), skip: parseInt(skip) },
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
  markAttendanceByQr,
  createComplaint,
  getMyComplaints,
  getRecentRides,
  getNotifications,
};