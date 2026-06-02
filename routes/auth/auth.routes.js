const { Router } = require("express");
const router = Router();
const validateRequest = require("../../middlewares/validateRequestJoi.middleware");
const verifyUserByToken = require("../../middlewares/verifyUserByToken");

const {
  userRegisterSchema,
  userLoginSchema,
} = require("../../validations/auth");

const {
  register,
  login,
  getMe,
  userList,
} = require("../../controllers/auth/auth.controllers");

// Public routes
router.post("/register", validateRequest(userRegisterSchema), register);
router.post("/login", validateRequest(userLoginSchema), login);

// Protected routes
router.get("/users", userList);
router.get("/me", verifyUserByToken, getMe);

module.exports = router;
