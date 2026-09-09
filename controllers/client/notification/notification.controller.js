const { prisma } = require("../../../lib/prisma");
const {
  badRequestResponse,
  okResponse,
} = require("../../../constants/responses");

const parsePagination = (query) => {
  const skip = parseInt(query.skip, 10) || 0;
  const take = parseInt(query.take, 10) || 10;

  return {
    skip: Math.max(0, skip),
    take: Math.max(1, Math.min(take, 100)),
  };
};

const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const response = badRequestResponse("User not authenticated.");
      return res.status(response.status.code).json(response);
    }

    const skip = (parseInt(1) - 1) * parseInt(10);
    const take = Math.min(Math.max(parseInt(10) || 10, 1), 100);
	
    const { status } = req.query;
    const where = {
      userId,
      ...(status && { status }),
    };

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: skip || 10,
        take: skip || 10,
      }),
      prisma.notification.count({ where }),
    ]);
    const response = okResponse(
      { data: notifications, total, skip, take },
      "Notifications retrieved successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log("error", error);
    next(error);
  }
};

const markAllNotificationsAsRead = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const response = badRequestResponse("User not authenticated.");
      return res.status(response.status.code).json(response);
    }

    const { count } = await prisma.notification.updateMany({
      where: { userId, status: "UNREAD" },
      data: { status: "READ" },
    });

    const response = okResponse(
      { markedCount: count },
      `${count} notification(s) marked as read.`,
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getNotifications,
  markAllNotificationsAsRead,
};
