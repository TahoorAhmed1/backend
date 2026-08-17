const { prisma } = require("../../../lib/prisma");
const { okResponse } = require("../../../constants/responses");

// ---------------------------------------------------------------------
// Status-bucket maps: decouple the DB enums from the buckets the UI
// renders, so a new enum value degrades into a sane default bucket
// instead of silently disappearing from a chart's totals.
// ---------------------------------------------------------------------

// Palette is constrained to the brand's red / white / black theme.
// Greens/blues/purples/oranges are never used — categories are told
// apart with shade and value (near-black -> mid red -> pale red -> gray)
// rather than hue.
const PALETTE = {
  black: "#111111",
  charcoal: "#404040",
  gray: "#9ca3af",
  paleGray: "#d4d4d4",
  redDark: "#7f1d1d",
  red: "#dc2626",
  redMid: "#ef4444",
  redLight: "#f87171",
  redPale: "#fca5a5",
  white: "#ffffff",
};

const RIDE_STATUS_BUCKET = {
  PENDING: "pending",
  STARTED: "in progress",
  ARRIVED: "in progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};
const RIDE_STATUS_META = {
  completed: { label: "Completed", color: PALETTE.black },
  pending: { label: "Pending", color: PALETTE.redLight },
  "in progress": { label: "In Progress", color: PALETTE.red },
  cancelled: { label: "Cancelled", color: PALETTE.redDark },
};
const RIDE_STATUS_ORDER = ["completed", "pending", "in progress", "cancelled"];

const ATTENDANCE_STATUS_BUCKET = {
  PRESENT: "onTime",
  LATE: "late",
  ABSENT: "absent",
  NO_SHOW: "absent",
};
const ATTENDANCE_META = {
  onTime: { label: "On Time", color: PALETTE.black },
  late: { label: "Late", color: PALETTE.redLight },
  absent: { label: "Absent", color: PALETTE.redDark },
};
const ATTENDANCE_ORDER = ["onTime", "late", "absent"];

const VEHICLE_STATUS_META = {
  ACTIVE: { label: "Active", color: PALETTE.black },
  INACTIVE: { label: "Inactive", color: PALETTE.gray },
  MAINTENANCE: { label: "Maintenance", color: PALETTE.redLight },
  BREAKDOWN: { label: "Breakdown", color: PALETTE.redDark },
};
const VEHICLE_STATUS_ORDER = ["ACTIVE", "INACTIVE", "MAINTENANCE", "BREAKDOWN"];

const DRIVER_STATUS_META = {
  AVAILABLE: { label: "Available", color: PALETTE.black },
  ON_RIDE: { label: "On Ride", color: PALETTE.red },
  OFFLINE: { label: "Offline", color: PALETTE.gray },
  INACTIVE: { label: "Inactive", color: PALETTE.redDark },
};
const DRIVER_STATUS_ORDER = ["AVAILABLE", "ON_RIDE", "OFFLINE", "INACTIVE"];

const COMPLAINT_CATEGORY_META = {
  DRIVER_BEHAVIOUR: { label: "Driver Behaviour", color: PALETTE.redDark },
  VEHICLE_CONDITION: { label: "Vehicle Condition", color: PALETTE.red },
  ROUTE_ISSUE: { label: "Route Issue", color: PALETTE.redLight },
  TIMING_DELAY: { label: "Timing Delay", color: PALETTE.black },
  SCHEDULING: { label: "Scheduling", color: PALETTE.charcoal },
  OTHER: { label: "Other", color: PALETTE.gray },
};
const COMPLAINT_CATEGORY_ORDER = Object.keys(COMPLAINT_CATEGORY_META);

const COMPLAINT_STATUS_META = {
  OPEN: { label: "Open", color: PALETTE.redDark },
  IN_PROGRESS: { label: "In Progress", color: PALETTE.red },
  RESOLVED: { label: "Resolved", color: PALETTE.black },
  DISMISSED: { label: "Dismissed", color: PALETTE.gray },
};
const COMPLAINT_STATUS_ORDER = ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"];

const TREND_DAYS = 7;

// ---------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10); // YYYY-MM-DD
}

// Monday of the current week — WeeklySchedule.weekStart is always a Monday.
function currentWeekStart() {
  const d = startOfDay(new Date());
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------
// Section builders — each isolated so they can be read, tested, and
// reused independently of the combined /overview payload.
// ---------------------------------------------------------------------

async function getHeadlineStats() {
  const weekStart = currentWeekStart();
  const [
    employees,
    drivers,
    vehicles,
    routes,
    trips,
    vendors,
    todayRides,
    openComplaints,
    activeSchedules,
  ] = await Promise.all([
    prisma.employee.count(),
    prisma.driver.count(),
    prisma.vehicle.count(),
    prisma.route.count({ where: { status: "ACTIVE" } }),
    prisma.trip.count({ where: { status: "ACTIVE" } }),
    prisma.vendor.count({ where: { status: "ACTIVE" } }),
    prisma.ride.count({ where: { rideDate: { gte: startOfDay(new Date()), lte: endOfDay(new Date()) } } }),
    prisma.complaint.count({ where: { status: "OPEN" } }),
    prisma.weeklySchedule.count({ where: { status: "ACTIVE", weekStart } }),
  ]);

  return { employees, drivers, vehicles, routes, trips, vendors, todayRides, openComplaints, activeSchedules };
}

async function getRideStatusBreakdown() {
  const groups = await prisma.ride.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = { completed: 0, pending: 0, "in progress": 0, cancelled: 0 };
  groups.forEach((g) => {
    counts[RIDE_STATUS_BUCKET[g.status] || "pending"] += g._count._all;
  });
  return RIDE_STATUS_ORDER.map((key) => ({
    label: RIDE_STATUS_META[key].label,
    value: counts[key],
    color: RIDE_STATUS_META[key].color,
  }));
}

async function getTodaysAttendanceBreakdown() {
  const groups = await prisma.attendance.groupBy({
    by: ["status"],
    _count: { _all: true },
    where: { rideDate: { gte: startOfDay(new Date()), lte: endOfDay(new Date()) } },
  });
  const counts = { onTime: 0, late: 0, absent: 0 };
  groups.forEach((g) => {
    counts[ATTENDANCE_STATUS_BUCKET[g.status] || "absent"] += g._count._all;
  });
  return ATTENDANCE_ORDER.map((key) => ({
    label: ATTENDANCE_META[key].label,
    value: counts[key],
    color: ATTENDANCE_META[key].color,
  }));
}

async function getEmployeesByArea(limit = 5) {
  const groups = await prisma.employee.groupBy({ by: ["areaId"], _count: { _all: true } });
  const areaIds = groups.map((g) => g.areaId).filter(Boolean);
  const areas = areaIds.length
    ? await prisma.area.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } })
    : [];
  const nameById = Object.fromEntries(areas.map((a) => [a.id, a.name]));

  const ranked = groups
    .map((g) => ({ label: g.areaId ? nameById[g.areaId] || "Other" : "Other", value: g._count._all }))
    .sort((a, b) => b.value - a.value);

  // Cap the bar chart at the top N areas so it stays readable as more
  // areas get added — anything past the cutoff rolls into "Other".
  const top = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  const restTotal = rest.reduce((sum, r) => sum + r.value, 0);

  if (restTotal > 0) {
    const otherIndex = top.findIndex((t) => t.label === "Other");
    if (otherIndex >= 0) {
      top[otherIndex] = { ...top[otherIndex], value: top[otherIndex].value + restTotal };
    } else {
      top.push({ label: "Other", value: restTotal });
    }
  }

  return top;
}

async function getVehiclesByStatus() {
  const groups = await prisma.vehicle.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = Object.fromEntries(VEHICLE_STATUS_ORDER.map((s) => [s, 0]));
  groups.forEach((g) => (counts[g.status] = g._count._all));
  return VEHICLE_STATUS_ORDER.map((key) => ({
    label: VEHICLE_STATUS_META[key].label,
    value: counts[key],
    color: VEHICLE_STATUS_META[key].color,
  }));
}

async function getDriversByStatus() {
  const groups = await prisma.driver.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = Object.fromEntries(DRIVER_STATUS_ORDER.map((s) => [s, 0]));
  groups.forEach((g) => (counts[g.status] = g._count._all));
  return DRIVER_STATUS_ORDER.map((key) => ({
    label: DRIVER_STATUS_META[key].label,
    value: counts[key],
    color: DRIVER_STATUS_META[key].color,
  }));
}

async function getComplaintsByCategory() {
  const groups = await prisma.complaint.groupBy({ by: ["category"], _count: { _all: true } });
  const counts = Object.fromEntries(COMPLAINT_CATEGORY_ORDER.map((c) => [c, 0]));
  groups.forEach((g) => (counts[g.category] = g._count._all));
  return COMPLAINT_CATEGORY_ORDER.map((key) => ({
    label: COMPLAINT_CATEGORY_META[key].label,
    value: counts[key],
    color: COMPLAINT_CATEGORY_META[key].color,
  }));
}

async function getComplaintsByStatus() {
  const groups = await prisma.complaint.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = Object.fromEntries(COMPLAINT_STATUS_ORDER.map((s) => [s, 0]));
  groups.forEach((g) => (counts[g.status] = g._count._all));
  return COMPLAINT_STATUS_ORDER.map((key) => ({
    label: COMPLAINT_STATUS_META[key].label,
    value: counts[key],
    color: COMPLAINT_STATUS_META[key].color,
  }));
}

// Rides per day for the trailing week, bucketed in JS since it only
// needs to scan `rideDate` — a raw date_trunc query would be marginally
// faster but ties the query to Postgres-specific SQL for little gain
// at this table size.
async function getRidesTrend() {
  const from = startOfDay(daysAgo(TREND_DAYS - 1));
  const rides = await prisma.ride.findMany({
    where: { rideDate: { gte: from } },
    select: { rideDate: true },
  });

  const buckets = {};
  for (let i = 0; i < TREND_DAYS; i++) {
    buckets[dayKey(daysAgo(TREND_DAYS - 1 - i))] = 0;
  }
  rides.forEach((r) => {
    const key = dayKey(r.rideDate);
    if (key in buckets) buckets[key] += 1;
  });

  return Object.entries(buckets).map(([date, value]) => ({
    label: new Date(date).toLocaleDateString(undefined, { weekday: "short" }),
    date,
    value,
  }));
}

async function getTopRoutes(limit = 5) {
  const from = startOfMonth();
  const groups = await prisma.ride.groupBy({
    by: ["routeId"],
    _count: { _all: true },
    where: { rideDate: { gte: from } },
    orderBy: { _count: { routeId: "desc" } },
    take: limit,
  });

  const routeIds = groups.map((g) => g.routeId);
  const routes = routeIds.length
    ? await prisma.route.findMany({
        where: { id: { in: routeIds } },
        select: { id: true, routeCode: true, routeName: true },
      })
    : [];
  const routeById = Object.fromEntries(routes.map((r) => [r.id, r]));

  return groups.map((g) => ({
    routeId: g.routeId,
    routeCode: routeById[g.routeId]?.routeCode || "—",
    routeName: routeById[g.routeId]?.routeName || "Unknown route",
    rides: g._count._all,
  }));
}

async function getRecentComplaints(limit = 5) {
  const complaints = await prisma.complaint.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
    include: {
      employee: { select: { name: true } },
      driver: { select: { name: true } },
    },
  });

  return complaints.map((c) => ({
    id: c.id,
    title: c.title,
    category: COMPLAINT_CATEGORY_META[c.category]?.label || c.category,
    status: COMPLAINT_STATUS_META[c.status]?.label || c.status,
    raisedAgainst: c.driver?.name || c.employee?.name || "N/A",
    createdAt: c.createdAt,
  }));
}

async function getVendorSummary() {
  const vendors = await prisma.vendor.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      _count: { select: { vehicles: true, drivers: true } },
    },
    orderBy: { name: "asc" },
  });

  return vendors.map((v) => ({
    id: v.id,
    name: v.name,
    vehicles: v._count.vehicles,
    drivers: v._count.drivers,
  }));
}

async function getRecentRides(limit = 10) {
  const rides = await prisma.ride.findMany({
    take: limit,
    orderBy: { rideDate: "desc" },
    include: {
      driver: { select: { name: true } },
      vehicle: { select: { vehicleNumber: true } },
      area: { select: { name: true } },
    },
  });

  return rides.map((ride) => ({
    id: ride.id,
    date: ride.rideDate,
    driver: ride.driver?.name || "N/A",
    vehicle: ride.vehicle?.vehicleNumber || "N/A",
    area: ride.area?.name || "N/A",
    status: RIDE_STATUS_META[RIDE_STATUS_BUCKET[ride.status] || "pending"].label,
  }));
}

// ---------------------------------------------------------------------
// GET /api/dashboard/overview
//
// Single aggregate endpoint for the dashboard page — everything below
// runs in parallel and is grouped/counted in Postgres rather than
// shipping full tables to the client to derive in the browser.
// ---------------------------------------------------------------------

const getDashboardOverview = async (req, res, next) => {
  try {
    const [
      stats,
      rideStatusData,
      attendanceData,
      employeesByArea,
      vehiclesByStatus,
      driversByStatus,
      complaintsByCategory,
      complaintsByStatus,
      ridesTrend,
      topRoutes,
      recentComplaints,
      vendorSummary,
      recentRides,
    ] = await Promise.all([
      getHeadlineStats(),
      getRideStatusBreakdown(),
      getTodaysAttendanceBreakdown(),
      getEmployeesByArea(),
      getVehiclesByStatus(),
      getDriversByStatus(),
      getComplaintsByCategory(),
      getComplaintsByStatus(),
      getRidesTrend(),
      getTopRoutes(),
      getRecentComplaints(),
      getVendorSummary(),
      getRecentRides(),
    ]);

    const response = okResponse(
      {
        stats,
        rideStatusData,
        attendanceData,
        employeesByArea,
        vehiclesByStatus,
        driversByStatus,
        complaintsByCategory,
        complaintsByStatus,
        ridesTrend,
        topRoutes,
        recentComplaints,
        vendorSummary,
        recentRides,
      },
      "Dashboard data fetched successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDashboardOverview,
  // exported individually in case a lighter-weight endpoint per section
  // is ever needed (e.g. polling just ridesTrend on an interval)
  getHeadlineStats,
  getRideStatusBreakdown,
  getTodaysAttendanceBreakdown,
  getEmployeesByArea,
  getVehiclesByStatus,
  getDriversByStatus,
  getComplaintsByCategory,
  getComplaintsByStatus,
  getRidesTrend,
  getTopRoutes,
  getRecentComplaints,
  getVendorSummary,
  getRecentRides,
};