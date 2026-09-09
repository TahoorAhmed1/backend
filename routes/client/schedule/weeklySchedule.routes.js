const express = require("express");
const router = express.Router();

const {
  createWeeklySchedule,
  getAllWeeklySchedules,
  getWeeklyScheduleById,
  updateWeeklySchedule,
  deleteWeeklySchedule,
  getCurrentWeekSchedules,
  getEmployeeScheduleRange,
  getGroupedSchedules,
  getScheduleStats,
  getScheduleTableStats,
  getScheduleTableGroupedByArea,
  bulkUploadWeeklySchedule,
  reassignMismatchedShiftEmployees,
  optimizeRouteAssignments,
  getBulkUploadStatus,
  validateBulkUploadFile,
  resyncPendingRides,
  updateTripDriver,
  getDriverOptions,
  updateSingleEmployeeSchedule,
  deleteSingleEmployeeSchedule,
  mergeTrips,
  deleteAllWeeklySchedules,
  assignEmployeeToTrip,
  searchEmployeesForAssignment,
} = require("../../../controllers/client/schedule/weeklySchedule.controller");
const upload = require("../../../middlewares/upload.middleware");

router.get("/current-week", getCurrentWeekSchedules);
router.get("/grouped", getGroupedSchedules);
router.get("/stats", getScheduleStats);
router.get("/employee/:employeeId/range", getEmployeeScheduleRange);

router.get("/", getAllWeeklySchedules);
router.post("/", createWeeklySchedule);

router.get("/schedule-table/stats", getScheduleTableStats);
router.post(
  "/reassignMismatchedShiftEmployees",
  reassignMismatchedShiftEmployees,
);
router.post("/optimize", optimizeRouteAssignments);
router.get("/schedule-table/grouped-by-area", getScheduleTableGroupedByArea);
router.get("/weekly-schedule/bulk-upload-status/:jobId", getBulkUploadStatus);
router.post("/resync-pending-rides", resyncPendingRides);
router.post("/rides/create", resyncPendingRides);
router.get("/driver-options", getDriverOptions);
router.get("/:id", getWeeklyScheduleById);
router.patch("/:id", updateWeeklySchedule);
router.patch("/trip/:tripId/driver", updateTripDriver);
router.patch("/trips/merge", mergeTrips);
router.delete("/delete-all", deleteAllWeeklySchedules);

router.post("/trips/:tripId/assign", assignEmployeeToTrip);
router.get("/employees/search", searchEmployeesForAssignment);

router.patch("/:id/single", updateSingleEmployeeSchedule);
router.delete("/:id/single", deleteSingleEmployeeSchedule);

router.delete("/:id", deleteWeeklySchedule);
router.post(
  "/weekly-schedule/validate-upload",
  upload.single("file"),
  validateBulkUploadFile,
);

router.post("/bulk-upload", upload.single("file"), bulkUploadWeeklySchedule);

module.exports = router;
