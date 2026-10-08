const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");
const {
  getAllExceptions,
  resolveException,
  deleteException,
} = require("../../../controllers/admin/exception/exception.controller");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.get("/", getAllExceptions);
router.patch("/:id/resolve", resolveException);
router.delete("/:id", deleteException);

module.exports = router;
