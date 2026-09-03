const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

const {
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
  markAttendanceByQr,
  markNotificationAsRead,
  deleteNotification,
  markAllNotificationsAsRead,
  getAllWeeklySchedules,
} = require("../../../controllers/admin/employee/employee.controller.js");
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const { updateEmployeeProfileSchema, confirmRideSchema, weeklyScheduleQuerySchema, markMyAttendanceSchema, listQuerySchema, employeeComplaintSchema, recentRidesQuerySchema } = require("../../../validations/common");

// Every route below requires a valid token AND the EMPLOYEE role.
router.use(verifyUserByToken, requireRole("EMPLOYEE"));

router.get("/profile", getMyProfile);
router.patch(
  "/profile",
  validateRequest(updateEmployeeProfileSchema),
  updateMyProfile,
);

router.get("/rides/today", getTodayRide);
router.post(
  "/rides/today/confirm",
  validateRequest(confirmRideSchema),
  confirmTodayRide,
);
router.post(
  "/me/attendance/scan",
  markAttendanceByQr,
);

router.get(
  "/schedule",
  validateRequest(weeklyScheduleQuerySchema),
  getWeeklySchedule,
);
router.get(
  "/schedule/all",
  getAllWeeklySchedules,
);
router.get("/schedule/summary", getWeekSummary);

router.post(
  "/attendance/scan",
  validateRequest(markMyAttendanceSchema),
  markMyAttendance,
);

router.get(
  "/complaints",
  validateRequest(listQuerySchema),
  getMyComplaints,
);
router.post(
  "/complaints",
  validateRequest(employeeComplaintSchema),
  createComplaint,
);
router.get(
  "/complaints/recent-rides",
  validateRequest(recentRidesQuerySchema),
  getRecentRides,
);

router.get(
  "/notifications",
  validateRequest(listQuerySchema),
  getNotifications,
);
router.patch("/notifications/read-all", markAllNotificationsAsRead);
router.patch("/notifications/:id/read", markNotificationAsRead);
router.delete("/notifications/:id", deleteNotification);

module.exports = router;