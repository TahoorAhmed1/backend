const { prisma } = require("../../../lib/prisma");
const QRCode = require("qrcode");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");

// ---------------------------------------------------------------------------
// Helper: resolve the logged-in driver from the authenticated user.
// Assumes an auth middleware has already run and attached `req.user`
// (the User row) to the request — adjust this if your auth middleware
// exposes the driver differently (e.g. req.user.driverId).
// ---------------------------------------------------------------------------
const getDriverFromReq = async (req) => {
  // req.user is the decoded JWT payload set by verifyUserByToken: { userId, role }
  const userId = req.user?.userId;
  if (!userId) return null;

  return prisma.driver.findUnique({ where: { userId } });
};

// UTC-safe day boundaries — Prisma/Postgres store DateTime in UTC, so
// building these off the server's local time (Date#setHours) can shift
// the window by hours and miss rows that are actually there.
const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
};

const endOfDay = (date = new Date()) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
};

// Note: the Monday-of-week / weekday-key helpers that used to live here
// were only needed for the WeeklySchedule fallback logic in getTodayRide
// and startTodayRide. That logic now lives in services/ridePlanning.js,
// which runs when dispatch assigns the schedule rather than when the
// driver opens the app — see that file for the equivalent helpers.

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const getMyProfile = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await getRecordById(prisma.driver, driver.id, {
      vendor: {
        select: { id: true, name: true, shortName: true },
      },
      vehicle: {
        select: {
          id: true,
          vehicleNumber: true,
          make: true,
          model: true,
          type: true,
          capacity: true,
        },
      },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Driver not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateMyProfile = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Drivers can only self-edit their name/phone. Everything else
    // (license, CNIC, vendor, shift, vehicle) is managed by dispatch.
    const { name, phone } = req.body;

    const response = await updateRecord(prisma.driver, driver.id, {
      ...(name && { name }),
      ...(phone && { phone }),
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// QR code (attendance badge)
// ---------------------------------------------------------------------------

// GET /drivers/me/qr-code — regenerates the badge image on the fly from
// User.qrCode (the stored token), rather than serving whatever PNG the
// seed script wrote to disk at seed time. The token in the DB is the
// source of truth; the image is just a rendering of it, so this stays
// correct even if the server that seeded the data isn't the one serving
// this request, or the seed-time files never made it to this machine.
//
// ?format=png (default) -> raw image, good for <img src="/drivers/me/qr-code">
// ?format=base64         -> JSON { qrCode: "data:image/png;base64,..." },
//                            good if the mobile app wants to cache it
//                            itself or embed it inline in other JSON.
const getMyQrCode = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (!driver.userId) {
      const errorResponse = badRequestResponse("No login is linked to this driver yet.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const user = await prisma.user.findUnique({
      where: { id: driver.userId },
      select: { qrCode: true },
    });

    if (!user?.qrCode) {
      const errorResponse = badRequestResponse("No QR code has been generated for this driver yet.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (req.query.format === "base64") {
      const dataUrl = await QRCode.toDataURL(user.qrCode, {
        width: 400,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      const response = okResponse({ qrCode: dataUrl }, "QR code retrieved successfully.");
      return res.status(response.status.code).json(response);
    }

    const pngBuffer = await QRCode.toBuffer(user.qrCode, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    res.set("Content-Type", "image/png");
    return res.send(pngBuffer);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Rides
// ---------------------------------------------------------------------------

const getTodayRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // The Ride is now provisioned as PENDING the moment dispatch assigns
    // the WeeklySchedule (see services/ridePlanning.js), so there is no
    // more "fall back to WeeklySchedule" branch here — if nothing comes
    // back, dispatch simply hasn't assigned this driver a route today.
    //
    // IMPORTANT: findFirst() used to live here, which silently discarded
    // every ride but one whenever a driver had more than one route/trip
    // assigned for today (a real case — e.g. a morning run and an evening
    // run, or several distinct routes on the same day). Ride identity is
    // per (driver, trip, day) in ridePlanning.js, not per (driver, day), so
    // nothing elsewhere assumes a driver has at most one ride today.
    // findMany() here so the app can show all of them.
    const rides = await prisma.ride.findMany({
      where: {
        driverId: driver.id,
        rideDate: { gte: startOfDay(), lte: endOfDay() },
      },
      include: {
        route: {
          select: { id: true, routeName: true, routeCode: true, officeLocation: true },
        },
        vehicle: {
          select: { id: true, vehicleNumber: true, make: true, model: true },
        },
        passengers: { select: { id: true } },
      },
      orderBy: [{ pickupTime: "asc" }, { createdAt: "asc" }],
    });

    // No rides is a normal, everyday state now (day off, or dispatch hasn't
    // assigned a route yet) rather than an edge case — return an empty list
    // as a successful response, not an error, so the app can render its
    // empty state instead of an error banner.
    const response = okResponse(
      rides.map((ride) => ({ ...ride, passengerCount: ride.passengers?.length, source: "RIDE" })),
      rides.length
        ? "Today's rides retrieved successfully."
        : "No ride scheduled for today.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyRides = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { skip = 0, take = 10, status } = req.query;

    const options = {
      where: {
        driverId: driver.id,
        ...(status && { status }),
      },
  
      include: {
        route: { select: { id: true, routeName: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        passengers: { select: { id: true } },
      },
      orderBy: { rideDate: "desc" },
    };

    const response = await getRecords(prisma.ride, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const RIDE_STATUS_TRANSITIONS = {
  PENDING: ["STARTED", "CANCELLED"],
  STARTED: ["ARRIVED", "COMPLETED"],
  ARRIVED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

// Ride statuses that count as "currently active" for a driver — i.e. the
// driver is out on this ride and it isn't done yet.
const ACTIVE_RIDE_STATUSES = ["STARTED", "ARRIVED"];

// Shared by updateRideStatus and the start/complete/cancel convenience
// endpoints below, so the transition rules only live in one place.
const applyRideStatusTransition = async ({ driver, rideId, nextStatus, extraData = {} }) => {
  const ride = await prisma.ride.findUnique({ where: { id: rideId } });
  if (!ride || ride.driverId !== driver.id) {
    return { error: badRequestResponse("Ride not found.") };
  }

  const allowedNext = RIDE_STATUS_TRANSITIONS[ride.status] || [];
  if (!allowedNext.includes(nextStatus)) {
    return {
      error: badRequestResponse(
        `Cannot move ride from ${ride.status} to ${nextStatus}.`,
      ),
    };
  }

  // A driver can have several rides queued up today (see getTodayRide), but
  // can only ever be physically out on ONE of them at a time. Without this
  // check a driver could hit "Start" on two PENDING rides back to back and
  // the app would then have two STARTED rides with no way to tell which one
  // a QR scan belongs to — that's the root cause of the "which ride is this
  // attendance for" confusion. Block starting a new ride until the current
  // one is finished (COMPLETED) or called off (CANCELLED).
  if (nextStatus === "STARTED") {
    const otherActiveRide = await prisma.ride.findFirst({
      where: {
        driverId: driver.id,
        id: { not: rideId },
        status: { in: ACTIVE_RIDE_STATUSES },
      },
      select: { id: true, route: { select: { routeName: true } } },
    });
    if (otherActiveRide) {
      return {
        error: badRequestResponse(
          `You already have a ride in progress (${otherActiveRide?.route?.routeName ?? "another route"}). Complete it before starting a new one.`,
        ),
      };
    }
  }

  const response = await updateRecord(prisma.ride, rideId, {
    status: nextStatus,
    ...extraData,
  });
  return { response };
};

const updateRideStatus = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!status || !RIDE_STATUS_TRANSITIONS[status]) {
      const errorResponse = badRequestResponse("Invalid ride status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId: id,
      nextStatus: status,
    });
    if (error) return res.status(error.status.code).json(error);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// Convenience wrappers around updateRideStatus so the mobile app can call a
// single-purpose endpoint (POST /rides/:id/start|complete|cancel) instead of
// building the PATCH payload itself. Same transition rules apply.
const startRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId: req.params.id,
      nextStatus: "STARTED",
    });
    if (error) return res.status(error.status.code).json(error);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// POST /rides/today/start — convenience endpoint so the mobile app doesn't
// need to know today's ride id up front. This NO LONGER creates a Ride:
// the Ride is provisioned as PENDING by dispatch when the WeeklySchedule
// is assigned (see services/ridePlanning.js). The driver's only action is
// the normal PENDING -> STARTED transition on that existing row. If no
// Ride exists yet, that means dispatch hasn't assigned this driver a
// route today — the app should show that state rather than the driver
// being able to conjure a ride into existence.
const startTodayRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const todaysRides = await prisma.ride.findMany({
      where: {
        driverId: driver.id,
        rideDate: { gte: startOfDay(), lte: endOfDay() },
      },
      include: {
        route: {
          select: { id: true, routeName: true, routeCode: true, officeLocation: true },
        },
        vehicle: { select: { id: true, vehicleNumber: true, make: true, model: true } },
        passengers: { select: { id: true } },
      },
      orderBy: [{ pickupTime: "asc" }, { createdAt: "asc" }],
    });

    if (todaysRides.length === 0) {
      const errorResponse = badRequestResponse(
        "No ride has been assigned for today yet. Contact dispatch.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // This endpoint only knows how to act on ONE ride, but a driver can
    // have several today (see getTodayRide above — this used to be a
    // findFirst() that quietly grabbed whichever row Postgres returned
    // first, which meant "start today's ride" could start the WRONG ride
    // for a driver with multiple routes). Rather than guess, require the
    // caller to disambiguate via the normal per-ride /rides/:id/start
    // endpoint whenever there's more than one candidate.
    if (todaysRides.length > 1) {
      const errorResponse = badRequestResponse(
        "You have multiple rides today — start the specific ride from your ride list instead.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const existingRide = todaysRides[0];

    if (existingRide.status !== "PENDING") {
      const response = okResponse(
        { ...existingRide, passengerCount: existingRide.passengers.length, source: "RIDE" },
        existingRide.status === "STARTED"
          ? "Today's ride is already in progress."
          : "Today's ride is no longer pending.",
      );
      return res.status(response.status.code).json(response);
    }

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId: existingRide.id,
      nextStatus: "STARTED",
    });
    if (error) return res.status(error.status.code).json(error);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const completeRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const rideId = req.params.id;

    // Pull the ride's passenger list alongside whatever attendance rows
    // already exist for it, so we can tell PENDING (no row yet) apart from
    // a resolved outcome. This is a completeness check, not a timer — the
    // "5 minute buffer" the driver gets before giving up on a no-show is a
    // real-world habit, not something the backend clocks; once the driver
    // marks the straggler ABSENT/NO_SHOW (via markAttendance or
    // updateStopStatus) they show up here as resolved and stop blocking
    // completion.
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        passengers: {
          include: { employee: { select: { id: true, name: true } } },
        },
        attendances: { select: { employeeId: true } },
      },
    });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const resolvedEmployeeIds = new Set(ride.attendances.map((a) => a.employeeId));
    const pendingPassengers = ride.passengers.filter(
      (p) => !resolvedEmployeeIds.has(p.employee.id),
    );

    if (pendingPassengers.length > 0) {
      const names = pendingPassengers.map((p) => p.employee.name).join(", ");
      const errorResponse = badRequestResponse(
        `${pendingPassengers.length} passenger(s) still need attendance recorded before this ride can be completed: ${names}. Mark any no-shows as Absent, then complete the ride.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId,
      nextStatus: "COMPLETED",
    });
    if (error) return res.status(error.status.code).json(error);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const cancelRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      const errorResponse = badRequestResponse("A cancellation reason is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId: req.params.id,
      nextStatus: "CANCELLED",
    });
    if (error) return res.status(error.status.code).json(error);

    // Ride has no dedicated cancelReason column — log it so dispatch has a
    // record of why, without requiring a schema change.
    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: "RIDE_CANCELLED_BY_DRIVER",
        model: "Ride",
        recordId: req.params.id,
        after: { reason: String(reason).trim() },
      },
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// GET /rides/:id — full detail view for a single ride (used by ride detail
// screens / deep links, as opposed to the "today" shortcut).
const getRideDetails = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        route: {
          select: { id: true, routeName: true, routeCode: true, officeLocation: true },
        },
        vehicle: {
          select: { id: true, vehicleNumber: true, make: true, model: true },
        },
        passengers: { select: { id: true } },
        attendances: { select: { employeeId: true, status: true } },
      },
    });

    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      { ...ride, passengerCount: ride.passengers.length },
      "Ride details retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// Stops = passengers already on this ride, plus a quick area breakdown so
// the driver app can group "not yet picked up" passengers by area.
const getRideStops = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        passengers: {
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                contactNumber: true,
                address: true,
                area: { select: { id: true, name: true } },
              },
            },
          },
        },
        attendances: {
          select: { employeeId: true, status: true },
        },
      },
    });

    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const attendanceByEmployee = Object.fromEntries(
      ride.attendances.map((a) => [a.employeeId, a.status]),
    );

    const passengerStops = ride.passengers.map((p) => ({
      kind: "passenger",
      employeeId: p.employee.id,
      employeeName: p.employee.name,
      contact: p.contact || p.employee.contactNumber,
      address: p.address || p.employee.address,
      areaName: p.employee.area?.name ?? null,
      status: attendanceByEmployee[p.employee.id] || "PENDING",
    }));

    const response = okResponse(
      { rideId: ride.id, stops: passengerStops },
      "Ride stops retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Attendance (QR scan)
// ---------------------------------------------------------------------------

const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "NO_SHOW"];

// Pickup times are free-text ("6:00 PM", "8:00AM", etc. — see the same
// tolerant parsing on the home.tsx shift-grouping logic). Grace period
// before a scan counts as LATE instead of PRESENT when no explicit status
// is given by the caller.
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

// Same NOTE as employee_controller.js: compares against server local wall
// clock since pickupTime strings are operational/local times, not UTC.
function computeArrivalStatus(pickupTime, scannedAt = new Date()) {
  const scheduledMinutes = parsePickupTimeToMinutes(pickupTime);
  if (scheduledMinutes === null) return "PRESENT";
  const scannedMinutes = scannedAt.getHours() * 60 + scannedAt.getMinutes();
  return scannedMinutes > scheduledMinutes + LATE_GRACE_MINUTES ? "LATE" : "PRESENT";
}

// Shared by markAttendance (QR scan), updateStopStatus, and updateAttendance
// — all three end up doing the same upsert against Attendance, just
// resolving the target employee a different way.
const upsertAttendanceForEmployee = async ({ ride, employeeId, status }) => {
  const passenger = await prisma.ridePassenger.findUnique({
    where: { rideId_employeeId: { rideId: ride.id, employeeId } },
  });
  if (!passenger) {
    return { error: badRequestResponse("This passenger is not on this ride.") };
  }

  const rideDate = startOfDay(ride.rideDate);

  const attendance = await prisma.attendance.upsert({
    where: { employeeId_rideDate: { employeeId, rideDate } },
    update: { status, rideId: ride.id, arrivalTime: new Date() },
    create: {
      employeeId,
      rideId: ride.id,
      rideDate,
      status,
      arrivalTime: new Date(),
    },
    include: { employee: { select: { id: true, name: true } } },
  });

  return { attendance };
};

const markAttendance = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId } = req.params;
    const { employeeId, qrCode, status: explicitStatus } = req.body;

    if (explicitStatus && !ATTENDANCE_STATUSES.includes(explicitStatus)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // A QR scan only makes sense against the ride the driver is physically
    // running right now. Requiring STARTED/ARRIVED (rather than accepting
    // any of today's rides) is what makes "which ride is this attendance
    // for" unambiguous end to end: since applyRideStatusTransition only
    // ever lets ONE ride be STARTED/ARRIVED per driver at a time, this
    // check guarantees there is exactly one valid target ride whenever a
    // scan is allowed to succeed.
    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      const errorResponse = badRequestResponse(
        ride.status === "PENDING"
          ? "Start this ride before scanning attendance for it."
          : `This ride is already ${ride.status.toLowerCase()} — attendance can no longer be scanned for it.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Only auto-compute PRESENT/LATE from the scan time when the caller
    // didn't explicitly ask for something else — a driver correcting a
    // no-show or absence still needs to be able to say so directly.
    const status = explicitStatus ?? computeArrivalStatus(ride.pickupTime);

    let resolvedEmployeeId = employeeId;
    if (!resolvedEmployeeId && qrCode) {
      const user = await prisma.user.findUnique({
        where: { qrCode },
        include: { employee: { select: { id: true } } },
      });
      resolvedEmployeeId = user?.employee?.id;
    }

    if (!resolvedEmployeeId) {
      const errorResponse = badRequestResponse(
        "Could not resolve a passenger from the scanned code.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, attendance } = await upsertAttendanceForEmployee({
      ride,
      employeeId: resolvedEmployeeId,
      status,
    });
    if (error) return res.status(error.status.code).json(error);

    const response = okResponse(attendance, "Attendance marked successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// GET /drivers/me/active-ride — returns the single ride (if any) this
// driver currently has STARTED/ARRIVED, so the mobile app's "Scan QR" CTA
// always knows exactly which ride to attach the scan to instead of asking
// the driver to pick from a list or guessing. Returns { data: null } when
// nothing is active (e.g. driver hasn't started a ride yet, or already
// completed all of today's rides) rather than erroring, since "no active
// ride" is a normal, expected state, not a failure.
const getActiveRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const activeRide = await prisma.ride.findFirst({
      where: {
        driverId: driver.id,
        status: { in: ACTIVE_RIDE_STATUSES },
      },
      include: {
        route: { select: { id: true, routeName: true, routeCode: true, officeLocation: true } },
        vehicle: { select: { id: true, vehicleNumber: true, make: true, model: true } },
        passengers: { select: { id: true } },
      },
    });

    const response = okResponse(
      activeRide
        ? { ...activeRide, passengerCount: activeRide.passengers.length }
        : null,
      activeRide ? "Active ride retrieved successfully." : "No active ride right now.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// PATCH /rides/:id/stops/:employeeId — mark a specific stop's outcome
// (e.g. from the route-stops list) without going through a QR scan.
const updateStopStatus = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId, stopId: employeeId } = req.params;
    const { status } = req.body;

    if (!ATTENDANCE_STATUSES.includes(status)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Same reasoning as markAttendance: a stop outcome only makes sense
    // once the ride is actually underway.
    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      const errorResponse = badRequestResponse(
        ride.status === "PENDING"
          ? "Start this ride before updating stop status."
          : `This ride is already ${ride.status.toLowerCase()} — stops can no longer be updated.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, attendance } = await upsertAttendanceForEmployee({
      ride,
      employeeId,
      status,
    });
    if (error) return res.status(error.status.code).json(error);

    const response = okResponse(attendance, "Stop status updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// PATCH /rides/:id/attendance/:employeeId — direct correction of a single
// passenger's attendance record (e.g. driver fixes a mis-scan).
const updateAttendance = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId, employeeId } = req.params;
    const { status } = req.body;

    if (!ATTENDANCE_STATUSES.includes(status)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, attendance } = await upsertAttendanceForEmployee({
      ride,
      employeeId,
      status,
    });
    if (error) return res.status(error.status.code).json(error);

    const response = okResponse(attendance, "Attendance updated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getRideAttendance = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId } = req.params;

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const attendances = await prisma.attendance.findMany({
      where: { rideId },
      include: { employee: { select: { id: true, name: true } } },
      orderBy: { arrivalTime: "desc" },
    });

    const response = okResponse(
      attendances,
      "Ride attendance retrieved successfully.",
    );
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
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { category, title, description, rideId, vehicleId } = req.body;

    if (!title || !title.trim()) {
      const errorResponse = badRequestResponse("Title is required.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await createRecord(prisma.complaint, {
      driverId: driver.id,
      category: category || "OTHER",
      title: title.trim(),
      description: description?.trim() || null,
      ...(rideId && { rideId }),
      ...(vehicleId && { vehicleId }),
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyComplaints = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { skip = 0, take = 10, status } = req.query;

    const options = {
      where: {
        driverId: driver.id,
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

const getComplaintDetails = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const complaint = await prisma.complaint.findUnique({
      where: { id: req.params.id },
    });
    if (!complaint || complaint.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(complaint, "Complaint retrieved successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// Drivers can amend their own complaint's wording while it's still open,
// or withdraw it (OPEN -> DISMISSED). Moving a complaint to IN_PROGRESS /
// RESOLVED is a dispatch/admin decision and stays out of scope here.
const updateComplaint = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const complaint = await prisma.complaint.findUnique({
      where: { id: req.params.id },
    });
    if (!complaint || complaint.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    if (complaint.status !== "OPEN") {
      const errorResponse = badRequestResponse(
        "Only complaints that are still open can be edited.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { title, description, status } = req.body;
    if (status && status !== "DISMISSED") {
      const errorResponse = badRequestResponse(
        "You can only withdraw (dismiss) your own complaint.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await updateRecord(prisma.complaint, req.params.id, {
      ...(title && { title: title.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(status && { status }),
    });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteComplaint = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const complaint = await prisma.complaint.findUnique({
      where: { id: req.params.id },
    });
    if (!complaint || complaint.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Complaint not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }
    if (complaint.status !== "OPEN") {
      const errorResponse = badRequestResponse(
        "Only complaints that are still open can be deleted.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    await prisma.complaint.delete({ where: { id: req.params.id } });

    const response = okResponse(null, "Complaint deleted successfully.");
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

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId, ...(status && { status }) },
        take: parseInt(limit),
        skip: parseInt(skip),
        orderBy: { createdAt: "desc" },
      }),
      prisma.notification.count({ where: { userId, ...(status && { status }) } }),
    ]);

    const response = okResponse(
      { data:notifications, total, limit: parseInt(limit), skip: parseInt(skip) },
      "Notifications retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

// Soft delete only — Driver rows are referenced by ride/complaint history,
// so a hard delete would either cascade-destroy that history or fail on the
// FK. Marking the driver INACTIVE and deactivating the linked login
// preserves records while blocking further use of the account.
const deleteAccount = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    await prisma.$transaction([
      prisma.driver.update({
        where: { id: driver.id },
        data: { status: "INACTIVE" },
      }),
      ...(driver.userId
        ? [
            prisma.user.update({
              where: { id: driver.userId },
              data: { isActive: false },
            }),
          ]
        : []),
    ]);

    const response = okResponse(null, "Account deactivated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// There's no document/license-file table in the schema yet, so this
// endpoint records the submission (and updates the license number if a new
// one was provided) rather than storing an actual uploaded file. Wire this
// up to real file storage once a Document model exists.
const verifyLicense = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { licenseNumber } = req.body;

    if (licenseNumber && licenseNumber.trim()) {
      await prisma.driver.update({
        where: { id: driver.id },
        data: { licenseNumber: licenseNumber.trim() },
      });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: "DRIVER_LICENSE_VERIFICATION_SUBMITTED",
        model: "Driver",
        recordId: driver.id,
        after: { licenseNumber: licenseNumber?.trim() ?? driver.licenseNumber },
      },
    });

    const response = okResponse(
      { driverId: driver.id, status: "PENDING_REVIEW" },
      "License submitted for verification.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const getDashboardSummary = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const startOfToday = startOfDay();
    const endOfToday = endOfDay();

    const [totalRides, pendingRides, completedRides] = await Promise.all([
      prisma.ride.count({
        where: {
          driverId: driver.id,
          rideDate: { gte: startOfToday, lte: endOfToday },
        },
      }),
      prisma.ride.count({
        where: {
          driverId: driver.id,
          rideDate: { gte: startOfToday, lte: endOfToday },
          status: { in: ["PENDING", "STARTED", "ARRIVED"] },
        },
      }),
      prisma.ride.count({
        where: {
          driverId: driver.id,
          rideDate: { gte: startOfToday, lte: endOfToday },
          status: "COMPLETED",
        },
      }),
    ]);

    const response = okResponse(
      { totalRides, pendingRides, completedRides },
      "Dashboard summary retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// GET /dashboard/stats — same idea as the summary above but over an
// arbitrary date range (defaults to the last 30 days) and broken out by
// every ride status so the app can chart trends rather than just "today".
const getDriverStats = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { startDate, endDate } = req.query;

    const rangeEnd = endDate ? endOfDay(new Date(endDate)) : endOfDay();
    const rangeStart = startDate ? startOfDay(new Date(startDate)) : startOfDay(new Date(rangeEnd.getTime() - 30 * 24 * 60 * 60 * 1000));

    const rides = await prisma.ride.findMany({
      where: {
        driverId: driver.id,
        rideDate: { gte: rangeStart, lte: rangeEnd },
      },
      select: { status: true },
    });

    const byStatus = rides.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      { PENDING: 0, STARTED: 0, ARRIVED: 0, COMPLETED: 0, CANCELLED: 0 },
    );

    const response = okResponse(
      {
        startDate: rangeStart,
        endDate: rangeEnd,
        totalRides: rides.length,
        byStatus,
        completionRate:
          rides.length > 0
            ? `${Math.round((byStatus.COMPLETED / rides.length) * 100)}%`
            : "N/A",
      },
      "Driver stats retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile,
  getMyQrCode,
  deleteAccount,
  verifyLicense,
  getTodayRide,
  getMyRides,
  getRideDetails,
  updateRideStatus,
  startRide,
  startTodayRide,
  completeRide,
  cancelRide,
  getRideStops,
  updateStopStatus,
  markAttendance,
  getActiveRide,
  getRideAttendance,
  updateAttendance,
  createComplaint,
  getMyComplaints,
  getComplaintDetails,
  updateComplaint,
  deleteComplaint,
  getNotifications,
  markNotificationAsRead,
  deleteNotification,
  getDashboardSummary,
  getDriverStats,
};