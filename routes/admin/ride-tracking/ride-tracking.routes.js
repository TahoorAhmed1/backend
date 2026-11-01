const { Router } = require("express");
const router = Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");
const {
  locationRateLimit,
  locationRequestMetrics,
} = require("../../../middlewares/locationRateLimit");
const { postDriverLocation, postEmployeeLocation } = require("../../../controllers/admin/ride-tracking/ride-tracking.controller");

router.use(verifyUserByToken);

router.post(
  "/driver/rides/:id/location",
  requireRole("DRIVER"),
  locationRequestMetrics,
  locationRateLimit("driver"),
  postDriverLocation,
);
router.post(
  "/employee/rides/:id/location",
  requireRole("EMPLOYEE"),
  locationRequestMetrics,
  locationRateLimit("employee"),
  postEmployeeLocation,
);

module.exports = router;