const express = require("express");
const router = express.Router();

const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");
const {
  getAllUsers,
  getUserById,
  updateUserRole,
  updateUserStatus,
  resetUserPassword,
} = require("../../../controllers/admin/user/user.controller");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.get("/", getAllUsers);
router.get("/:id", getUserById);
router.patch("/:id/role", updateUserRole);
router.patch("/:id/status", updateUserStatus);
router.post("/:id/reset-password", resetUserPassword);

module.exports = router;
