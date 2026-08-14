const { Router } = require("express");
const router = Router();

const validateRequest = require("../../middlewares/validateRequestJoi.middleware");
const verifyUserByToken = require("../../middlewares/verifyUserByToken");
const requireRole = require("../../utils/requirerole");

const { userLoginSchema } = require("../../validations/auth");

const {
  login,
  getMe,
  userList,
} = require("../../controllers/auth/auth.controllers");


router.post("/login", validateRequest(userLoginSchema), login);

router.get("/me", verifyUserByToken, getMe);

router.get(
  "/users",
  verifyUserByToken,
  requireRole("ADMIN", "MANAGER", "DISPATCHER"),
  userList,
);

module.exports = router;
