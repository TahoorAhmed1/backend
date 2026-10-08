const { prisma } = require("../../../lib/prisma");
const QRCode = require("qrcode");
const {
  createRecord,
  getRecordById,
  updateRecord,
} = require("../../../utils/crudHelper");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");
const {
  notifyUser,
  notifyUsers,
  notifyRoles,
  ADMIN_NOTIFY_ROLES,
} = require("../../../services/notification.service");
const {
  normalizeVendorLateStatus,
} = require("../../../utils/vendorLateStatus");

// Roles that should be told about complaints, license submissions,
// account deactivations, etc. — anything without one obvious recipient.
// Sourced from the notification service so this can't silently drift
// out of sync with the role set the service itself uses for notifyAdmins.

const parsePagination = (query) => {
  const skip = parseInt(query.skip, 10) || 0;
  const take = parseInt(query.take, 10) || 10;

  return {
    skip: Math.max(0, skip),
    take: Math.max(1, Math.min(take, 100)),
  };
};

const STAFF_ROLES = ADMIN_NOTIFY_ROLES;

const getDriverFromReq = async (req) => {
  const userId = req.user?.userId;
  if (!userId) return null;
  return prisma.driver.findUnique({ where: { userId } });
};

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
  return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+05:00`);
};

const endOfDay = (date = new Date()) => {
  const { year, month, day } = toKarachiDateParts(date);
  return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:59.999+05:00`);
};

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

    const { name, phone } = req.body;

    const response = await updateRecord(prisma.driver, driver.id, {
      ...(name !== undefined && { name }),
      ...(phone !== undefined && { phone }),
    });

    notifyRoles(STAFF_ROLES, {
      title: "Driver profile updated",
      body: `${name ?? driver.name} updated their profile.`,
      data: { driverId: driver.id, type: "DRIVER_PROFILE_UPDATED" },
      event: "notification-created",
    }).catch((err) =>
      console.error("[driver_controller] notifyRoles failed:", err),
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getMyQrCode = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (!driver.userId) {
      const errorResponse = badRequestResponse(
        "No login is linked to this driver yet.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const user = await prisma.user.findUnique({
      where: { id: driver.userId },
      select: { qrCode: true },
    });

    if (!user?.qrCode) {
      const errorResponse = badRequestResponse(
        "No QR code has been generated for this driver yet.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    /*
     * The physical QR value stays EXACTLY the same.
     * Only the server-side attendance context changes.
     */
    const requestedRideId =
      typeof req.query.rideId === "string" ? req.query.rideId.trim() : "";

    let selectedRide = null;

    if (requestedRideId) {
      selectedRide = await prisma.ride.findUnique({
        where: { id: requestedRideId },
        include: {
          route: {
            select: {
              id: true,
              routeName: true,
              routeCode: true,
              officeLocation: true,
            },
          },
          vehicle: {
            select: {
              id: true,
              vehicleNumber: true,
              make: true,
              model: true,
            },
          },
          passengers: { select: { id: true } },
        },
      });

      if (!selectedRide || selectedRide.driverId !== driver.id) {
        const errorResponse = badRequestResponse(
          "Selected ride does not belong to this driver.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      if (!ACTIVE_RIDE_STATUSES.includes(selectedRide.status)) {
        const errorResponse = badRequestResponse(
          "Start the selected ride before showing its attendance QR.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }

      setDriverQrRideContext(user.qrCode, selectedRide.id);
    }

    if (req.query.format === "json") {
      const context = getDriverQrRideContext(user.qrCode);

      const response = okResponse(
        {
          qrCode: user.qrCode,
          selectedRideId: context?.rideId ?? null,
          selectedRide: selectedRide
            ? {
                ...selectedRide,
                passengerCount: selectedRide.passengers.length,
              }
            : null,
        },
        "Driver QR code retrieved successfully.",
      );

      return res.status(response.status.code).json(response);
    }

    if (req.query.format === "base64") {
      const dataUrl = await QRCode.toDataURL(user.qrCode, {
        width: 400,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      const response = okResponse(
        { qrCode: dataUrl },
        "QR code retrieved successfully.",
      );
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
const getTodayRide = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const rides = await prisma.ride.findMany({
      where: {
        driverId: driver.id,
        rideDate: { gte: startOfDay(), lte: endOfDay() },
      },
      include: {
        route: {
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            officeLocation: true,
          },
        },
        vehicle: {
          select: { id: true, vehicleNumber: true, make: true, model: true },
        },
        passengers: { select: { id: true } },
      },
      orderBy: [{ pickupTime: "asc" }, { createdAt: "asc" }],
    });

    const response = okResponse(
      rides.map((ride) => ({
        ...ride,
        passengerCount: ride.passengers?.length,
        source: "RIDE",
      })),
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

    const skip = parseInt(req.query.skip) || 0;
    const take = parseInt(req.query.take) || 10;
    const { status } = req.query;

    const options = {
      where: {
        driverId: driver.id,
        ...(status && { status }),
      },
      include: {
        route: { select: { id: true, routeName: true } },
        vehicle: { select: { id: true, vehicleNumber: true } },
        passengers: { select: { id: true } },

        _count: { select: { passengers: true } },
      },
      orderBy: { rideDate: "desc" },
      skip,
      take,
    };

    const [rides, total] = await Promise.all([
      prisma.ride.findMany(options),
      prisma.ride.count({ where: options.where }),
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

const RIDE_STATUS_TRANSITIONS = {
  PENDING: ["STARTED", "CANCELLED"],
  STARTED: ["ARRIVED", "COMPLETED"],
  ARRIVED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

const ACTIVE_RIDE_STATUSES = ["STARTED", "ARRIVED"];

/*
 * ONE permanent QR per driver.
 *
 * The QR payload/image never changes. When the driver opens the QR screen
 * for a specific ride, getMyQrCode?format=json&rideId=... stores the selected
 * ride server-side for a short period. Employee scans still submit the same
 * permanent QR value; markAttendanceByQr resolves the selected ride from this
 * context.
 *
 * NOTE: This is intentionally short-lived so a stale ride cannot be reused.
 * If the API is deployed on multiple Node instances, move this map to Redis
 * (or another shared cache) for cross-instance consistency.
 */
const driverQrRideContext =
  globalThis.__DRIVER_QR_RIDE_CONTEXT__ ??
  (globalThis.__DRIVER_QR_RIDE_CONTEXT__ = new Map());

const QR_CONTEXT_TTL_MS = 5 * 60 * 1000;

const setDriverQrRideContext = (qrCode, rideId) => {
  if (!qrCode || !rideId) return;
  driverQrRideContext.set(qrCode, {
    rideId: String(rideId),
    expiresAt: Date.now() + QR_CONTEXT_TTL_MS,
  });
};

const getDriverQrRideContext = (qrCode) => {
  const context = driverQrRideContext.get(qrCode);
  if (!context) return null;

  if (context.expiresAt <= Date.now()) {
    driverQrRideContext.delete(qrCode);
    return null;
  }

  return context;
};


const applyRideStatusTransition = async ({
  driver,
  rideId,
  nextStatus,
  extraData = {},
}) => {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { route: { select: { routeName: true } } },
  });
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

  /*
   * A driver may have multiple logical rides active at the same time.
   *
   * Example:
   *   Ride A: 09:00 -> 18:00 (round trip)
   *   Ride B: 12:00 -> 14:00
   *
   * Starting Ride B must NOT be blocked because Ride A is STARTED.
   * Each ride has its own lifecycle.
   */
  const [updatedRide, updatedDriver] = await prisma.$transaction(async (tx) => {
    const updatedRide = await tx.ride.update({
      where: { id: rideId },
      data: {
        status: nextStatus,
        ...extraData,
      },
    });

    /*
     * Driver is globally AVAILABLE only when no active rides remain.
     * This is calculated after the current ride update.
     */
    const remainingActiveRideCount = await tx.ride.count({
      where: {
        driverId: driver.id,
        status: { in: ACTIVE_RIDE_STATUSES },
      },
    });

    const driverStatus =
      remainingActiveRideCount > 0 ? "ON_RIDE" : "AVAILABLE";

    const updatedDriver = await tx.driver.update({
      where: { id: driver.id },
      data: { status: driverStatus },
    });

    return [updatedRide, updatedDriver];
  });

  notifyPassengersOfRideStatus({ ride, nextStatus }).catch((err) =>
    console.error(
      "[driver_controller] notifyPassengersOfRideStatus failed:",
      err,
    ),
  );

  return {
    response: okResponse(
      { ...updatedRide, driverStatus: updatedDriver.status },
      `Ride status updated to ${nextStatus}`,
    ),
  };
};

const RIDE_STATUS_NOTIFICATIONS = {
  STARTED: {
    title: "Ride started",
    body: (routeName) => `Your driver is on the way for ${routeName}.`,
  },
  ARRIVED: {
    title: "Driver has arrived",
    body: (routeName) => `Your driver has arrived for ${routeName}.`,
  },
  COMPLETED: {
    title: "Ride completed",
    body: (routeName) => `Your ride on ${routeName} has been completed.`,
  },
  CANCELLED: {
    title: "Ride cancelled",
    body: (routeName) => `Your ride on ${routeName} has been cancelled.`,
  },
};

// Fire-and-forget: notify every passenger on the ride in real-time (Pusher)
// and via push (Expo) whenever the driver moves the ride to a new status.
const notifyPassengersOfRideStatus = async ({ ride, nextStatus }) => {
  const notification = RIDE_STATUS_NOTIFICATIONS[nextStatus];
  if (!notification) return;

  const passengers = await prisma.ridePassenger.findMany({
    where: { rideId: ride.id },
    select: { employee: { select: { userId: true } } },
  });
  const userIds = passengers.map((p) => p.employee?.userId).filter(Boolean);
  if (userIds.length === 0) return;

  const routeName = ride.route?.routeName ?? "your route";
  await notifyUsers(userIds, {
    title: notification.title,
    body: notification.body(routeName),
    data: { rideId: ride.id, type: `RIDE_${nextStatus}` },
    event: "ride-status-updated",
  });
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
    console.log("error", error);
    if (error) return res.status(error.status.code).json(error);

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

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
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            officeLocation: true,
          },
        },
        vehicle: {
          select: { id: true, vehicleNumber: true, make: true, model: true },
        },
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

    if (todaysRides.length > 1) {
      const errorResponse = badRequestResponse(
        "You have multiple rides today — start the specific ride from your ride list instead.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const existingRide = todaysRides[0];

    if (existingRide.status !== "PENDING") {
      const response = okResponse(
        {
          ...existingRide,
          passengerCount: existingRide.passengers.length,
          source: "RIDE",
        },
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
    console.log("error", error);
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

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        passengers: {
          include: { employee: { select: { id: true, name: true } } },
        },
        attendances: { select: { employeeId: true, leg: true } },
      },
    });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    /*
     * A Ride is a complete round trip:
     *   PICKUP: Home -> Office
     *   DROP:   Office -> Home
     *
     * Therefore the ride can only become COMPLETED after both attendance
     * legs are resolved for every passenger.
     *
     * A resolved attendance can be PRESENT, LATE, ABSENT or NO_SHOW.
     */
    const resolvedAttendanceKeys = new Set(
      ride.attendances.map(
        (attendance) =>
          `${attendance.employeeId}:${attendance.leg || "PICKUP"}`,
      ),
    );

    const pendingPassengers = [];

    for (const passenger of ride.passengers) {
      const pickupKey = `${passenger.employeeId}:PICKUP`;
      const dropKey = `${passenger.employeeId}:DROP`;

      if (!resolvedAttendanceKeys.has(pickupKey)) {
        pendingPassengers.push({
          employee: passenger.employee,
          leg: "PICKUP",
        });
      }

      if (!resolvedAttendanceKeys.has(dropKey)) {
        pendingPassengers.push({
          employee: passenger.employee,
          leg: "DROP",
        });
      }
    }

    if (pendingPassengers.length > 0) {
      const pendingLabels = pendingPassengers
        .map(
          ({ employee, leg }) =>
            `${employee.name} (${leg === "PICKUP" ? "pickup" : "drop"})`,
        )
        .join(", ");

      const errorResponse = badRequestResponse(
        `${pendingPassengers.length} attendance leg(s) still need to be resolved before this ride can be completed: ${pendingLabels}. Mark any no-shows as Absent, then complete the ride.`,
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
      const errorResponse = badRequestResponse(
        "A cancellation reason is required.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { error, response } = await applyRideStatusTransition({
      driver,
      rideId: req.params.id,
      nextStatus: "CANCELLED",
    });
    if (error) return res.status(error.status.code).json(error);

    // await prisma.auditLog.create({
    //   data: {
    //     userId: req.user?.userId ?? null,
    //     action: "RIDE_CANCELLED_BY_DRIVER",
    //     model: "Ride",
    //     recordId: req.params.id,
    //     after: { reason: String(reason).trim() },
    //   },
    // });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            officeLocation: true,
          },
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
          select: {
            employeeId: true,
            leg: true,
            status: true,
            vendorLateStatus: true,
            delayMinutes: true,
          },
        },
      },
    });

    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const attendanceByEmployeeLeg = Object.fromEntries(
      ride.attendances.map((a) => [`${a.employeeId}:${a.leg || "PICKUP"}`, a]),
    );

    const passengerStops = ride.passengers.map((p) => {
      const leg = p.leg || "PICKUP";
      const attendance = attendanceByEmployeeLeg[`${p.employeeId}:${leg}`];

      return {
        kind: "passenger",
        employeeId: p.employee.id,
        employeeName: p.employee.name,
        leg,
        contact: p.contact || p.employee.contactNumber,
        address: p.address || p.employee.address,
        areaName: p.employee.area?.name ?? null,
        status: attendance?.status || "PENDING",
        vendorLateStatus: attendance?.vendorLateStatus || "UNCLASSIFIED",
        delayMinutes: attendance?.delayMinutes ?? null,
      };
    });

    const response = okResponse(
      { rideId: ride.id, stops: passengerStops },
      "Ride stops retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "NO_SHOW"];
const LATE_GRACE_MINUTES = 10;

function parsePickupTimeToMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, "").toUpperCase();
  const match = s.match(/^(\d{1,2}):?(\d{2})?:?(AM|PM)?$/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59)
    return null;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function computeArrivalStatus(pickupTime, scannedAt = new Date()) {
  const scheduledMinutes = parsePickupTimeToMinutes(pickupTime);
  if (scheduledMinutes === null) return "PRESENT";
  const scannedMinutes = scannedAt.getHours() * 60 + scannedAt.getMinutes();
  return scannedMinutes > scheduledMinutes + LATE_GRACE_MINUTES
    ? "LATE"
    : "PRESENT";
}

const upsertAttendanceForEmployee = async ({
  ride,
  employeeId,
  status,
  vendorLateStatus,
  delayMinutes,
  leg = "PICKUP",
}) => {
  const normalizedLeg = leg === "DROP" ? "DROP" : "PICKUP";

  const passenger = await prisma.ridePassenger.findUnique({
    where: {
      rideId_employeeId_leg: {
        rideId: ride.id,
        employeeId,
        leg: normalizedLeg,
      },
    },
  });

  if (!passenger) {
    return { error: badRequestResponse("This passenger is not on this ride.") };
  }

  const delayValue =
    delayMinutes === "" || delayMinutes === null || delayMinutes === undefined
      ? null
      : Number(delayMinutes);

  if (delayValue !== null && Number.isNaN(delayValue)) {
    return {
      error: badRequestResponse("Delay minutes must be a valid number."),
    };
  }

  if (delayValue !== null && delayValue < 0) {
    return {
      error: badRequestResponse("Delay minutes cannot be negative."),
    };
  }

  const normalizedVendorLateStatus =
    vendorLateStatus === undefined ||
    vendorLateStatus === null ||
    vendorLateStatus === ""
      ? "UNCLASSIFIED"
      : normalizeVendorLateStatus(vendorLateStatus);

  const rideDate = startOfDay(ride.rideDate);

  const existing = await prisma.attendance.findFirst({
    where: {
      rideId: ride.id,
      employeeId,
      leg: normalizedLeg,
    },
  });

  let attendance;

  if (existing) {
    attendance = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        status,
        rideId: ride.id,
        rideDate,
        arrivalTime: new Date(),
        leg: normalizedLeg,
        vendorLateStatus: normalizedVendorLateStatus,
        delayMinutes: delayValue,
      },
      include: {
        employee: { select: { id: true, name: true, userId: true } },
      },
    });
  } else {
    attendance = await prisma.attendance.create({
      data: {
        employeeId,
        rideId: ride.id,
        rideDate,
        leg: normalizedLeg,
        status,
        arrivalTime: new Date(),
        vendorLateStatus: normalizedVendorLateStatus,
        delayMinutes: delayValue,
      },
      include: {
        employee: { select: { id: true, name: true, userId: true } },
      },
    });
  }

  return { attendance };
};
// Fire-and-forget: let the employee know their attendance status changed,
// in real-time (Pusher) and via push (Expo).
const notifyEmployeeOfAttendance = ({ attendance, driverName }) => {
  const employeeUserId = attendance?.employee?.userId;
  if (!employeeUserId) return;

  const status = attendance.status;
  notifyUser(employeeUserId, {
    title: ["ABSENT", "NO_SHOW"].includes(status)
      ? "Marked absent"
      : "Attendance marked",
    body: `${driverName} marked you as ${status.toLowerCase().replace("_", " ")} for today's ride.`,
    data: { rideId: attendance.rideId, type: "ATTENDANCE_UPDATED", status },
    event: "attendance-updated",
  }).catch((err) =>
    console.error("[driver_controller] notifyUser failed:", err),
  );
};

const markAttendance = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId } = req.params;
    const {
      employeeId,
      qrCode,
      status: explicitStatus,
      vendorLateStatus,
      delayMinutes,
      leg,
    } = req.body;

    if (explicitStatus && !ATTENDANCE_STATUSES.includes(explicitStatus)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (
      vendorLateStatus !== undefined &&
      vendorLateStatus !== null &&
      vendorLateStatus !== "" &&
      !["ON_TIME", "ON_TIME_LATE", "LATE", "ONLY_DROP", "UNCLASSIFIED"].includes(
        normalizeVendorLateStatus(vendorLateStatus),
      )
    ) {
      const errorResponse = badRequestResponse("Invalid vendor late status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      const errorResponse = badRequestResponse(
        ride.status === "PENDING"
          ? "Start this ride before scanning attendance for it."
          : `This ride is already ${ride.status.toLowerCase()} — attendance can no longer be scanned for it.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const status = explicitStatus ?? computeArrivalStatus(ride.pickupTime);
    const normalizedLeg = leg === "DROP" ? "DROP" : "PICKUP";

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

    const rideDate = startOfDay(ride.rideDate);
    const existingAttendance = await prisma.attendance.findFirst({
      where: {
        employeeId: resolvedEmployeeId,
        rideDate,
        leg: normalizedLeg,
      },
      include: { employee: { select: { id: true, name: true, userId: true } } },
    });
    if (existingAttendance?.rideId === ride.id) {
      const response = okResponse(
        existingAttendance,
        "Attendance was already marked for this passenger.",
      );
      return res.status(response.status.code).json(response);
    }

    const { error, attendance } = await upsertAttendanceForEmployee({
      ride,
      employeeId: resolvedEmployeeId,
      status,
      vendorLateStatus,
      delayMinutes,
      leg: normalizedLeg,
    });
    if (error) return res.status(error.status.code).json(error);

    notifyEmployeeOfAttendance({ attendance, driverName: driver.name });

    const response = okResponse(attendance, "Attendance marked successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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
        rideDate: { gte: startOfDay(), lte: endOfDay() },
      },
      orderBy: { rideDate: "desc" },
      include: {
        route: {
          select: {
            id: true,
            routeName: true,
            routeCode: true,
            officeLocation: true,
          },
        },
        vehicle: {
          select: { id: true, vehicleNumber: true, make: true, model: true },
        },
        passengers: { select: { id: true } },
      },
    });

    const response = okResponse(
      activeRide
        ? { ...activeRide, passengerCount: activeRide.passengers.length }
        : null,
      activeRide
        ? "Active ride retrieved successfully."
        : "No active ride right now.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateStopStatus = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId, stopId: employeeId } = req.params;
    const { status, vendorLateStatus, delayMinutes, leg } = req.body;

    if (!ATTENDANCE_STATUSES.includes(status)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (
      vendorLateStatus !== undefined &&
      vendorLateStatus !== null &&
      vendorLateStatus !== "" &&
      !["ON_TIME", "ON_TIME_LATE", "LATE", "ONLY_DROP", "UNCLASSIFIED"].includes(
        normalizeVendorLateStatus(vendorLateStatus),
      )
    ) {
      const errorResponse = badRequestResponse("Invalid vendor late status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== driver.id) {
      const errorResponse = badRequestResponse("Ride not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

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
      vendorLateStatus,
      delayMinutes,
      leg,
    });
    if (error) return res.status(error.status.code).json(error);

    notifyEmployeeOfAttendance({ attendance, driverName: driver.name });

    const response = okResponse(
      attendance,
      "Stop status updated successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateAttendance = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { id: rideId, employeeId } = req.params;
    const { status, vendorLateStatus, delayMinutes, leg } = req.body;

    if (!ATTENDANCE_STATUSES.includes(status)) {
      const errorResponse = badRequestResponse("Invalid attendance status.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (
      vendorLateStatus !== undefined &&
      vendorLateStatus !== null &&
      vendorLateStatus !== "" &&
      !["ON_TIME", "ON_TIME_LATE", "LATE", "ONLY_DROP", "UNCLASSIFIED"].includes(
        normalizeVendorLateStatus(vendorLateStatus),
      )
    ) {
      const errorResponse = badRequestResponse("Invalid vendor late status.");
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
      vendorLateStatus,
      delayMinutes,
      leg,
    });
    if (error) return res.status(error.status.code).json(error);

    notifyEmployeeOfAttendance({ attendance, driverName: driver.name });

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

    const complaint = response?.data;
    notifyRoles(STAFF_ROLES, {
      title: "New complaint filed",
      body: `${driver.name} filed a complaint: ${title.trim()}`,
      data: { complaintId: complaint?.id, type: "COMPLAINT_CREATED" },
      event: "notification-created",
    }).catch((err) =>
      console.error("[driver_controller] notifyRoles failed:", err),
    );

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

    const skip = parseInt(req.query.skip) || 0;
    const take = parseInt(req.query.take) || 10;
    const { status } = req.query;

    const where = {
      driverId: driver.id,
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
      ...(title !== undefined && { title: title.trim() }),
      ...(description !== undefined && {
        description: description?.trim() || null,
      }),
      ...(status && { status }),
    });

    notifyRoles(STAFF_ROLES, {
      title: status === "DISMISSED" ? "Complaint withdrawn" : "Complaint updated",
      body:
        status === "DISMISSED"
          ? `${driver.name} withdrew their complaint: ${complaint.title}`
          : `${driver.name} updated their complaint: ${title?.trim() ?? complaint.title}`,
      data: {
        complaintId: complaint.id,
        type: status === "DISMISSED" ? "COMPLAINT_DISMISSED" : "COMPLAINT_UPDATED",
      },
      event: "notification-created",
    }).catch((err) =>
      console.error("[driver_controller] notifyRoles failed:", err),
    );

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

    notifyRoles(STAFF_ROLES, {
      title: "Complaint deleted",
      body: `${driver.name} deleted their complaint: ${complaint.title}`,
      data: { complaintId: complaint.id, type: "COMPLAINT_DELETED" },
      event: "notification-created",
    }).catch((err) =>
      console.error("[driver_controller] notifyRoles failed:", err),
    );

    const response = okResponse(null, "Complaint deleted successfully.");
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
        status: "UNREAD",
      },
      data: { status: "READ" },
    });

    // ✅ NO Pusher events - just return success
    const response = okResponse(
      { markedCount: count },
      `${count} notification(s) marked as read.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

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

    notifyRoles(STAFF_ROLES, {
      title: "Driver account deactivated",
      body: `${driver.name} deactivated their account.`,
      data: { driverId: driver.id, type: "DRIVER_ACCOUNT_DEACTIVATED" },
      event: "notification-created",
    }).catch((err) =>
      console.error("[driver_controller] notifyRoles failed:", err),
    );

    const response = okResponse(null, "Account deactivated successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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

    notifyRoles(STAFF_ROLES, {
      title: "License verification submitted",
      body: `${driver.name} submitted a license for verification.`,
      data: { driverId: driver.id, type: "DRIVER_LICENSE_SUBMITTED" },
      event: "notification-created",
    }).catch((err) =>
      console.error("[driver_controller] notifyRoles failed:", err),
    );

    // await prisma.auditLog.create({
    //   data: {
    //     userId: req.user?.userId ?? null,
    //     action: "DRIVER_LICENSE_VERIFICATION_SUBMITTED",
    //     model: "Driver",
    //     recordId: driver.id,
    //     after: { licenseNumber: licenseNumber?.trim() ?? driver.licenseNumber },
    //   },
    // });

    const response = okResponse(
      { driverId: driver.id, status: "PENDING_REVIEW" },
      "License submitted for verification.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

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

const getDriverStats = async (req, res, next) => {
  try {
    const driver = await getDriverFromReq(req);
    if (!driver) {
      const errorResponse = badRequestResponse("Driver profile not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const { startDate, endDate } = req.query;

    let rangeEnd = endOfDay();
    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (!isNaN(parsedEnd.getTime())) {
        rangeEnd = endOfDay(parsedEnd);
      }
    }

    let rangeStart = startOfDay(
      new Date(rangeEnd.getTime() - 30 * 24 * 60 * 60 * 1000),
    );
    if (startDate) {
      const parsedStart = new Date(startDate);
      if (!isNaN(parsedStart.getTime())) {
        rangeStart = startOfDay(parsedStart);
      }
    }

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
  markAllNotificationsAsRead,
};