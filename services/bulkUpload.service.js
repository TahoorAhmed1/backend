// ---------- Bulk upload (background job) ----------

const XLSX = require("xlsx");
const { prisma } = require("../lib/prisma");
const {
  DAY_KEYS,
  computePickupTime,
  parseSheetTimeToDate,
} = require("../utils/dateTimeHelpers");
const {
  HEADER_ALIASES,
  parseOffDays,
  deriveServiceType,
  normalizeEntity,
  normalizeAreaName,
  parseDriverEntries,
  scheduleDataChanged,
} = require("../utils/xlsxParsing");
const { findOrCreateNormalizedArea } = require("./areaLookup.service");
const {
  findDriver,
  findEmployee,
  findVendor,
  resolveDriverIdByName,
} = require("./driverVehicleMatch.service");
const {
  resolveConflictFreeAssignment,
  findOrCreateVehicleForDriver,
} = require("./autoAssignment.service");
const { findOrCreateRouteAndTrip } = require("./routeTrip.service");
const { normalizeShift } = require("../utils/shiftTime");
const { sortTripsByOccupancy } = require("../utils/tripSelection");

// Job creation/status is now handled by bulkUpload.producer.js, which writes
// to the BulkUploadJob table instead of this in-memory Map. That table
// survives process restarts and is visible across every instance, which
// fixes the two most likely causes of jobs silently disappearing on AWS.
//
// This function just persists progress as the job runs, so a status-polling
// endpoint reading BulkUploadJob sees live numbers instead of only a final
// result at the very end.
const updateJobProgress = async (jobId, patch) => {
  try {
    await prisma.bulkUploadJob.update({ where: { id: jobId }, data: patch });
  } catch (error) {
    // Don't let a progress-write hiccup abort the actual upload job.
    console.error(
      `[weeklySchedule][job ${jobId}] progress update failed:`,
      error.message,
    );
  }
};

const processUpdateScheduleJob = async (
  jobId,
  workbook,
  weekStartDate,
  batchSize = 100,
) => {
  console.log(
    `[weeklySchedule][job ${jobId}] START updateSchedule compare weekStart=${weekStartDate} batchSize=${batchSize}`,
  );

  const sheetName = workbook.SheetNames[0] || "Sheet1";
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });

  const headerRowIndex = rows.findIndex((r) =>
    r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
  );

  if (headerRowIndex === -1) {
    console.log(
      `[weeklySchedule][job ${jobId}] updateSchedule skipped: no Employee ID header`,
    );
    return {
      action: "UPDATE_SCHEDULE",
      matchedEmployees: 0,
      changedEmployees: 0,
      processedEmployees: 0,
      created: 0,
      updated: 0,
      routesCreated: 0,
      tripsCreated: 0,
      tripsReused: 0,
      message: "No Employee ID header found in uploaded workbook.",
    };
  }

  const colIndex = {};
  rows[headerRowIndex].forEach((cell, i) => {
    const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
    if (key) colIndex[key] = i;
  });

  const employeeCodeCol = colIndex.employeeCode;
  const changedEmployeeCodes = new Set();
  const matchedEmployeeCodes = new Set();

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const raw = rows[i];
    const employeeCode =
      employeeCodeCol !== undefined
        ? String(raw[employeeCodeCol] ?? "").trim()
        : "";

    if (!employeeCode) continue;

    console.log(
      `[weeklySchedule][job ${jobId}] updateSchedule scanning employeeCode`,
      {
        employeeCode,
        rowNumber: i + 2,
      },
    );

    const employee = await prisma.employee.findUnique({
      where: { employeeCode },
      select: { id: true, employeeCode: true },
    });

    if (!employee) {
      console.log(
        `[weeklySchedule][job ${jobId}] updateSchedule ignored unmatched employeeCode`,
        {
          employeeCode,
        },
      );
      continue;
    }

    matchedEmployeeCodes.add(employeeCode);

    const existingSchedule = await prisma.weeklySchedule.findUnique({
      where: {
        employeeId_weekStart: {
          employeeId: employee.id,
          weekStart: weekStartDate,
        },
      },
    });

    if (!existingSchedule) {
      console.log(
        `[weeklySchedule][job ${jobId}] updateSchedule no schedule; changed employee`,
        {
          employeeCode,
        },
      );
      changedEmployeeCodes.add(employeeCode);
      continue;
    }

    const comparable = {
      shiftTiming: existingSchedule.shiftTiming,
      driverId: existingSchedule.driverId,
      routeId: existingSchedule.routeId,
      pickupTime: existingSchedule.pickupTime,
      officeArrivalTime: existingSchedule.officeArrivalTime,
      dropTime: existingSchedule.dropTime,
      offDay: existingSchedule.offDay,
      monday: existingSchedule.monday,
      tuesday: existingSchedule.tuesday,
      wednesday: existingSchedule.wednesday,
      thursday: existingSchedule.thursday,
      friday: existingSchedule.friday,
      saturday: existingSchedule.saturday,
      sunday: existingSchedule.sunday,
    };

    const sheetArrival = parseSheetTimeToDate(
      String(raw[colIndex.officeArrivalTime] ?? "").trim(),
    );
    const sheetDrop = parseSheetTimeToDate(
      String(raw[colIndex.dropTime] ?? "").trim(),
    );

    // ---- Sheet driver NAME -> actual Driver.id UUID ----
    // Previous version compared the raw sheet string (e.g. "Nadeem") against
    // existingSchedule.driverId (a UUID), so scheduleDataChanged always
    // returned true and every row got re-processed on every run.
    //
    // Blank cell = "leave the driver alone", NOT "clear the driver". This is
    // the exact bug that moved Dia Adeel off her Amir-driven trip and onto
    // Nadeem's trip during an update run whose sheet only contained Marium's
    // row — her own row was never in the workbook, but the comparison still
    // treated the blank sheet cell as a driver change.
    const sheetDriverName = String(raw[colIndex.drivers] ?? "").trim();
    const sheetVendorName = String(raw[colIndex.vendor] ?? "").trim();
    const sheetDriverId = sheetDriverName
      ? ((await resolveDriverIdByName(sheetDriverName, sheetVendorName)) ??
        existingSchedule.driverId)
      : existingSchedule.driverId;

    // Same "blank means keep" rule for shift timing. If the sheet doesn't
    // specify a new shift, the existing one stays — otherwise a stray blank
    // cell would clobber the whole schedule.
    const sheetShiftTiming = String(raw[colIndex.shiftTiming] ?? "").trim();
    const effectiveShiftTiming =
      sheetShiftTiming || existingSchedule.shiftTiming;
    const offDaySet = parseOffDays(raw[colIndex.offDay]);
    const dayValue = (day) => (offDaySet.has(day) ? "OFF" : "BOTH");

    const incoming = {
      shiftTiming: effectiveShiftTiming,
      driverId: sheetDriverId,
      // Sheet's "Route" column is a route CODE (string), while
      // existingSchedule.routeId is a UUID. There is no safe 1:1 resolution
      // here without knowing which route the operator meant (multiple rows
      // can share a code across weeks), so we do NOT use routeId as a
      // change signal — driverId + shiftTiming + timing columns already
      // cover every meaningful edit path.
      routeId: existingSchedule.routeId,
      pickupTime: sheetArrival
        ? computePickupTime(sheetArrival)
        : existingSchedule.pickupTime,
      officeArrivalTime: sheetArrival || existingSchedule.officeArrivalTime,
      dropTime: sheetDrop || existingSchedule.dropTime,
      offDay:
        String(raw[colIndex.offDay] ?? "").trim() || existingSchedule.offDay,
      monday: dayValue("monday"),
      tuesday: dayValue("tuesday"),
      wednesday: dayValue("wednesday"),
      thursday: dayValue("thursday"),
      friday: dayValue("friday"),
      saturday: dayValue("saturday"),
      sunday: dayValue("sunday"),
    };

    const hasChanged = scheduleDataChanged(comparable, incoming);
    console.log(
      `[weeklySchedule][job ${jobId}] updateSchedule compare result`,
      {
        employeeCode,
        existingShift: comparable.shiftTiming,
        incomingShift: incoming.shiftTiming,
        existingDriverId: comparable.driverId,
        incomingDriverId: incoming.driverId,
        sheetDriverName,
        hasChanged,
      },
    );

    if (hasChanged) {
      console.log(
        `[weeklySchedule][job ${jobId}] updateSchedule changed employee queued`,
        {
          employeeCode,
        },
      );
      changedEmployeeCodes.add(employeeCode);
    } else {
      console.log(
        `[weeklySchedule][job ${jobId}] updateSchedule no-change employee ignored`,
        {
          employeeCode,
        },
      );
    }
  }

  const changedCodes = Array.from(changedEmployeeCodes);

  // Safety net: only forward codes that actually exist in this workbook's
  // matched set. Belt-and-braces against any comparison-path bug that leaks
  // an employee whose row isn't even in the sheet into changedCodes.
  const matchedSet = new Set(matchedEmployeeCodes);
  const safeChangedCodes = changedCodes.filter((code) => matchedSet.has(code));
  const droppedCodes = changedCodes.filter((code) => !matchedSet.has(code));

  console.log(`[weeklySchedule][job ${jobId}] updateSchedule diff summary`, {
    matchedEmployees: matchedEmployeeCodes.size,
    changedEmployees: changedCodes.length,
    safeChangedEmployees: safeChangedCodes.length,
    changedCodes,
    droppedCodes,
  });

  if (!safeChangedCodes.length) {
    return {
      action: "UPDATE_SCHEDULE",
      weekStart: weekStartDate.toISOString().slice(0, 10),
      matchedEmployees: matchedEmployeeCodes.size,
      changedEmployees: 0,
      processedEmployees: 0,
      created: 0,
      updated: 0,
      routesCreated: 0,
      tripsCreated: 0,
      tripsReused: 0,
      message:
        "No matched employees had schedule changes in the uploaded sheet.",
    };
  }

  console.log(
    `[weeklySchedule][job ${jobId}] updateSchedule reparsing changed subset`,
    {
      changedEmployees: safeChangedCodes.length,
    },
  );

  const results = await processBulkUploadJob(
    jobId,
    workbook,
    weekStartDate,
    batchSize,
    safeChangedCodes,
    // Sheet is authoritative for driver/vehicle/timing on update runs:
    // cached driver->trip and trip occupancy from the existing week roster
    // would otherwise keep employees on their OLD trip even when the sheet
    // specifies a different driver (e.g. Dia stays with Amir even though the
    // sheet moved Marium to Nadeem).
    { resetDriversFromSheet: true },
  );

  return {
    action: "UPDATE_SCHEDULE",
    weekStart: weekStartDate.toISOString().slice(0, 10),
    matchedEmployees: matchedEmployeeCodes.size,
    changedEmployees: safeChangedCodes.length,
    processedEmployees: safeChangedCodes.length,
    ...results,
    message: `Updated ${safeChangedCodes.length} matched employee schedule(s) from the uploaded sheet.`,
  };
};

const processBulkUploadJob = async (
  jobId,
  workbook,
  weekStartDate,
  batchSize = 100,
  employeeCodeFilter = null,
  options = {},
) => {
  const resetDriversFromSheet = Boolean(options.resetDriversFromSheet);

  console.log(
    `[weeklySchedule][job ${jobId}] START weekStart=${weekStartDate} batchSize=${batchSize} ` +
      `filter=${employeeCodeFilter ? employeeCodeFilter.length : "none"} ` +
      `resetDriversFromSheet=${resetDriversFromSheet}`,
  );

  const results = {
    created: 0,
    updated: 0,
    employeesNotFound: 0,
    routesCreated: 0,
    driversAutoAssigned: 0,
    vehiclesAutoAssigned: 0,
    vehiclesCreated: 0,
    skipped: [],
    sheetsProcessed: [],
    sheetsSkipped: [],
    tripsCreated: 0,
    tripsReused: 0,
    employeesReassigned: 0,
    totalCapacityUsed: 0,
    totalCapacityAvailable: 0,
  };

  const pendingWrites = [];
  const employeeWriteLocks = new Map();
  let processedRowCount = 0;
  let batchesCompletedCount = 0;

  const skipRow = async (sheetName, rowNum, employeeCode, reason, rawData) => {
    console.error(
      `[weeklySchedule][SKIP] sheet="${sheetName}" row=${rowNum} employeeCode=${employeeCode || "?"} reason: ${reason}`,
    );
    results.skipped.push({
      sheet: sheetName,
      row: rowNum,
      employeeCode,
      reason,
    });
    try {
      await prisma.scheduleException.create({
        data: {
          weekStart: weekStartDate,
          employeeCode: employeeCode || undefined,
          rowNumber: rowNum ?? undefined,
          reason: `[${sheetName}] ${reason}`,
          rawData: rawData ? JSON.parse(JSON.stringify(rawData)) : undefined,
        },
      });
    } catch (exceptionLogError) {}
  };

  const applyCacheEffects = (
    savedSchedule,
    { employee, scheduleData, dayFields, route },
  ) => {
    if (!caches) return;
    caches.scheduleByEmployeeId.set(employee.id, savedSchedule);
    const idx = (caches.weekRoster || []).findIndex(
      (r) => r.employeeId === employee.id,
    );
    const entry = {
      employeeId: employee.id,
      tripId: scheduleData.tripId,
      routeId: scheduleData.routeId,
      driverId: scheduleData.driverId || null,
      vehicleId: scheduleData.vehicleId || null,
      shiftTiming: scheduleData.shiftTiming,
      route,
      ...dayFields,
    };
    if (idx === -1) {
      if (caches.weekRoster) caches.weekRoster.push(entry);
    } else {
      if (caches.weekRoster)
        caches.weekRoster[idx] = { ...caches.weekRoster[idx], ...entry };
    }
  };

  const flushPendingWrites = async () => {
    if (!pendingWrites.length) return;
    const batch = pendingWrites.splice(0, pendingWrites.length);
    processedRowCount += batch.length;
    // Fire-and-forget: don't block row processing on a progress write.
    updateJobProgress(jobId, {
      processedRows: processedRowCount,
      batchesCompleted: (batchesCompletedCount += 1),
    });
    try {
      const saved = await prisma.$transaction(
        batch.map((item) =>
          prisma.weeklySchedule.upsert({
            where: {
              employeeId_weekStart: {
                employeeId: item.scheduleData.employeeId,
                weekStart: item.scheduleData.weekStart,
              },
            },
            update: item.scheduleData,
            create: item.scheduleData,
          }),
        ),
        { timeout: 20000, maxWait: 10000 },
      );
      saved.forEach((savedSchedule, i) =>
        applyCacheEffects(savedSchedule, batch[i]),
      );
    } catch (batchError) {
      console.error(
        `[flushPendingWrites] BATCH TRANSACTION FAILED: ${batchError.message}`,
      );
      for (const item of batch) {
        try {
          const savedSchedule = await prisma.weeklySchedule.upsert({
            where: {
              employeeId_weekStart: {
                employeeId: item.scheduleData.employeeId,
                weekStart: item.scheduleData.weekStart,
              },
            },
            update: item.scheduleData,
            create: item.scheduleData,
          });
          applyCacheEffects(savedSchedule, item);
        } catch (rowError) {
          await skipRow(
            item.sheetName,
            item.rowNum,
            item.employeeCode,
            rowError.message,
            item.raw,
          );
        }
      }
    }
  };

  try {
    await prisma.$transaction(
      async (tx) => {
        const lockKey = `weekly-schedule::${weekStartDate.toISOString()}::no-area`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      },
      { maxWait: 10000, timeout: 10000 },
    );
  } catch (lockError) {
    console.warn(
      `[weeklySchedule] Skipping week/area lock (continuing without it): ${lockError.message}`,
    );
  }

  const caches = {
    employee: new Map(),
    driver: new Map(),
    vendor: new Map(),
    vehicle: new Map(),
    areaCache: new Map(),
    routesByArea: new Map(),
    tripsByRoute: new Map(),
    routeById: new Map(),
    tripIdByDriver: new Map(),
    tripById: new Map(),
    weekRoster: [],
    availableDrivers: [],
    activeVehicles: [],
    driverById: new Map(),
    scheduleByEmployeeId: new Map(),
    tripOccupancy: new Map(),
    tripCapacity: new Map(),
    tripDriverMap: new Map(),
    tripRouteMap: new Map(),
  };

  console.log(`[weeklySchedule][job ${jobId}] Pre-fetching existing data...`);

  const [existingWeekRoster, availableDriversList, activeVehiclesList] =
    await Promise.all([
      prisma.weeklySchedule.findMany({
        where: { weekStart: weekStartDate, status: { not: "CANCELLED" } },
        include: {
          route: true,
          trip: { include: { vehicle: true } },
          employee: { select: { id: true, employeeCode: true } },
        },
      }),
      prisma.driver.findMany({
        where: { status: "AVAILABLE" },
        include: { vehicle: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.vehicle.findMany({ where: { status: "ACTIVE" } }),
    ]);

  caches.weekRoster = existingWeekRoster;
  caches.availableDrivers = availableDriversList;
  caches.activeVehicles = activeVehiclesList;
  for (const d of availableDriversList) {
    caches.driverById.set(d.id, d);
  }

  // Normalize the filter once, into a Set of employee codes we actually
  // care about, so the cache-population loop below can cheaply decide
  // whether an existing row belongs to the sheet we're about to process.
  const employeeCodeFilterSet =
    employeeCodeFilter && employeeCodeFilter.length
      ? new Set(employeeCodeFilter)
      : null;

  for (const s of existingWeekRoster) {
    caches.scheduleByEmployeeId.set(s.employeeId, s);
    if (s.driverId && s.tripId) {
      // When the caller asks to reset driver assignments from the sheet
      // (update-schedule runs), skip seeding tripIdByDriver / tripDriverMap
      // for employees that are going to be re-processed. Otherwise the
      // cached mapping wins over the sheet and employees stay on their OLD
      // driver's trip even when the sheet moved them to a different driver.
      const isInFilter =
        !employeeCodeFilterSet ||
        employeeCodeFilterSet.has(s.employee?.employeeCode);
      const skipForReset = resetDriversFromSheet && isInFilter;

      if (!skipForReset) {
        caches.tripIdByDriver.set(s.driverId, s.tripId);
      }
    }
    if (s.tripId) {
      const isInFilter =
        !employeeCodeFilterSet ||
        employeeCodeFilterSet.has(s.employee?.employeeCode);
      const skipForReset = resetDriversFromSheet && isInFilter;

      if (!skipForReset) {
        caches.tripOccupancy.set(
          s.tripId,
          (caches.tripOccupancy.get(s.tripId) || 0) + 1,
        );
        if (s.driverId) {
          caches.tripDriverMap.set(s.tripId, s.driverId);
        }
        if (s.routeId) {
          caches.tripRouteMap.set(s.tripId, s.routeId);
        }
      }
    }
  }

  console.log(`[weeklySchedule][job ${jobId}] Parsing sheets...`);

  const allEmployeeCodes = new Set();
  let allEmployeeData = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const headerRowIndex = rows.findIndex((r) =>
      r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
    );

    if (headerRowIndex === -1) {
      results.sheetsSkipped.push({
        sheet: sheetName,
        reason: "No 'Employee ID' header found.",
      });
      continue;
    }
    results.sheetsProcessed.push(sheetName);

    const colIndex = {};
    rows[headerRowIndex].forEach((cell, i) => {
      const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
      if (key) colIndex[key] = i;
    });

    const dataRows = rows.slice(headerRowIndex + 1);
    const empCodeCol = colIndex.employeeCode;

    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i];
      const code =
        empCodeCol !== undefined ? String(raw[empCodeCol] ?? "").trim() : "";
      if (code) {
        allEmployeeCodes.add(code);
        allEmployeeData.push({
          sheetName,
          raw,
          rowNum: headerRowIndex + i + 2,
          colIndex,
          employeeCode: code,
        });
      }
    }
  }

  if (employeeCodeFilter && employeeCodeFilter.length) {
    const beforeCount = allEmployeeData.length;
    const codeSet = new Set(employeeCodeFilter);
    console.log(
      `[bulkUpload.service] employeeCodeFilter active: ${employeeCodeFilter.length} employee codes supplied; before=${beforeCount}`,
    );
    allEmployeeData = allEmployeeData.filter((row) =>
      codeSet.has(row.employeeCode),
    );
    console.log(
      `[bulkUpload.service] employeeCodeFilter applied: rowsAfter=${allEmployeeData.length} matchedCodes=${Array.from(codeSet)}`,
    );
    allEmployeeCodes.clear();
    for (const row of allEmployeeData) allEmployeeCodes.add(row.employeeCode);
  }

  await updateJobProgress(jobId, {
    totalRows: allEmployeeData.length,
    totalBatches: batchSize ? Math.ceil(allEmployeeData.length / batchSize) : 0,
  });

  console.log(
    `[weeklySchedule][job ${jobId}] Loading ${allEmployeeCodes.size} employees...`,
  );
  if (allEmployeeCodes.size) {
    const existingEmployees = await prisma.employee.findMany({
      where: { employeeCode: { in: Array.from(allEmployeeCodes) } },
      include: { area: true, subArea: true, block: true },
    });
    for (const emp of existingEmployees) {
      caches.employee.set(emp.employeeCode, emp);
    }
  }

  const areaIds = new Set();
  for (const emp of caches.employee.values()) {
    if (emp.areaId) areaIds.add(emp.areaId);
  }

  const tripsByAreaShift = new Map();
  if (areaIds.size > 0) {
    console.log(
      `[weeklySchedule][job ${jobId}] Pre-fetching trips for ${areaIds.size} areas...`,
    );
    const trips = await prisma.trip.findMany({
      where: {
        route: { areaId: { in: Array.from(areaIds) } },
        status: "ACTIVE",
      },
      include: { route: { include: { area: true } }, vehicle: true },
    });

    for (const trip of trips) {
      const key = `${trip.route.areaId}::${normalizeShift(trip.shiftTiming)}`;
      if (!tripsByAreaShift.has(key)) tripsByAreaShift.set(key, []);
      tripsByAreaShift.get(key).push(trip);

      // When resetDriversFromSheet is on, do NOT seed occupancy/capacity
      // from pre-fetched trips either — those trips may be the very ones
      // the sheet is trying to move employees off of, and counting their
      // existing occupancy would prevent them from being reconsidered as
      // the target.
      if (!resetDriversFromSheet) {
        if (!caches.tripOccupancy.has(trip.id)) {
          caches.tripOccupancy.set(trip.id, 0);
        }
        caches.tripCapacity.set(trip.id, trip.vehicle?.capacity || 10);
        if (trip.driverId) {
          caches.tripDriverMap.set(trip.id, trip.driverId);
        }
        if (trip.routeId) {
          caches.tripRouteMap.set(trip.id, trip.routeId);
        }
      } else {
        // Still record capacity for newly-encountered trips so later
        // assignment math has something to work with.
        if (!caches.tripCapacity.has(trip.id)) {
          caches.tripCapacity.set(trip.id, trip.vehicle?.capacity || 10);
        }
      }
    }
  }

  console.log(
    `[weeklySchedule][job ${jobId}] Processing ${allEmployeeData.length} employees...`,
  );

  const processedEmployees = [];

  for (const {
    sheetName,
    raw,
    rowNum,
    colIndex,
    employeeCode,
  } of allEmployeeData) {
    const get = (key) =>
      colIndex[key] !== undefined
        ? String(raw[colIndex[key]] ?? "").trim()
        : "";

    try {
      const employee = await findEmployee(employeeCode, caches);
      if (!employee) {
        results.employeesNotFound++;
        await skipRow(
          sheetName,
          rowNum,
          employeeCode,
          `Employee code ${employeeCode} not found.`,
          raw,
        );
        continue;
      }

      const vendorName = get("vendor");
      const vehicleType = get("vehicleType");
      const existingSchedule = caches.scheduleByEmployeeId.get(employee.id);
      const shiftTiming =
        get("shiftTiming") ||
        existingSchedule?.shiftTiming ||
        employee.shiftTiming ||
        null;
      const driverEntries = parseDriverEntries(get("drivers"));
      const vendorRecord = vendorName
        ? await findVendor(vendorName, caches.vendor)
        : null;

      let driverId = null;
      let driverRecord = null;
      let vehicleId = null;

      for (let d = 0; d < driverEntries.length; d++) {
        const driver = await findDriver(
          driverEntries[d].name,
          vendorName,
          vehicleType,
          caches.driver,
          caches,
        );
        if (driver) {
          driverId = driver.id;
          driverRecord = driver;
          if (driver.vehicle) {
            vehicleId = driver.vehicle.id;
          } else {
            const newVehicle = await findOrCreateVehicleForDriver(
              driverId,
              vendorName || driver.vendor?.name || "MTS",
              vehicleType || "CAR",
              caches,
            );
            if (newVehicle) {
              vehicleId = newVehicle.id;
              results.vehiclesCreated = (results.vehiclesCreated || 0) + 1;
            }
          }
          break;
        }
      }

      // Blank driver in the sheet = keep the employee on whatever driver they
      // already have this week. Without this fallback, an update run whose
      // sheet omits the driver for one employee would silently move them onto
      // whichever trip the batch pipeline happened to find first (that's how
      // Dia ended up on Nadeem's trip). Falls through to no-driver only when
      // there genuinely is no existing schedule to preserve.
      if (!driverId) {
        if (existingSchedule?.driverId) {
          driverId = existingSchedule.driverId;
          vehicleId = vehicleId || existingSchedule.vehicleId || null;
          driverRecord =
            caches.driverById.get(existingSchedule.driverId) || null;
        }
      }

      const driverNamedButUnmatched = !driverId && driverEntries.length > 0;

      // ---------- AREA FIX: Use ONLY sheet area; no fallback to employee's master area ----------
      let areaRecord = null;
      const sheetAreaName = get("area");
      if (sheetAreaName) {
        areaRecord = await findOrCreateNormalizedArea(
          normalizeAreaName(sheetAreaName),
          caches,
        );
      }
      if (!areaRecord) {
        await skipRow(
          sheetName,
          rowNum,
          employeeCode,
          `Area "${sheetAreaName || "empty"}" not found or invalid in sheet`,
          raw,
        );
        continue;
      }
      // ---------- END AREA FIX ----------

      if (driverId && !vehicleId) {
        const vehicle = await findOrCreateVehicleForDriver(
          driverId,
          vendorName,
          vehicleType,
          caches,
        );
        if (vehicle) {
          vehicleId = vehicle.id;
        }
      }

      const officeArrivalTimeRaw = get("officeArrivalTime");
      const dropTimeRaw = get("dropTime");
      const serviceType =
        existingSchedule?.serviceType ||
        employee.serviceType ||
        deriveServiceType(officeArrivalTimeRaw, dropTimeRaw) ||
        "PICK_AND_DROP";
      const officeArrivalDate = parseSheetTimeToDate(officeArrivalTimeRaw);
      const dropDate = parseSheetTimeToDate(dropTimeRaw);
      const pickupDate = computePickupTime(officeArrivalDate);

      const offDaySet = parseOffDays(get("offDay"));
      const dayFields = {};
      DAY_KEYS.forEach((day) => {
        dayFields[day] = offDaySet.has(day) ? "OFF" : "BOTH";
      });

      const vehicleEntity = normalizeEntity(get("vehicleEntity"));
      const campaign = get("campaign") || get("batch");

      const resolvedVendorId =
        driverRecord?.vendorId ||
        driverRecord?.vendor?.id ||
        vendorRecord?.id ||
        null;

      const employeeData = {
        employee,
        employeeCode,
        driverId,
        vehicleId,
        driverRecord,
        vendorName,
        vehicleType,
        shiftTiming,
        areaRecord,
        campaign,
        serviceType,
        officeArrivalDate,
        dropDate,
        pickupDate,
        dayFields,
        vehicleEntity,
        sheetName,
        rowNum,
        raw,
        driverEntries,
        driverNamedButUnmatched,
        location: get("location"),
        assigned: false,
        assignedTrip: null,
        assignedRoute: null,
        scheduleData: {
          weekStart: weekStartDate,
          employeeId: employee.id,
          driverId,
          vendorId: resolvedVendorId,
          vehicleId,
          vehicleEntity: vehicleEntity || undefined,
          serviceType,
          shiftTiming: shiftTiming || undefined,
          pickupTime: pickupDate || undefined,
          officeArrivalTime: officeArrivalDate || undefined,
          dropTime: dropDate || undefined,
          offDay: get("offDay") || undefined,
          ...dayFields,
          status: "DRAFT",
        },
      };

      processedEmployees.push(employeeData);
    } catch (error) {
      console.error(`[Processing] Error row ${rowNum}:`, error);
      await skipRow(sheetName, rowNum, employeeCode, error.message, raw);
    }
  }

  // ---------- GROUPING FIX: group by area + shift + driverId ----------
  const employeeGroups = new Map();
  for (const emp of processedEmployees) {
    if (!emp.areaRecord) continue;
    const driverKey = emp.driverId || "no-driver";
    const key = `${emp.areaRecord.id}::${normalizeShift(emp.shiftTiming)}::${driverKey}`;
    if (!employeeGroups.has(key)) {
      employeeGroups.set(key, {
        areaRecord: emp.areaRecord,
        shiftTiming: emp.shiftTiming,
        driverId: emp.driverId,
        employees: [],
      });
    }
    employeeGroups.get(key).employees.push(emp);
  }

  console.log(
    `[weeklySchedule][job ${jobId}] Grouped ${processedEmployees.length} employees into ${employeeGroups.size} groups`,
  );
  // ---------- END GROUPING FIX ----------

  const sortByOccupancy = (trips) =>
    sortTripsByOccupancy(
      trips,
      (trip) => caches.tripOccupancy.get(trip.id) || 0,
    );

  for (const [key, group] of employeeGroups) {
    const { areaRecord, shiftTiming, employees, driverId } = group;
    const areaShiftKey = `${areaRecord.id}::${normalizeShift(shiftTiming)}`;

    // Get all trips for this area/shift
    const allTrips = tripsByAreaShift.get(areaShiftKey) || [];

    // Split trips into those with matching driver (if any) and others
    let matchingDriverTrips = [];
    let otherTrips = [];
    if (driverId) {
      matchingDriverTrips = allTrips.filter((t) => t.driverId === driverId);
      otherTrips = allTrips.filter((t) => t.driverId !== driverId);
    } else {
      // No driver specified; treat all trips as available
      otherTrips = allTrips;
    }

    let unassigned = [...employees];

    // ---------- PHASE 1: Assign to matching driver trips ----------
    if (matchingDriverTrips.length > 0) {
      const sortedMatching = sortByOccupancy(matchingDriverTrips);
      for (const trip of sortedMatching) {
        const capacity = caches.tripCapacity.get(trip.id) || 10;
        let occupancy = caches.tripOccupancy.get(trip.id) || 0;
        const availableSlots = capacity - occupancy;
        if (availableSlots <= 0) continue;

        const canAssign = [];
        for (const emp of unassigned) {
          if (emp.assigned) continue;
          canAssign.push(emp);
          if (canAssign.length >= availableSlots) break;
        }

        for (const emp of canAssign) {
          emp.assigned = true;
          emp.assignedTrip = trip;
          emp.assignedRoute = trip.route;
          emp.shiftTiming =
            emp.shiftTiming || trip.shiftTiming || trip.route?.shiftTiming || null;
          emp.scheduleData.shiftTiming = emp.shiftTiming || undefined;

          if (emp.driverId && trip.driverId && emp.driverId !== trip.driverId) {
            await prisma.trip.update({
              where: { id: trip.id },
              data: { driverId: emp.driverId },
            });
            trip.driverId = emp.driverId;
            if (caches) {
              caches.tripDriverMap?.set(trip.id, emp.driverId);
              caches.tripIdByDriver?.set(emp.driverId, trip.id);
            }
          }

          const assignment = await resolveConflictFreeAssignment({
            trip,
            weekStartDate,
            candidateShiftTiming: shiftTiming,
            proposedDriverId: emp.driverId,
            proposedVehicleId: emp.vehicleId,
            vehicleTypeHint: emp.vehicleType,
            excludeEmployeeId: emp.employee.id,
            caches,
            options: {
              trustProposedDriver: true,
              skipAutoAssignDriver: emp.driverNamedButUnmatched,
            },
          });

          if (assignment.autoAssignedDriver) {
            results.driversAutoAssigned =
              (results.driversAutoAssigned || 0) + 1;
          }
          if (assignment.autoAssignedVehicle) {
            results.vehiclesAutoAssigned =
              (results.vehiclesAutoAssigned || 0) + 1;
          }

          emp.driverId = assignment.driverId;
          emp.vehicleId = assignment.vehicleId;
          emp.scheduleData.routeId = trip.routeId;
          emp.scheduleData.tripId = trip.id;
          emp.scheduleData.driverId = emp.driverId;
          emp.scheduleData.vehicleId = emp.vehicleId;
          emp.scheduleData.status =
            emp.driverId && emp.vehicleId ? "ACTIVE" : "DRAFT";

          occupancy++;
          caches.tripOccupancy.set(trip.id, occupancy);
          results.tripsReused++;

          const existing =
            caches.scheduleByEmployeeId.get(emp.employee.id) || null;
          const existingHasId = Boolean(existing?.id);
          if (existingHasId) results.updated++;
          else results.created++;

          pendingWrites.push({
            employee: emp.employee,
            existing: existingHasId ? existing : null,
            scheduleData: emp.scheduleData,
            dayFields: emp.dayFields,
            route: trip.route,
            sheetName: emp.sheetName,
            rowNum: emp.rowNum,
            employeeCode: emp.employeeCode,
            raw: emp.raw,
            driverRaw: emp.driverEntries[0]?.name || null,
          });

          caches.scheduleByEmployeeId.set(emp.employee.id, {
            ...(existing || {}),
            ...emp.scheduleData,
            ...(existing?.id ? { id: existing.id } : {}),
          });

          const idx = unassigned.indexOf(emp);
          if (idx > -1) unassigned.splice(idx, 1);
        }
      }
    }

    // ---------- PHASE 2: Assign remaining (overflow) to any other trip ----------
    //
    // Only ever used when the employee has NO sheet-specified driver
    // (driverId === null). Employees whose sheet row explicitly names a
    // driver must NOT be merged onto a different driver's trip — if their
    // driver has no trip yet, Phase 3 creates one. This is the guard that
    // stops an update-run from collapsing two drivers' passengers onto one
    // vehicle.
    if (unassigned.length > 0 && otherTrips.length > 0 && !driverId) {
      const sortedOther = sortByOccupancy(otherTrips);
      for (const trip of sortedOther) {
        const capacity = caches.tripCapacity.get(trip.id) || 10;
        let occupancy = caches.tripOccupancy.get(trip.id) || 0;
        const availableSlots = capacity - occupancy;
        if (availableSlots <= 0) continue;

        const canAssign = [];
        for (const emp of unassigned) {
          if (emp.assigned) continue;
          canAssign.push(emp);
          if (canAssign.length >= availableSlots) break;
        }

        for (const emp of canAssign) {
          emp.assigned = true;
          emp.assignedTrip = trip;
          emp.assignedRoute = trip.route;
          emp.shiftTiming =
            emp.shiftTiming || trip.shiftTiming || trip.route?.shiftTiming || null;
          emp.scheduleData.shiftTiming = emp.shiftTiming || undefined;

          // Override driver if sheet specifies one
          if (emp.driverId && trip.driverId && emp.driverId !== trip.driverId) {
            await prisma.trip.update({
              where: { id: trip.id },
              data: { driverId: emp.driverId },
            });
            trip.driverId = emp.driverId;
            if (caches) {
              caches.tripDriverMap?.set(trip.id, emp.driverId);
              caches.tripIdByDriver?.set(emp.driverId, trip.id);
            }
          }

          const assignment = await resolveConflictFreeAssignment({
            trip,
            weekStartDate,
            candidateShiftTiming: shiftTiming,
            proposedDriverId: emp.driverId,
            proposedVehicleId: emp.vehicleId,
            vehicleTypeHint: emp.vehicleType,
            excludeEmployeeId: emp.employee.id,
            caches,
            options: {
              trustProposedDriver: true,
              skipAutoAssignDriver: emp.driverNamedButUnmatched,
            },
          });

          if (assignment.autoAssignedDriver) {
            results.driversAutoAssigned =
              (results.driversAutoAssigned || 0) + 1;
          }
          if (assignment.autoAssignedVehicle) {
            results.vehiclesAutoAssigned =
              (results.vehiclesAutoAssigned || 0) + 1;
          }

          emp.driverId = assignment.driverId;
          emp.vehicleId = assignment.vehicleId;
          emp.scheduleData.routeId = trip.routeId;
          emp.scheduleData.tripId = trip.id;
          emp.scheduleData.driverId = emp.driverId;
          emp.scheduleData.vehicleId = emp.vehicleId;
          emp.scheduleData.status =
            emp.driverId && emp.vehicleId ? "ACTIVE" : "DRAFT";

          occupancy++;
          caches.tripOccupancy.set(trip.id, occupancy);
          results.tripsReused++;

          const existing =
            caches.scheduleByEmployeeId.get(emp.employee.id) || null;
          const existingHasId = Boolean(existing?.id);
          if (existingHasId) results.updated++;
          else results.created++;

          pendingWrites.push({
            employee: emp.employee,
            existing: existingHasId ? existing : null,
            scheduleData: emp.scheduleData,
            dayFields: emp.dayFields,
            route: trip.route,
            sheetName: emp.sheetName,
            rowNum: emp.rowNum,
            employeeCode: emp.employeeCode,
            raw: emp.raw,
            driverRaw: emp.driverEntries[0]?.name || null,
          });

          caches.scheduleByEmployeeId.set(emp.employee.id, {
            ...(existing || {}),
            ...emp.scheduleData,
            ...(existing?.id ? { id: existing.id } : {}),
          });

          const idx = unassigned.indexOf(emp);
          if (idx > -1) unassigned.splice(idx, 1);
        }
      }
    }

    // ---------- PHASE 3: Create new trips for leftovers ----------
    const remainingEmployees = unassigned.filter((e) => !e.assigned);
    while (remainingEmployees.length > 0) {
      const firstEmp = remainingEmployees[0];

      const routeResult = await findOrCreateRouteAndTrip(
        areaRecord,
        firstEmp.vehicleType,
        shiftTiming,
        firstEmp.campaign,
        firstEmp.driverId,
        firstEmp.vehicleId,
        weekStartDate,
        firstEmp.employee.id,
        caches,
        {
          disableMultiTrip: false,
          trustProposedDriver: true,
          allowCreate: true,
        },
        firstEmp.vendorName,
        firstEmp.location,
        firstEmp.vehicleEntity,
        // Forward what the sheet actually gave us for this row so a newly
        // created route isn't left with officeLocation/serviceType/timing
        // all null. Falls back to the employee's own subArea if the sheet
        // didn't have a subArea column.
        firstEmp.employee.subAreaId,
        firstEmp.serviceType,
        firstEmp.pickupDate,
        firstEmp.officeArrivalDate,
        firstEmp.dropDate,
      );

      const trip = routeResult.trip;
      if (!trip) {
        await skipRow(
          firstEmp.sheetName,
          firstEmp.rowNum,
          firstEmp.employeeCode,
          "Failed to create new trip",
          firstEmp.raw,
        );
        remainingEmployees.shift();
        continue;
      }

      // Override trip driver if sheet specified one
      if (
        firstEmp.driverId &&
        trip.driverId &&
        firstEmp.driverId !== trip.driverId
      ) {
        await prisma.trip.update({
          where: { id: trip.id },
          data: { driverId: firstEmp.driverId },
        });
        trip.driverId = firstEmp.driverId;
        if (caches) {
          caches.tripDriverMap?.set(trip.id, firstEmp.driverId);
          caches.tripIdByDriver?.set(firstEmp.driverId, trip.id);
        }
      }

      results.tripsCreated++;
      const capacity = caches.tripCapacity.get(trip.id) || 10;
      let assignedCount = 0;

      const toAssign = [];
      for (
        let i = 0;
        i < remainingEmployees.length && assignedCount < capacity;
        i++
      ) {
        const emp = remainingEmployees[i];
        // For new trips, we can assign anyone (they share same area/shift)
        toAssign.push(emp);
        assignedCount++;
      }

      for (const emp of toAssign) {
        emp.shiftTiming =
          emp.shiftTiming || trip.shiftTiming || trip.route?.shiftTiming || null;
        emp.scheduleData.shiftTiming = emp.shiftTiming || undefined;
        if (emp.driverId && trip.driverId && emp.driverId !== trip.driverId) {
          await prisma.trip.update({
            where: { id: trip.id },
            data: { driverId: emp.driverId },
          });
          trip.driverId = emp.driverId;
          if (caches) {
            caches.tripDriverMap?.set(trip.id, emp.driverId);
            caches.tripIdByDriver?.set(emp.driverId, trip.id);
          }
        }

        const assignment = await resolveConflictFreeAssignment({
          trip,
          weekStartDate,
          candidateShiftTiming: shiftTiming,
          proposedDriverId: emp.driverId,
          proposedVehicleId: emp.vehicleId,
          vehicleTypeHint: emp.vehicleType,
          excludeEmployeeId: emp.employee.id,
          caches,
          options: {
            trustProposedDriver: true,
            skipAutoAssignDriver: emp.driverNamedButUnmatched,
          },
        });

        if (assignment.autoAssignedDriver) {
          results.driversAutoAssigned = (results.driversAutoAssigned || 0) + 1;
        }
        if (assignment.autoAssignedVehicle) {
          results.vehiclesAutoAssigned =
            (results.vehiclesAutoAssigned || 0) + 1;
        }

        emp.driverId = assignment.driverId;
        emp.vehicleId = assignment.vehicleId;
        emp.scheduleData.routeId = trip.routeId;
        emp.scheduleData.tripId = trip.id;
        emp.scheduleData.driverId = emp.driverId;
        emp.scheduleData.vehicleId = emp.vehicleId;
        emp.scheduleData.status =
          emp.driverId && emp.vehicleId ? "ACTIVE" : "DRAFT";

        emp.assigned = true;
        results.employeesReassigned++;

        caches.tripOccupancy.set(trip.id, assignedCount);

        const existing =
          caches.scheduleByEmployeeId.get(emp.employee.id) || null;
        const existingHasId = Boolean(existing?.id);
        if (existingHasId) results.updated++;
        else results.created++;

        pendingWrites.push({
          employee: emp.employee,
          existing: existingHasId ? existing : null,
          scheduleData: emp.scheduleData,
          dayFields: emp.dayFields,
          route: trip.route,
          sheetName: emp.sheetName,
          rowNum: emp.rowNum,
          employeeCode: emp.employeeCode,
          raw: emp.raw,
          driverRaw: emp.driverEntries[0]?.name || null,
        });

        caches.scheduleByEmployeeId.set(emp.employee.id, {
          ...(existing || {}),
          ...emp.scheduleData,
          ...(existing?.id ? { id: existing.id } : {}),
        });

        const idx = remainingEmployees.indexOf(emp);
        if (idx > -1) remainingEmployees.splice(idx, 1);
      }
    }

    if (pendingWrites.length >= 25) {
      await flushPendingWrites();
    }
  }

  console.log(
    `[weeklySchedule][job ${jobId}] Flushing ${pendingWrites.length} pending writes...`,
  );
  await flushPendingWrites();
  console.log(`[weeklySchedule][job ${jobId}] Final flush complete.`);

  let totalCapacity = 0;
  let totalUsed = 0;
  for (const [tripId, occupancy] of caches.tripOccupancy) {
    const capacity = caches.tripCapacity.get(tripId) || 0;
    totalCapacity += capacity;
    totalUsed += occupancy;
  }
  results.totalCapacityUsed = totalUsed;
  results.totalCapacityAvailable = totalCapacity;

  console.log(
    `[weeklySchedule][job ${jobId}] COMPLETE. ` +
      `Created: ${results.created}, Updated: ${results.updated}, ` +
      `Trips Created: ${results.tripsCreated}, Trips Reused: ${results.tripsReused}, ` +
      `Capacity: ${totalUsed}/${totalCapacity} filled (${totalCapacity > 0 ? Math.round((totalUsed / totalCapacity) * 100) : 0}%)`,
  );

  return results;
};

module.exports = {
  processBulkUploadJob,
  processUpdateScheduleJob,
};
