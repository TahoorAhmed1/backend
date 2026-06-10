const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  routeCreateSchema,
  routeUpdateSchema,
} = require("../../../validations/common");
const {
  createRoute,
  getAllRoutes,
  getRouteById,
  updateRoute,
  deleteRoute,
  getRouteEmployees,
  getRouteRides,
  getRouteStats,
} = require("../../../controllers/client/route/route.controller");

router.post("/", validateRequest(routeCreateSchema), createRoute);

router.get("/", getAllRoutes);

router.get("/stats/overview", getRouteStats);

router.get("/:id/employees", getRouteEmployees);

router.get("/:id/rides", getRouteRides);

router.get("/:id", getRouteById);

router.put("/:id", validateRequest(routeUpdateSchema), updateRoute);

router.delete("/:id", deleteRoute);

module.exports = router;
