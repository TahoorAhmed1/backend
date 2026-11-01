
const { prisma } = require("../../../lib/prisma");
const { badRequestResponse, okResponse } = require("../../../constants/responses");

const ACTIVE_STATUSES = ["STARTED", "ARRIVED"];
const MAX_BATCH = 50; // apps may buffer points while offline and flush them together
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;

const getUserId = (req) => req.user?.userId ?? req.user?.id;

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

/** Validates one GPS point. Returns { point } or { error }. */
const parsePoint = (raw) => {
  const latitude = Number(raw?.latitude);
  const longitude = Number(raw?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
    return { error: "latitude must be a number between -90 and 90" };
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    return { error: "longitude must be a number between -180 and 180" };

  const point = {
    latitude,
    longitude,
    accuracy: num(raw.accuracy),
    speed: num(raw.speed),
    heading: num(raw.heading),
  };
  for (const k of ["accuracy", "speed", "heading"])
    if (point[k] !== null && !Number.isFinite(point[k])) return { error: `${k} must be a number` };

  if (raw.recordedAt) {
    const t = new Date(raw.recordedAt);
    const age = Date.now() - t.getTime();
    if (Number.isNaN(t.getTime())) return { error: "recordedAt must be a valid ISO date-time" };
    if (age < -MAX_FUTURE_MS) return { error: "recordedAt is in the future" };
    if (age > MAX_AGE_MS) return { error: "recordedAt is older than 24 hours" };
    point.recordedAt = t;
  }
  return { point };
};

/** Accepts a single point or { points: [...] }. */
const parseBody = (body) => {
  const raws = Array.isArray(body?.points) ? body.points : [body];
  if (raws.length === 0 || raws.length > MAX_BATCH)
    return { error: `points must contain between 1 and ${MAX_BATCH} items` };
  const points = [];
  for (const r of raws) {
    const { point, error } = parsePoint(r);
    if (error) return { error };
    points.push(point);
  }
  return { points };
};

/** POST /tracking/driver/rides/:id/location   (role DRIVER) */
const postDriverLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { points, error } = parseBody(req.body);
    if (error) return badRequestResponse(res, error);

    const driver = await prisma.driver.findUnique({ where: { userId: getUserId(req) } });
    if (!driver) return badRequestResponse(res, "No driver profile linked to this user");

    const ride = await prisma.ride.findUnique({
      where: { id },
      select: { id: true, driverId: true, status: true },
    });
    if (!ride) return badRequestResponse(res, "Ride not found");
    if (ride.driverId !== driver.id)
      return badRequestResponse(res, "This ride is not assigned to you");
    if (!ACTIVE_STATUSES.includes(ride.status))
      return badRequestResponse(res, `Ride is ${ride.status}; tracking is only accepted while STARTED or ARRIVED`);

    const result = await prisma.driverLocation.createMany({
      data: points.map((p) => ({ ...p, driverId: driver.id, rideId: null })),
    });

    return okResponse(res, { saved: result.count, rideStatus: ride.status }, "Location recorded");
  } catch (err) {
    console.error("postDriverLocation error:", err);
    return badRequestResponse(res, err.message || "Failed to record location");
  }
};

/** POST /tracking/employee/rides/:id/location   (role EMPLOYEE) */
const postEmployeeLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { points, error } = parseBody(req.body);
    if (error) return badRequestResponse(res, error);

    const employee = await prisma.employee.findUnique({ where: { userId: getUserId(req) } });
    if (!employee) return badRequestResponse(res, "No employee profile linked to this user");

    const ride = await prisma.ride.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!ride) return badRequestResponse(res, "Ride not found");
    if (!ACTIVE_STATUSES.includes(ride.status))
      return badRequestResponse(res, `Ride is ${ride.status}; tracking is only accepted while STARTED or ARRIVED`);

    const isPassenger = await prisma.ridePassenger.findFirst({
      where: { rideId: id, employeeId: employee.id },
      select: { id: true },
    });
    if (!isPassenger) return badRequestResponse(res, "You are not a passenger on this ride");

    const result = await prisma.employeeLocation.createMany({
      data: points.map((p) => ({ ...p, employeeId: employee.id, rideId: id })),
    });

    return okResponse(res, { saved: result.count, rideStatus: ride.status }, "Location recorded");
  } catch (err) {
    console.error("postEmployeeLocation error:", err);
    return badRequestResponse(res, err.message || "Failed to record location");
  }
};

module.exports = { postDriverLocation, postEmployeeLocation };