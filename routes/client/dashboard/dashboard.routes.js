const { getDashboardOverview } = require("../../../controllers/client/dashboard/dashboard.controller");
const { Router } = require("express");
const router = Router();
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.get("/overview", getDashboardOverview);

module.exports = router;