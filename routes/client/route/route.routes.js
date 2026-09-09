const express = require("express");
const router = express.Router();
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

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
  getEligibleEmployeesForTrip,
} = require("../../../controllers/client/route/route.controller");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.post("/", createRoute);
router.get("/", getAllRoutes);
router.get("/employee/:tripId", getEligibleEmployeesForTrip);
router.get("/:id", getRouteById);
router.patch("/:id", updateRoute);
router.delete("/:id", deleteRoute);


router.get("/:id/employees", getRouteEmployees);
router.get("/:id/rides", getRouteRides);
router.get("/:id/stats", getRouteStats);
router.get("/:routeId/weekly-view", getRouteWeeklyView);


router.post("/:routeId/trips", addTripToRoute);
router.patch("/trips/:tripId", updateTripAssignment);


      
module.exports = router;