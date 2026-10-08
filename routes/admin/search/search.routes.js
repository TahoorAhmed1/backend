const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");
const {
  globalSearch,
} = require("../../../controllers/admin/search/search.controller");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.get("/", globalSearch);

module.exports = router;
