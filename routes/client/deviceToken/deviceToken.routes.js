const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");
const {
  registerDeviceToken,
  unregisterDeviceToken,
} = require("../../../controllers/admin/deviceToken/deviceToken.controller");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.post("/", registerDeviceToken);
router.delete("/", unregisterDeviceToken);

module.exports = router;
