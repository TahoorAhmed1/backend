const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  attendanceCreateSchema,
  attendanceUpdateSchema,
  attendanceScanSchema,
} = require("../../../validations/common");
const {
  createAttendance,
  scanAttendanceByQrCode,
  getAllAttendance,
  getAttendanceById,
  updateAttendance,
  deleteAttendance,
  getAttendanceSummary,
} = require("../../../controllers/client/attendance/attendance.controller");

router.post("/", validateRequest(attendanceCreateSchema), createAttendance);

router.post("/scan", validateRequest(attendanceScanSchema), scanAttendanceByQrCode);

router.get("/", getAllAttendance);

router.get("/summary/report", getAttendanceSummary);

router.get("/:id", getAttendanceById);

router.put("/:id", validateRequest(attendanceUpdateSchema), updateAttendance);

router.delete("/:id", deleteAttendance);

module.exports = router;
