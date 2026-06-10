const { randomUUID } = require("crypto");

const buildSystemEmail = (prefix, sourceId) => {
  const safePrefix = String(prefix || "user").toLowerCase();
  const safeId = String(sourceId || randomUUID()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || randomUUID().replace(/-/g, "");

  return `${safePrefix}.${safeId}@system.local`;
};

const buildDriverQrCode = (driverId) => {
  return `driver:${driverId}:${randomUUID()}`;
};

const createEmployeeUser = async (tx, employee) => {
  const user = await tx.user.create({
    data: {
      email: buildSystemEmail("employee", employee.id),
      name: employee.name,
      role: "Employee",
      passwordHash: null,
      isActive: true,
    },
  });

  return tx.employee.update({
    where: { id: employee.id },
    data: { userId: user.id },
    include: { user: true },
  });
};

const createDriverUser = async (tx, driver) => {
  const user = await tx.user.create({
    data: {
      email: buildSystemEmail("driver", driver.id),
      name: driver.name,
      role: "DRIVER",
      passwordHash: null,
      qr_code: buildDriverQrCode(driver.id),
      isActive: true,
    },
  });

  return tx.driver.update({
    where: { id: driver.id },
    data: { userId: user.id },
    include: { user: true },
  });
};

module.exports = {
  buildSystemEmail,
  buildDriverQrCode,
  createEmployeeUser,
  createDriverUser,
};