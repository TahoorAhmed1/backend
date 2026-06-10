const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  vendorCreateSchema,
  vendorUpdateSchema,
  vendorIdSchema,
} = require("../../../validations/common");
const {
  createVendor,
  getAllVendors,
  getVendorById,
  updateVendor,
  deleteVendor,
  getVendorVehicles,
  getVendorDrivers,
} = require("../../../controllers/client/vendor/vendor.controller");

router.post("/", validateRequest(vendorCreateSchema), createVendor);

router.get("/", getAllVendors);

router.get("/:id/vehicles", validateRequest(vendorIdSchema), getVendorVehicles);

router.get("/:id/drivers", validateRequest(vendorIdSchema), getVendorDrivers);

router.get("/:id", validateRequest(vendorIdSchema), getVendorById);

router.put("/:id", validateRequest(vendorUpdateSchema), updateVendor);

router.delete("/:id", validateRequest(vendorIdSchema), deleteVendor);

module.exports = router;
