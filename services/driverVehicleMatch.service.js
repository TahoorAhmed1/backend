// ---------- Driver / vehicle / vendor / employee lookup ----------

const { prisma } = require("../lib/prisma");
const { normalizeMatch } = require("../utils/xlsxParsing");

const pickBestDriverCandidate = (candidates, normalizedVendor) => {
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const driver = candidates[0];
    const driverVendor = normalizeMatch(driver.vendor?.name);
    const vehicleVendor = normalizeMatch(driver.vehicle?.vendor?.name);

    let result = driver;
    if (normalizedVendor) {
      const vendorUnverifiable = !driverVendor && !vehicleVendor;
      const vendorMismatch =
        !vendorUnverifiable &&
        driverVendor !== normalizedVendor &&
        vehicleVendor !== normalizedVendor;
      if (vendorUnverifiable || vendorMismatch) {
        result.__matchWarning = true;
      }
    }
    return result;
  }

  let filtered = candidates;
  if (normalizedVendor) {
    const vendorFiltered = filtered.filter((d) => {
      const driverVendor = normalizeMatch(d.vendor?.name);
      const vehicleVendor = normalizeMatch(d.vehicle?.vendor?.name);
      return (
        driverVendor === normalizedVendor || vehicleVendor === normalizedVendor
      );
    });
    if (vendorFiltered.length > 0) filtered = vendorFiltered;
  }

  if (filtered.length === 1) {
    const result = filtered[0];
    if (normalizedVendor && filtered === candidates && candidates.length > 1) {
      result.__matchWarning = true;
    }
    return result;
  } else if (filtered.length > 1) {
    const result = filtered[0];
    result.__matchWarning = true;
    return result;
  }
  return null;
};


// Sheet cells sometimes name more than one driver for a single row, e.g.
// "Asim 03006853754 / Azam 03092500123" (seen in practice for shared/backup
// drivers). We only support assigning one driver per trip row, so we take
// the first name and flag the row (via __multiDriverCell/__droppedDriverNames
// on the returned driver) so the dropped name(s) surface for manual review
// instead of silently disappearing. Handles "/", ",", "&", and " and " as
// separators between driver entries.
const DRIVER_CELL_SEPARATOR_REGEX = /\s*\/\s*|\s*,\s*|\s+(?:and|&)\s+/i;

const splitDriverCell = (rawInput) =>
  rawInput
    .split(DRIVER_CELL_SEPARATOR_REGEX)
    .map((part) => part.trim())
    .filter(Boolean);

const findDriver = async (
  driverName,
  vendorNameFromSheet,
  vehicleTypeFromSheet,
  cache,
  extraCaches,
) => {
  const rawInput = String(driverName || "").trim();
  if (!rawInput) return null;

  const driverParts = splitDriverCell(rawInput);
  const hadMultipleDrivers = driverParts.length > 1;
  const droppedDriverNames = hadMultipleDrivers ? driverParts.slice(1) : [];
  const trimmedName = driverParts[0] || rawInput;

  const normalizedName = trimmedName.replace(/\s+/g, " ");
  const normalizedVendor = normalizeMatch(vendorNameFromSheet);
  const firstWord = normalizedName.split(" ")[0];

  const cacheKey = `${normalizedName.toLowerCase()}::${normalizedVendor}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const driverInclude = {
    vehicle: { include: { vendor: true } },
    vendor: true,
  };

  const vendorClause = normalizedVendor
    ? {
        OR: [
          {
            vendor: { name: { equals: normalizedVendor, mode: "insensitive" } },
          },
          {
            vehicle: {
              vendor: {
                name: { equals: normalizedVendor, mode: "insensitive" },
              },
            },
          },
        ],
      }
    : null;

  let candidates = await prisma.driver.findMany({
    where: { name: { equals: normalizedName, mode: "insensitive" } },
    include: driverInclude,
  });

  let matchedLoosely = false;
  if (candidates.length === 0 && firstWord && firstWord !== normalizedName) {
    const nameClause = { name: { equals: firstWord, mode: "insensitive" } };

    if (vendorClause) {
      candidates = await prisma.driver.findMany({
        where: { AND: [nameClause, vendorClause] },
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }

    if (candidates.length === 0) {
      candidates = await prisma.driver.findMany({
        where: nameClause,
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }
  }

  if (candidates.length === 0 && firstWord) {
    const nameClause = { name: { contains: firstWord, mode: "insensitive" } };

    if (vendorClause) {
      candidates = await prisma.driver.findMany({
        where: { AND: [nameClause, vendorClause] },
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }

    if (candidates.length === 0) {
      candidates = await prisma.driver.findMany({
        where: nameClause,
        include: driverInclude,
      });
      if (candidates.length) matchedLoosely = true;
    }
  }

  const result = pickBestDriverCandidate(candidates, normalizedVendor);
  if (result && matchedLoosely) result.__looseNameMatch = true;
  if (result && hadMultipleDrivers) {
    result.__multiDriverCell = true;
    result.__droppedDriverNames = droppedDriverNames;
  }

  cache?.set(cacheKey, result);
  if (result) extraCaches?.driverById?.set(result.id, result);
  return result;
};

const resolveDriverIdByName = async (driverName, vendorName, cache, extraCaches) => {
  const driver = await findDriver(
    driverName,
    vendorName,
    undefined,
    cache,
    extraCaches,
  );
  return driver?.id || null;
};


const findVehicleByReg = async (vehicleReg, cache) => {
  const trimmed = String(vehicleReg || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toUpperCase();
  if (cache?.has(key)) return cache.get(key);

  const vehicle = await prisma.vehicle.findFirst({
    where: { vehicleNumber: { equals: trimmed, mode: "insensitive" } },
  });
  cache?.set(key, vehicle || null);
  return vehicle;
};


const findVendor = async (name, cache) => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (cache?.has(key)) return cache.get(key);

  const vendor = await prisma.vendor.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
  });
  cache?.set(key, vendor || null);
  return vendor;
};


const findEmployee = async (employeeCode, caches) => {
  if (caches?.employee?.has(employeeCode)) {
    return caches.employee.get(employeeCode) || null;
  }
  const employee = await prisma.employee.findUnique({
    where: { employeeCode },
    include: { area: true, subArea: true, block: true },
  });
  caches?.employee?.set(employeeCode, employee || null);
  return employee;
};


module.exports = {
  pickBestDriverCandidate,
  splitDriverCell,
  findDriver,
  resolveDriverIdByName,
  findVehicleByReg,
  findVendor,
  findEmployee,
};