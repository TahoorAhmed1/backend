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
} = require("../../../controllers/client/ride/ride.controller");
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.post("/", validateRequest(rideCreateSchema), createRide);

router.get("/", getAllRides);

router.post("/:id/passengers", addPassengersToRide);

router.get("/:id/passengers", getRidePassengers);

router.patch("/:id/status", updateRideStatus);

router.get("/:id", getRideById);

router.put("/:id", validateRequest(rideUpdateSchema), updateRide);

router.delete("/:id", deleteRide);

module.exports = router;
