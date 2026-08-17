const { getDashboardOverview } = require("../../../controllers/client/dashboard/dashboard.controller");
const { Router } = require("express");
const router = Router();


router.get("/overview", getDashboardOverview);

module.exports = router;