// ---------- Area / sub-area lookup and normalization ----------

const { prisma } = require("../lib/prisma");
const { normalizeAreaName } = require("../utils/xlsxParsing");

const findOrCreateNormalizedArea = async (areaName, caches) => {
  const normalizedName = normalizeAreaName(areaName);
  if (!normalizedName) return null;

  const cacheKey = `area::${normalizedName.toLowerCase()}`;
  if (caches?.areaCache?.has(cacheKey)) {
    return caches.areaCache.get(cacheKey);
  }

  let area = await prisma.area.findFirst({
    where: {
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
    },
  });

  if (!area) {
    area = await prisma.area.create({
      data: {
        name: normalizedName,
        city: "Karachi",
      },
    });
    console.log(
      `[area] Created new area: "${normalizedName}" from "${areaName}"`,
    );
  }

  caches?.areaCache?.set(cacheKey, area);
  return area;
};

const getMainArea = async (employee, caches) => {
  if (!employee) return null;

  if (!caches) caches = {};
  if (!caches.areaCache) {
    caches.areaCache = new Map();
  }

  let rawAreaName = null;

  if (employee.area?.name) {
    rawAreaName = employee.area.name;
  } else if (employee.areaId) {
    try {
      const cacheKey = `area::${employee.areaId}`;
      let area = caches.areaCache.get(cacheKey);
      if (area === undefined) {
        area = await prisma.area.findUnique({ where: { id: employee.areaId } });
        caches.areaCache.set(cacheKey, area || null);
      }
      rawAreaName = area?.name || null;
    } catch (areaError) {
      console.error(
        `[weeklySchedule][getMainArea] area lookup failed for employee ${employee.employeeCode} ` +
          `(areaId=${employee.areaId}): ${areaError.message}`,
      );
    }
  }

  if (!rawAreaName && employee.subAreaId) {
    try {
      const cacheKey = `subarea::${employee.subAreaId}`;
      let subArea = caches.areaCache.get(cacheKey);
      if (subArea === undefined) {
        subArea = await prisma.subArea.findUnique({
          where: { id: employee.subAreaId },
          include: { area: true },
        });
        caches.areaCache.set(cacheKey, subArea || null);
      }
      rawAreaName = subArea?.area?.name || subArea?.name || null;
    } catch (subAreaError) {
      console.error(
        `[weeklySchedule][getMainArea] subArea lookup failed for employee ${employee.employeeCode} ` +
          `(subAreaId=${employee.subAreaId}): ${subAreaError.message}.`,
      );
    }
  }

  if (!rawAreaName) {
    console.log(
      `[weeklySchedule][getMainArea] employee ${employee.employeeCode} has no resolvable area ` +
        `(areaId=${employee.areaId || "none"}, subAreaId=${employee.subAreaId || "none"}).`,
    );
    return null;
  }

  const mainArea = await findOrCreateNormalizedArea(rawAreaName, caches);
  console.log(
    `[weeklySchedule][getMainArea] employee ${employee.employeeCode}: "${rawAreaName}" -> "${mainArea?.name || "null"}"`,
  );
  return mainArea;
};

// ============================================================
// findDriver
// ============================================================

module.exports = {
  findOrCreateNormalizedArea,
  getMainArea,
};
