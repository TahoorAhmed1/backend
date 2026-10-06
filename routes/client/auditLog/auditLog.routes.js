const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");
const {
  getAllAuditLogs,
} = require("../../../controllers/client/auditLog/auditLog.controller");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.get("/", getAllAuditLogs);

module.exports = router;
