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
} = require("../../../controllers/client/schedule/weeklySchedule.controller");
const upload = require("../../../middlewares/upload.middleware");

router.get("/current-week", getCurrentWeekSchedules);
router.get("/grouped", getGroupedSchedules); 
router.get("/stats", getScheduleStats); 
router.get("/employee/:employeeId/range", getEmployeeScheduleRange);

router.get("/", getAllWeeklySchedules);
router.post("/", createWeeklySchedule);

router.get("/schedule-table/stats", getScheduleTableStats);
router.post("/reassignMismatchedShiftEmployees", reassignMismatchedShiftEmployees);
router.post("/optimize", optimizeRouteAssignments);
router.get("/schedule-table/grouped-by-area", getScheduleTableGroupedByArea);
router.get("/weekly-schedule/bulk-upload-status/:jobId", getBulkUploadStatus);
router.post(
  "/rides/create",
  resyncPendingRides
);
router.get("/:id", getWeeklyScheduleById);
router.patch("/:id", updateWeeklySchedule);
router.delete("/:id", deleteWeeklySchedule);
router.post(
  "/weekly-schedule/validate-upload",
  upload.single("file"),          
  validateBulkUploadFile
);

router.post("/bulk-upload", upload.single("file"), bulkUploadWeeklySchedule);


module.exports = router;
