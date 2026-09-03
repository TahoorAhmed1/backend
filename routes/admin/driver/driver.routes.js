const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

const {
  getMyProfile,
  updateMyProfile,
  deleteAccount,
  verifyLicense,
  getTodayRide,
  getMyRides,
  getRideDetails,
  updateRideStatus,
  startRide,
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
  getActiveRide,
  getMyQrCode,
  markAllNotificationsAsRead,
} = require("../../../controllers/admin/driver/driver.controller");
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  listQuerySchema,
  updateDriverProfileSchema,
  updateRideStatusSchema,
  markAttendanceSchema,
  driverComplaintSchema,
} = require("../../../validations/common");

router.use(verifyUserByToken, requireRole("DRIVER"));

// Profile & account
router.get("/profile", getMyProfile);
router.patch(
  "/profile",
  validateRequest(updateDriverProfileSchema),
  updateMyProfile,
);
router.delete("/profile", deleteAccount);
// NOTE: no Document/file-storage model exists yet, so this only records
// the submission (see verifyLicense in the controller) rather than
// accepting a real file upload — swap in multer + a Document model to
// support actual license image/PDF uploads.
router.post("/verify-license", verifyLicense);

// Dashboard
router.get("/dashboard/summary", getDashboardSummary);
router.get("/dashboard/stats", getDriverStats);

// Rides
router.get("/rides/today", getTodayRide);
router.get("/rides", validateRequest(listQuerySchema), getMyRides);
router.get("/rides/:id", getRideDetails);
router.patch(
  "/rides/:id/status",
  validateRequest(updateRideStatusSchema),
  updateRideStatus,
);
router.post("/rides/:id/start", startRide);
router.post("/rides/:id/complete", completeRide);
router.post("/rides/:id/cancel", cancelRide);

// Ride stops
router.get("/rides/:id/stops", getRideStops);
router.patch("/rides/:id/stops/:stopId", updateStopStatus);

// Attendance
router.get("/me/active-ride", getActiveRide);
router.get("/me/qr-code", getMyQrCode);
router.get("/rides/:id/attendance", getRideAttendance);
router.post(
  "/rides/:id/attendance",
  validateRequest(markAttendanceSchema),
  markAttendance,
);
router.patch("/rides/:id/attendance/:employeeId", updateAttendance);

// Complaints
router.get("/complaints", validateRequest(listQuerySchema), getMyComplaints);
router.post(
  "/complaints",
  validateRequest(driverComplaintSchema),
  createComplaint,
);
router.get("/complaints/:id", getComplaintDetails);
router.patch("/complaints/:id", updateComplaint);
router.delete("/complaints/:id", deleteComplaint);

// Notifications
router.get("/notifications", validateRequest(listQuerySchema), getNotifications);
router.patch("/notifications/:id/read", markNotificationAsRead);
router.delete("/notifications/:id", deleteNotification);
router.patch("/notifications/read-all", markAllNotificationsAsRead);


module.exports = router;