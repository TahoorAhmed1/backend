const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  departmentCreateSchema,
  departmentUpdateSchema,
  departmentIdSchema,
} = require("../../../validations/common");
const {
  createDepartment,
  getAllDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,
} = require("../../../controllers/client/department/department.controller");

router.post("/", validateRequest(departmentCreateSchema), createDepartment);
router.get("/", getAllDepartments);
router.get("/:id", validateRequest(departmentIdSchema), getDepartmentById);
router.put("/:id", validateRequest(departmentUpdateSchema), updateDepartment);
router.delete("/:id", validateRequest(departmentIdSchema), deleteDepartment);

module.exports = router;
