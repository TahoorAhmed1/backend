const { prisma } = require("../lib/prisma");
const { pusher } = require("../configs/pusher");
const { Expo } = require("expo-server-sdk");

const expo = new Expo();

/**
 * Staff roles that get notified about driver/employee schedule changes
 * (new complaints, vehicle issues, etc. already use notifyRoles directly —
 * this is specifically the "ops needs to know" role set for assignment
 * changes covered by notifyAdmins below).
 */
const ADMIN_NOTIFY_ROLES = ["ADMIN", "MANAGER", "DISPATCHER"];

/**
 * Send notification to one user.
 *
 * The notification is:
 * 1. Persisted in DB
 * 2. Sent through Pusher for realtime updates
 * 3. Sent through Expo for mobile push notifications
 *
 * Pusher/Expo failures do not prevent the DB notification
 * from being created or returned.
 */
const sendNotificationToUser = async (
  userId,
  { title, body, data = {}, event = "notification-created" },
) => {
  if (!userId) {
    return null;
  }

  let notification = null;
  
  try {
    notification =
      await prisma.notification.create({
        data: {
          userId,
          title,
          body,
          data,
        },
      });
  } catch (err) {
    console.error(
      "[notificationService] Failed to persist notification:",
      err
    );
  }

  const payload = {
    id: notification?.id ?? null,
    title,
    body,
    data,
    createdAt:
      notification?.createdAt ??
      new Date(),
  };

  const channel =
    `private-user-${userId}`;

  try {
    await pusher.trigger(
      channel,
      event,
      payload
    );

    console.log(
      "[Pusher] Notification triggered:",
      {
        channel,
        event,
        notificationId:
          notification?.id,
      }
    );
  } catch (err) {
    console.error(
      "[notificationService] Pusher failed:",
      err
    );
  }

  sendExpoPush(userId, {
    title,
    body,
    data,
  }).catch((err) => {
    console.error(
      "[notificationService] Expo push failed:",
      err
    );
  });

  return notification;
};

const getStaffUserIds = async (excludedIds = []) => {
  const users = await prisma.user.findMany({
    where: {
      role: { in: ADMIN_NOTIFY_ROLES },
      isActive: true,
      ...(excludedIds.length > 0 && { id: { notIn: excludedIds } }),
    },
    select: { id: true },
  });

  return users.map(({ id }) => id);
};

/**
 * Send an event to its normal recipient and copy it to the staff audience.
 * The internal flag prevents notifyRoles from broadcasting the same event
 * back through this helper a second time.
 */
const notifyUser = async (
  userId,
  payload,
  { notifyAdmins = true } = {},
) => {
  const notification = await sendNotificationToUser(userId, payload);

  if (!notifyAdmins) {
    return notification;
  }

  const staffUserIds = await getStaffUserIds([userId]);

  await Promise.all(
    staffUserIds.map((staffUserId) =>
      sendNotificationToUser(staffUserId, payload),
    ),
  );

  return notification;
};

/**
 * Notify multiple users.
 */
const notifyUsers = async (
  userIds = [],
  payload,
  { notifyAdmins = true } = {},
) => {
  const uniqueIds = [
    ...new Set(userIds.filter(Boolean)),
  ];

  if (uniqueIds.length === 0) {
    return [];
  }

  console.log(
    `[notificationService] Sending notification to ${uniqueIds.length} user(s)`
  );

  const notifications = await Promise.all(
    uniqueIds.map((id) =>
      notifyUser(id, payload, { notifyAdmins: false })
    )
  );

  if (!notifyAdmins) {
    return notifications;
  }

  const staffUserIds = await getStaffUserIds(uniqueIds);
  const staffNotifications = await Promise.all(
    staffUserIds.map((staffUserId) =>
      sendNotificationToUser(staffUserId, payload),
    ),
  );

  return [...notifications, ...staffNotifications];
};

/**
 * Notify every user who holds one of the given roles
 * (e.g. ["ADMIN", "MANAGER", "DISPATCHER"]).
 *
 * Used for events that staff/dispatch need to know about but
 * that don't have a single obvious recipient — new complaints,
 * license verification submissions, account deactivations, etc.
 */
const notifyRoles = async (roles = [], payload) => {
  if (!roles.length) {
    return [];
  }

  const users = await prisma.user.findMany({
    where: {
      role: { in: roles },
      isActive: true,
    },
    select: { id: true },
  });

  const userIds = users.map((u) => u.id);

  console.log(
    `[notificationService] notifyRoles(${roles.join(
      ","
    )}) resolved to ${userIds.length} user(s)`
  );

  return notifyUsers(userIds, payload, { notifyAdmins: false });
};

/**
 * Send Expo push notification.
 */
const sendExpoPush = async (
  userId,
  { title, body, data }
) => {
  // ---------------------------------------------------------
  // Find active device tokens
  // ---------------------------------------------------------
  const tokens =
    await prisma.deviceToken.findMany({
      where: {
        userId,
        isActive: true,
      },

      select: {
        token: true,
      },
    });

  console.log(
    `[Expo] user=${userId}, active tokens=${tokens.length}`
  );

  if (tokens.length === 0) {
    console.warn(
      `[Expo] No active device tokens for user ${userId}`
    );
    return;
  }

  // ---------------------------------------------------------
  // Validate Expo tokens
  // ---------------------------------------------------------
  const messages = tokens
    .filter(({ token }) => {
      const valid = Expo.isExpoPushToken(token);

      if (!valid) {
        console.warn(
          `[Expo] Invalid Expo push token: ${token}`
        );
      }

      return valid;
    })
    .map(({ token }) => ({
      to: token,
      sound: "default",
      title,
      body,
      data,
    }));

  if (messages.length === 0) {
    console.warn(
      `[Expo] No valid Expo push tokens for user ${userId}`
    );
    return;
  }

  console.log(
    `[Expo] Sending ${messages.length} push notification(s) to user ${userId}`
  );

  // ---------------------------------------------------------
  // Chunk messages
  // ---------------------------------------------------------
  const chunks =
    expo.chunkPushNotifications(messages);

  const receiptIds = [];
  const staleTokens = [];

  // ---------------------------------------------------------
  // Send messages
  // ---------------------------------------------------------
  for (const chunk of chunks) {
    try {
      const tickets =
        await expo.sendPushNotificationsAsync(
          chunk
        );

      console.log(
        "[Expo] Push tickets:",
        JSON.stringify(tickets, null, 2)
      );

      tickets.forEach((ticket, index) => {
        // Accepted by Expo
        if (ticket.status === "ok") {
          receiptIds.push(ticket.id);
        }

        // Failed immediately
        if (ticket.status === "error") {
          console.error(
            "[Expo] Push ticket error:",
            JSON.stringify(ticket, null, 2)
          );

          if (
            ticket.details?.error ===
            "DeviceNotRegistered"
          ) {
            staleTokens.push(chunk[index].to);
          }
        }
      });
    } catch (error) {
      console.error(
        "[Expo] Failed to send push chunk:",
        error
      );
    }
  }

  // ---------------------------------------------------------
  // Check Expo delivery receipts
  // ---------------------------------------------------------
  if (receiptIds.length > 0) {
    console.log(
      `[Expo] Waiting for ${receiptIds.length} receipt(s)...`
    );

    // Give Expo a short amount of time to generate receipts.
    await new Promise((resolve) =>
      setTimeout(resolve, 1000)
    );

    const receiptChunks =
      expo.chunkPushNotificationReceiptIds(
        receiptIds
      );

    for (const receiptChunk of receiptChunks) {
      try {
        const receipts =
          await expo.getPushNotificationReceiptsAsync(
            receiptChunk
          );

        console.log(
          "[Expo] Push receipts:",
          JSON.stringify(receipts, null, 2)
        );

        for (const [receiptId, receipt] of Object.entries(
          receipts
        )) {
          if (receipt.status === "ok") {
            console.log(
              `[Expo] Push delivered successfully. receipt=${receiptId}`
            );
            continue;
          }

          console.error(
            `[Expo] Push delivery failed. receipt=${receiptId}:`,
            JSON.stringify(receipt, null, 2)
          );

          if (
            receipt.details?.error ===
            "DeviceNotRegistered"
          ) {
            console.warn(
              `[Expo] DeviceNotRegistered for receipt ${receiptId}`
            );
          }
        }
      } catch (error) {
        console.error(
          "[Expo] Failed to retrieve push receipts:",
          error
        );
      }
    }
  }

  // ---------------------------------------------------------
  // Deactivate stale tokens
  // ---------------------------------------------------------
  if (staleTokens.length > 0) {
    await prisma.deviceToken.updateMany({
      where: {
        token: {
          in: staleTokens,
        },
      },

      data: {
        isActive: false,
      },
    });

    console.log(
      `[Expo] Deactivated ${staleTokens.length} stale device token(s)`
    );
  }

  console.log(
    `[Expo] Push processing completed for user ${userId}`
  );
};

/**
 * Notify a driver by their driverId (not their userId).
 *
 * ASSUMPTION: the Driver model has a `userId` field linking to the User
 * account the driver logs into the mobile app with. If your schema links
 * drivers to their user account differently (e.g. a separate profile
 * table, or the field is named something else), update the `select`
 * below to match — everything else (persistence, Pusher, Expo push)
 * still goes through notifyUser once the userId is resolved.
 */
const notifyDriverById = async (driverId, payload) => {
  if (!driverId) return null;

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { userId: true },
  });

  if (!driver?.userId) {
    console.warn(
      `[notificationService] Driver ${driverId} has no linked userId — skipping driver push.`
    );
    return null;
  }

  return notifyUser(driver.userId, payload);
};

/**
 * Notify an employee by their employeeId (not their userId).
 * Same assumption as notifyDriverById above, but for the Employee model.
 */
const notifyEmployeeById = async (employeeId, payload) => {
  if (!employeeId) return null;

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true },
  });

  if (!employee?.userId) {
    console.warn(
      `[notificationService] Employee ${employeeId} has no linked userId — skipping employee push.`
    );
    return null;
  }

  return notifyUser(employee.userId, payload);
};

/**
 * Convenience wrapper: notify Admin/Manager/Dispatcher staff about a
 * driver/employee assignment change.
 */
const notifyAdmins = (payload) => notifyRoles(ADMIN_NOTIFY_ROLES, payload);

module.exports = {
  notifyUser,
  notifyUsers,
  notifyRoles,
  notifyDriverById,
  notifyEmployeeById,
  notifyAdmins,
  ADMIN_NOTIFY_ROLES,
};