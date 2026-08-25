const { prisma } = require("../prisma");
const { sendPushToUserBestEffort } = require("./pushNotifications");

const DISPLAY_TZ = process.env.RIDE_NOTIFICATIONS_TZ || "Asia/Karachi";

function formatTime(date) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: DISPLAY_TZ,
  }).format(new Date(date));
}

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

  // ---- Notify the driver ----
  if (ride.driver?.userId) {
    results.driver = await sendPushToUserBestEffort(ride.driver.userId, {
      title: "New ride assigned",
      body: `${routeLabel} • ${passengerCount} passenger${passengerCount === 1 ? "" : "s"}${pickup ? ` • Pickup ${pickup}` : ""}`,
      link: `/rides/${ride.id}`,
      data: { type: "RIDE_ASSIGNED", rideId: ride.id, role: "DRIVER" },
    });
  } else if (ride.driverId) {
    console.warn(
      `[rideNotifications] Driver ${ride.driverId} has no linked User account — skipping driver push for ride ${ride.id}`,
    );
  }

  // ---- Notify each passenger (RidePassenger -> Employee -> User) ----
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

module.exports = { notifyRideAssigned, notifyRideAssignedBestEffort };
