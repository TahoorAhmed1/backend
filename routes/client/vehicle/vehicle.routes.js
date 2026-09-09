const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  vehicleCreateSchema,
  vehicleUpdateSchema,
} = require("../../../validations/common");
const {
  createVehicle,
  getAllVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  getVehicleRides,
  updateVehicleStatus,
  getVehicleComplaints,
} = require("../../../controllers/client/vehicle/vehicle.controller");
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.post("/", validateRequest(vehicleCreateSchema), createVehicle);

router.get("/", getAllVehicles);

router.get("/:id/rides", getVehicleRides);

router.get("/:id/complaints", getVehicleComplaints);

router.patch("/:id/status", updateVehicleStatus);

router.get("/:id", getVehicleById);

router.put("/:id", validateRequest(vehicleUpdateSchema), updateVehicle);

router.delete("/:id", deleteVehicle);

module.exports = router;
