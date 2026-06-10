const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  subAreaCreateSchema,
  subAreaUpdateSchema,
  subAreaIdSchema,
} = require("../../../validations/common");
const {
  createSubArea,
  getAllSubAreas,
  getSubAreaById,
  updateSubArea,
  deleteSubArea,
} = require("../../../controllers/client/subArea/subArea.controller");

router.post("/", validateRequest(subAreaCreateSchema), createSubArea);
router.get("/", getAllSubAreas);
router.get("/:id", validateRequest(subAreaIdSchema), getSubAreaById);
router.put("/:id", validateRequest(subAreaUpdateSchema), updateSubArea);
router.delete("/:id", validateRequest(subAreaIdSchema), deleteSubArea);

module.exports = router;
