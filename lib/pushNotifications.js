const { prisma } = require("../lib/prisma");
const { Expo } = require("expo-server-sdk");

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN, // optional, only if enabled in your Expo project
});

async function sendPushToUser(userId, { title, body, link, data }) {
  const notification = await prisma.notification.create({
    data: { userId, title, body, link, data: data ?? undefined },
  });

  const tokens = await prisma.deviceToken.findMany({
    where: { userId, isActive: true },
    select: { id: true, token: true },
  });

  if (tokens.length === 0) {
    return {
      notificationId: notification.id,
      pushed: 0,
      failed: 0,
      skipped: "no-registered-devices",
    };
  }

  const validTokens = tokens.filter((t) => {
    const ok = Expo.isExpoPushToken(t.token);
    if (!ok)
      console.warn(
        `[push] Skipping malformed Expo token on DeviceToken ${t.id}`,
      );
    return ok;
  });

  const messages = validTokens.map((t) => ({
    to: t.token,
    sound: "default",
    title,
    body: body ?? "",
    data: { link, ...(data ?? {}) },
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...receipts);
    } catch (err) {
      console.warn(
        `[push] sendPushNotificationsAsync failed for user ${userId}: ${err.message}`,
      );
    }
  }

  const deadTokenIds = [];
  let failed = 0;
  tickets.forEach((ticket, i) => {
    if (ticket.status !== "error") return;
    failed += 1;
    if (ticket.details?.error === "DeviceNotRegistered") {
      deadTokenIds.push(validTokens[i].id);
    } else {
      console.warn(
        `[push] send failed for token ${validTokens[i].id}: ${ticket.details?.error} ${ticket.message}`,
      );
    }
  });

  if (deadTokenIds.length) {
    await prisma.deviceToken.updateMany({
      where: { id: { in: deadTokenIds } },
      data: { isActive: false },
    });
  }

  return {
    notificationId: notification.id,
    pushed: tickets.length - failed,
    failed,
  };
}

async function sendPushToUserBestEffort(userId, message) {
  try {
    return await sendPushToUser(userId, message);
  } catch (err) {
    console.warn(`[push] Failed to notify user ${userId}: ${err.message}`);
    return null;
  }
}

module.exports = { sendPushToUser, sendPushToUserBestEffort };
