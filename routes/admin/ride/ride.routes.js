const { Router } = require("express");

const router = Router();

const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");

const {
  rideCreateSchema,
  rideUpdateSchema,
} = require("../../../validations/common");

const {
  createRide,
  getAllRides,
  getRideById,
  updateRide,
  deleteRide,
  addPassengersToRide,
  updateRideStatus,
  getRidePassengers,

  getLiveRides,
  getRideDriverLocation,
  getRideDriverLocationHistory,

  getRideEmployeeLocations,
  getRideEmployeeLocationHistory,
} = require("../../../controllers/admin/ride/ride.controller");

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

router.use(verifyUserByToken, requireRole("ADMIN"));



router.post(
  "/",
  validateRequest(rideCreateSchema),
  createRide
);

router.get("/", getAllRides);

// Must stay ABOVE "/:id" or "live" is treated as a ride id.
router.get("/live", getLiveRides);


router.post("/:id/passengers", addPassengersToRide);

router.get("/:id/passengers", getRidePassengers);


router.patch("/:id/status", updateRideStatus);


router.get("/:id/driver-location", getRideDriverLocation);

router.get(
  "/:id/driver-location/history",
  getRideDriverLocationHistory
);


router.get(
  "/:id/employee-locations",
  getRideEmployeeLocations
);

router.get(
  "/:id/employee-locations/history",
  getRideEmployeeLocationHistory
);



router.get("/:id", getRideById);

router.put(
  "/:id",
  validateRequest(rideUpdateSchema),
  updateRide
);

router.delete("/:id", deleteRide);

module.exports = router;