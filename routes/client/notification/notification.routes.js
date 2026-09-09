const { Router } = require("express");
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const {
  getNotifications,
  markAllNotificationsAsRead,
} = require("../../../controllers/client/notification/notification.controller");

const router = Router();

router.use(verifyUserByToken);

router.get("/", getNotifications);
router.patch("/read-all", markAllNotificationsAsRead);

module.exports = router;
