const { Router } = require("express");
const router = Router();

const validateRequest = require("../../middlewares/validateRequestJoi.middleware");
const verifyUserByToken = require("../../middlewares/verifyUserByToken");
const requireRole = require("../../utils/requirerole");

const {
  userLoginSchema,
  userRegisterSchema,
  changePasswordSchema,
} = require("../../validations/auth");

const {
  login,
  getMe,
  userList,
  registerUser,
  resetPassword,
} = require("../../controllers/auth/auth.controllers");

router.post("/login", validateRequest(userLoginSchema), login);
router.patch(
  "/reset-password",
  verifyUserByToken,
  requireRole("DRIVER", "EMPLOYEE"),
  validateRequest(changePasswordSchema),
  resetPassword,
);

router.post(
  "/register",
  // verifyUserByToken,
  // requireRole("ADMIN"),
  validateRequest(userRegisterSchema),
  registerUser
);

router.get("/me", verifyUserByToken, getMe);

router.get(
  "/users",
  verifyUserByToken,
  requireRole("ADMIN", "MANAGER", "DISPATCHER"),
  userList,
);

module.exports = router;
