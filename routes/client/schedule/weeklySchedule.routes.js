const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  weeklyScheduleCreateSchema,
  weeklyScheduleUpdateSchema,
} = require("../../../validations/common");
const {
  createWeeklySchedule,
  getAllWeeklySchedules,
  getWeeklyScheduleById,
  updateWeeklySchedule,
  deleteWeeklySchedule,
  getCurrentWeekSchedules,
  getEmployeeScheduleRange,
} = require("../../../controllers/client/schedule/weeklySchedule.controller");

router.post("/", validateRequest(weeklyScheduleCreateSchema), createWeeklySchedule);

router.get("/", getAllWeeklySchedules);

router.get("/week/current", getCurrentWeekSchedules);

router.get("/employee/:employeeId", getEmployeeScheduleRange);

router.get("/:id", getWeeklyScheduleById);

router.put("/:id", validateRequest(weeklyScheduleUpdateSchema), updateWeeklySchedule);

router.delete("/:id", deleteWeeklySchedule);

module.exports = router;
