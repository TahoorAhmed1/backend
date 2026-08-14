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

// Normalizes any date to the Monday of its week (UTC), matching how
// WeeklySchedule.weekStart is stored.
const mondayOf = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff, 0, 0, 0, 0));
};

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

    const ride = await prisma.ride.findFirst({
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
      orderBy: { createdAt: "desc" },
    });

    // Live Ride already exists — authoritative, trackable version.
    if (ride) {
      const response = okResponse(
        { ...ride, passengerCount: ride.passengers.length, source: "RIDE" },
        "Today's ride retrieved successfully.",
      );
      return res.status(response.status.code).json(response);
    }

    // No live Ride yet. Fall back to today's WeeklySchedule entries for
    // this driver so the app can show the planned route/vehicle and the
    // actual employee list, plus offer a "Start Ride" action, before
    // dispatch/the driver actually creates the Ride row.
    //
    // Exact-equality on a DateTime column is brittle — if this row's
    // weekStart was ever written with a different time-of-day (e.g. local
    // midnight instead of UTC midnight), an exact match silently returns
    // zero rows forever even though the schedule clearly exists. Match a
    // day-range instead, same approach rideDate uses above.
    const weekStart = mondayOf();
    const todayKey = DAY_KEYS[new Date().getUTCDay()];

    const schedules = await prisma.weeklySchedule.findMany({
      where: {
        driverId: driver.id,
        weekStart: { gte: startOfDay(weekStart), lte: endOfDay(weekStart) },
        status: "ACTIVE",
        NOT: { [todayKey]: "OFF" },
      },
      include: {
        route: {
          select: { id: true, routeName: true, routeCode: true, officeLocation: true },
        },
        vehicle: { select: { id: true, vehicleNumber: true, make: true, model: true } },
        employee: {
          select: {
            id: true,
            name: true,
            contactNumber: true,
            address: true,
            status: true,
            area: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Same eligibility rule startTodayRide uses when it actually creates
    // the Ride/RidePassenger rows — keeping these in sync means the
    // passenger count/list shown here matches what gets created once the
    // driver taps Start.
    const activeSchedules = schedules.filter(
      (s) => s[todayKey] !== "ABSENT" && s.employee?.status === "ACTIVE",
    );

    if (activeSchedules.length === 0) {
      const errorResponse = badRequestResponse("No ride scheduled for today.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const primary = activeSchedules[0];

    // No live Ride/RidePassenger/Attendance rows exist yet, so every
    // passenger here is inherently "PENDING" — nobody can have been
    // scanned before the ride starts.
    const passengers = activeSchedules.map((s) => ({
      employeeId: s.employee.id,
      employeeName: s.employee.name,
      contact: s.employee.contactNumber,
      address: s.employee.address,
      areaName: s.employee.area?.name ?? null,
      service: s[todayKey],
      status: "PENDING",
    }));

    const response = okResponse(
      {
        id: null,
        rideDate: startOfDay(),
        status: "SCHEDULED",
        pickupTime: primary.pickupTime,
        dropTime: primary.dropTime,
        route: primary.route,
        vehicle: primary.vehicle,
        passengerCount: activeSchedules.length,
        passengers,
        source: "SCHEDULE",
      },
      "Today's scheduled ride retrieved successfully.",
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
      skip: parseInt(skip),
      take: parseInt(take),
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

// POST /rides/today/start — the actual ride-creation entry point. Until
// now nothing ever created a Ride row; dispatch only set up WeeklySchedule
// (the plan). This turns today's schedule into a live Ride the moment the
// driver starts their shift, then applies the normal PENDING -> STARTED
// transition. Safe to call more than once: if a Ride already exists for
// today it's reused instead of creating a duplicate.
const startTodayRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const existingRide = await prisma.ride.findFirst({
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
    });

    if (existingRide) {
      if (existingRide.status === "PENDING") {
        const { error, response } = await applyRideStatusTransition({
          driver,
          rideId: existingRide.id,
          nextStatus: "STARTED",
        });
        if (error) return res.status(error.status.code).json(error);
        return res.status(response.status.code).json(response);
      }

      const response = okResponse(
        { ...existingRide, passengerCount: existingRide.passengers.length, source: "RIDE" },
        "Today's ride is already in progress.",
      );
      return res.status(response.status.code).json(response);
    }

    // Same day-range fix as getTodayRide — exact equality on this DateTime
    // column silently returns zero rows if weekStart wasn't written at
    // precisely UTC midnight.
    const weekStart = mondayOf();
    const todayKey = DAY_KEYS[new Date().getUTCDay()];

    const schedules = await prisma.weeklySchedule.findMany({
      where: {
        driverId: driver.id,
        weekStart: { gte: startOfDay(weekStart), lte: endOfDay(weekStart) },
        status: "ACTIVE",
        NOT: { [todayKey]: "OFF" },
      },
      include: {
        employee: {
          select: { id: true, name: true, contactNumber: true, address: true, status: true },
        },
      },
    });

    const activeSchedules = schedules.filter(
      (s) => s[todayKey] !== "ABSENT" && s.employee?.status === "ACTIVE",
    );

    if (activeSchedules.length === 0) {
      const errorResponse = badRequestResponse("No ride scheduled for today.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // All of a driver's schedule rows for the same day are expected to
    // share the same route/vehicle/trip assignment — use the first as the
    // ride's source of truth.
    const primary = activeSchedules[0];

    const createdRideId = await prisma.$transaction(async (tx) => {
      const ride = await tx.ride.create({
        data: {
          rideDate: startOfDay(),
          routeId: primary.routeId,
          driverId: driver.id,
          vehicleId: primary.vehicleId,
          vendorId: primary.vendorId,
          pickupTime: primary.pickupTime,
          dropTime: primary.dropTime,
          status: "STARTED",
        },
      });

      await tx.ridePassenger.createMany({
        data: activeSchedules.map((s) => ({
          rideId: ride.id,
          employeeId: s.employeeId,
          address: s.employee.address,
          contact: s.employee.contactNumber,
        })),
      });

      return ride.id;
    });

    const ride = await prisma.ride.findUnique({
      where: { id: createdRideId },
      include: {
        route: {
          select: { id: true, routeName: true, routeCode: true, officeLocation: true },
        },
        vehicle: { select: { id: true, vehicleNumber: true, make: true, model: true } },
        passengers: { select: { id: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId ?? null,
        action: "RIDE_CREATED_AND_STARTED_BY_DRIVER",
        model: "Ride",
        recordId: ride.id,
        after: { driverId: driver.id, passengerCount: ride.passengers.length },
      },
    });

    const response = okResponse(
      { ...ride, passengerCount: ride.passengers.length, source: "RIDE" },
      "Ride created and started successfully.",
    );
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

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId: req.params.id,
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
    const { employeeId, qrCode, status = "PRESENT" } = req.body;

    if (!ATTENDANCE_STATUSES.includes(status)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

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

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

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

    const rangeEnd = endDate ? new Date(endDate) : new Date();
    rangeEnd.setHours(23, 59, 59, 999);

    const rangeStart = startDate ? new Date(startDate) : new Date(rangeEnd);
    if (!startDate) rangeStart.setDate(rangeStart.getDate() - 30);
    rangeStart.setHours(0, 0, 0, 0);

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