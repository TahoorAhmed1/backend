const { prisma } = require("../lib/prisma");
const { sendPushToUserBestEffort } = require("./pushNotifications");

const DISPLAY_TZ = process.env.RIDE_NOTIFICATIONS_TZ || "Asia/Karachi";

function formatDate(date) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: DISPLAY_TZ,
  }).format(new Date(date));
}

function startOfDay(date) {
  const d = new Date(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function endOfDay(date) {
  const d = new Date(date);
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

// ============================================================
// NOTIFICATION FUNCTIONS
// ============================================================

/**
 * Send ONE notification per employee summarizing ALL their rides
 * Works for both drivers and passengers
 */
async function notifyEmployeeScheduleUpdated(
  employeeId,
  weekStartDate,
  options = {},
) {
  // Get employee with user account
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { user: true },
  });

  if (!employee) {
    console.warn(`[rideNotifications] Employee ${employeeId} not found`);
    return null;
  }

  if (!employee.userId) {
    console.warn(
      `[rideNotifications] Employee ${employeeId} has no user account`,
    );
    return null;
  }

  // Find all rides where this employee is a passenger OR driver
  const rides = await prisma.ride.findMany({
    where: {
      rideDate: {
        gte: startOfDay(weekStartDate),
        lte: endOfDay(weekStartDate),
      },
      OR: [
        { driverId: employeeId },
        { passengers: { some: { employeeId: employeeId } } },
      ],
      status: "PENDING",
    },
    include: {
      driver: { select: { name: true } },
      vehicle: { select: { vehicleNumber: true } },
      route: { select: { routeName: true, routeCode: true } },
    },
    orderBy: { rideDate: "asc" },
  });

  if (rides.length === 0) {
    console.log(
      `[rideNotifications] No rides found for employee ${employeeId}`,
    );
    return null;
  }

  // Determine if employee is a driver or passenger for this week
  const isDriver = rides.some((r) => r.driverId === employeeId);

  // Build ride details
  const rideDetails = rides
    .map((ride, index) => {
      const date = formatDate(ride.rideDate);
      const route =
        ride.route?.routeName || ride.route?.routeCode || "your ride";
      const vehicle = ride.vehicle?.vehicleNumber || "TBD";
      const driver = ride.driver?.name || "Your driver";
      return `${index + 1}. ${date}: ${route} • ${driver} • ${vehicle}`;
    })
    .join("\n");

  // Build notification message
  const role = isDriver ? "driver" : "passenger";
  const message =
    options.message || "Your weekly ride schedule has been synced";

  // Create a nice summary
  let body = `${message}\n\n`;
  body += `You have ${rides.length} ride${rides.length > 1 ? "s" : ""} scheduled as a ${role} this week:\n\n`;
  body += rideDetails;

  // Truncate if too long (notification limit)
  if (body.length > 1000) {
    body = body.substring(0, 997) + "...";
  }

  const result = await sendPushToUserBestEffort(employee.userId, {
    title: `📅 ${rides.length} Ride${rides.length > 1 ? "s" : ""} Scheduled`,
    body: body,
    link: `/weekly-schedule?weekStart=${weekStartDate.toISOString().split("T")[0]}`,
    data: {
      type: "SCHEDULE_SYNCED",
      employeeId: employeeId,
      weekStart: weekStartDate.toISOString(),
      rideCount: rides.length,
      isDriver: isDriver,
    },
  });

  return result;
}

/**
 * Best effort wrapper
 */
async function notifyEmployeeScheduleUpdatedBestEffort(
  employeeId,
  weekStartDate,
  options = {},
) {
  try {
    return await notifyEmployeeScheduleUpdated(
      employeeId,
      weekStartDate,
      options,
    );
  } catch (err) {
    console.warn(
      `[rideNotifications] Failed for employee ${employeeId}: ${err.message}`,
    );
    return null;
  }
}

// ============================================================
// EXISTING FUNCTIONS (Keep as is)
// ============================================================

async function notifyRideAssigned(rideId) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: {
      driver: { include: { user: true } },
      vehicle: { select: { vehicleNumber: true } },
      route: { select: { routeName: true, routeCode: true } },
      passengers: {
        include: {
          employee: { include: { user: true } },
        },
      },
    },
  });

  if (!ride) {
    console.warn(
      `[rideNotifications] notifyRideAssigned: no Ride found for id ${rideId}`,
    );
    return { driver: null, passengers: [] };
  }

  const pickup = formatTime(ride.pickupTime);
  const routeLabel =
    ride.route?.routeName || ride.route?.routeCode || "your route";
  const vehicleLabel = ride.vehicle?.vehicleNumber || "TBD";
  const passengerCount = ride.passengers.length;

  const results = { driver: null, passengers: [] };

  if (ride.driver?.userId) {
    results.driver = await sendPushToUserBestEffort(ride.driver.userId, {
      title: "New ride assigned",
      body: `${routeLabel} • ${passengerCount} passenger${passengerCount === 1 ? "" : "s"}${pickup ? ` • Pickup ${pickup}` : ""}`,
      link: `/rides/${ride.id}`,
      data: { type: "RIDE_ASSIGNED", rideId: ride.id, role: "DRIVER" },
    });
  }

  const passengerSends = ride.passengers.map(async (p) => {
    if (!p.employee?.userId) {
      return { employeeId: p.employeeId, skipped: "no-linked-user-account" };
    }
    const outcome = await sendPushToUserBestEffort(p.employee.userId, {
      title: "Your ride is confirmed",
      body: `${ride.driver?.name || "Your driver"} • ${vehicleLabel}${pickup ? ` • Pickup ${pickup}` : ""}`,
      link: `/rides/${ride.id}`,
      data: { type: "RIDE_ASSIGNED", rideId: ride.id, role: "PASSENGER" },
    });
    return { employeeId: p.employeeId, ...outcome };
  });

  results.passengers = await Promise.all(passengerSends);
  return results;
}

async function notifyRideAssignedBestEffort(rideId) {
  try {
    return await notifyRideAssigned(rideId);
  } catch (err) {
    console.warn(
      `[rideNotifications] Failed to notify for ride ${rideId}: ${err.message}`,
    );
    return null;
  }
}

// Helper function for formatting time
function formatTime(date) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: DISPLAY_TZ,
  }).format(new Date(date));
}

module.exports = {
  notifyRideAssigned,
  notifyRideAssignedBestEffort,
  notifyEmployeeScheduleUpdated,
  notifyEmployeeScheduleUpdatedBestEffort,
};
