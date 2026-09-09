const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  driverCreateSchema,
  driverUpdateSchema,
} = require("../../../validations/common");
const {
  createDriver,
  getAllDrivers,
  getDriverById,
  updateDriver,
  deleteDriver,
  getDriverRides,
  getDriverComplaints,
  updateDriverStatus,
} = require("../../../controllers/client/driver/driver.controller");
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.post("/", validateRequest(driverCreateSchema), createDriver);

router.get("/", getAllDrivers);

router.get("/:id/rides", getDriverRides);

router.get("/:id/complaints", getDriverComplaints);

router.patch("/:id/status", updateDriverStatus);

router.get("/:id", getDriverById);

router.put("/:id", validateRequest(driverUpdateSchema), updateDriver);

router.delete("/:id", deleteDriver);

module.exports = router;
