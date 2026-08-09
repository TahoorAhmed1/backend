const express = require("express");
const router = express.Router();

const {
  createRoute,
  addTripToRoute,
  updateTripAssignment,
  assignEmployeeToTrip,
  getAllRoutes,
  getRouteById,
  updateRoute,
  deleteRoute,
  getRouteEmployees,
  getRouteRides,
  getRouteStats,
  getRouteWeeklyView,
} = require("../../../controllers/client/route/route.controller");

router.post("/", createRoute);
router.get("/", getAllRoutes);
router.get("/:id", getRouteById);
router.patch("/:id", updateRoute);
router.delete("/:id", deleteRoute);


router.get("/:id/employees", getRouteEmployees);
router.get("/:id/rides", getRouteRides);
router.get("/:id/stats", getRouteStats);
router.get("/:routeId/weekly-view", getRouteWeeklyView);


router.post("/:routeId/trips", addTripToRoute);
router.patch("/trips/:tripId", updateTripAssignment);


router.post("/trips/:tripId/assign", assignEmployeeToTrip);

module.exports = router;