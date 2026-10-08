const { prisma } = require("../../../lib/prisma");
const { Expo } = require("expo-server-sdk");

async function registerDeviceToken(req, res) {
  const userId = req.user?.userId;
  const { token, platform } = req.body || {};

  try {
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });
    if (!token || !platform) {
      return res.status(400).json({ error: "token and platform are required" });
    }
    if (!["IOS", "ANDROID"].includes(platform)) {
      return res.status(400).json({ error: "platform must be IOS or ANDROID" });
    }
    if (!Expo.isExpoPushToken(token)) {
      return res
        .status(400)
        .json({ error: "token is not a valid Expo push token" });
    }

    const deviceToken = await prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform, isActive: true, lastSeenAt: new Date() },
      create: { userId, token, platform },
    });

    res.json({ id: deviceToken.id });
  } catch (err) {
    console.error("[deviceTokenController] registerDeviceToken failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function unregisterDeviceToken(req, res) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });

  try {
    await prisma.deviceToken.updateMany({
      where: { token },
      data: { isActive: false },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[deviceTokenController] unregisterDeviceToken failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = { registerDeviceToken, unregisterDeviceToken };
