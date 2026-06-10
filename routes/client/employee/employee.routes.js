const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  employeeCreateSchema,
  employeeUpdateSchema,
  employeeIdSchema,
} = require("../../../validations/common");
const {
  createEmployee,
  getAllEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  getEmployeeSchedule,
  getEmployeeAttendance,
  getEmployeeComplaints,
} = require("../../../controllers/client/employee/employee.controller");

router.post("/", validateRequest(employeeCreateSchema), createEmployee);

router.get("/", getAllEmployees);

router.get("/:id/schedule", validateRequest(employeeIdSchema), getEmployeeSchedule);

router.get("/:id/attendance", validateRequest(employeeIdSchema), getEmployeeAttendance);

router.get("/:id/complaints", validateRequest(employeeIdSchema), getEmployeeComplaints);

router.get("/:id", validateRequest(employeeIdSchema), getEmployeeById);

router.put("/:id", validateRequest(employeeUpdateSchema), updateEmployee);

router.delete("/:id", validateRequest(employeeIdSchema), deleteEmployee);

module.exports = router;
