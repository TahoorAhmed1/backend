const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const {
  registerDeviceToken,
  unregisterDeviceToken,
} = require("../../../controllers/client/deviceToken/deviceToken.controller");

router.post("/", verifyUserByToken, registerDeviceToken);
router.delete("/", verifyUserByToken, unregisterDeviceToken);

module.exports = router;
