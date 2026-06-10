const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  areaCreateSchema,
  areaUpdateSchema,
  areaIdSchema,
} = require("../../../validations/common");
const {
  createArea,
  getAllAreas,
  getAreaById,
  updateArea,
  deleteArea,
  getAreaStats,
} = require("../../../controllers/client/area/area.controller");

router.post("/", validateRequest(areaCreateSchema), createArea);

router.get("/", getAllAreas);

router.get("/stats/overview", getAreaStats);

router.get("/:id", validateRequest(areaIdSchema), getAreaById);

router.put("/:id", validateRequest(areaUpdateSchema), updateArea);

router.delete("/:id", validateRequest(areaIdSchema), deleteArea);

module.exports = router;
