// ---------- Bulk upload (background job) ----------

const XLSX = require("xlsx");
const { prisma } = require("../lib/prisma");
const { DAY_KEYS, computePickupTime, parseSheetTimeToDate } = require("../utils/dateTimeHelpers");
const { HEADER_ALIASES, parseOffDays, deriveServiceType, normalizeEntity, normalizeAreaName, parseDriverEntries } = require("../utils/xlsxParsing");
const { findOrCreateNormalizedArea } = require("./areaLookup.service");
const { findDriver, findEmployee } = require("./driverVehicleMatch.service");
const { resolveConflictFreeAssignment, findOrCreateVehicleForDriver } = require("./autoAssignment.service");
const { findOrCreateRouteAndTrip } = require("./routeTrip.service");
const { normalizeShift } = require("../utils/shiftTime");

const bulkUploadJobs = new Map();
const BULK_UPLOAD_JOB_TTL_MS = 30 * 60 * 1000;

const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 100;

const createBulkUploadJob = (totalRows, batchSize, weekStartDate) => {
  const cutoff = Date.now() - BULK_UPLOAD_JOB_TTL_MS;
  for (const [id, job] of bulkUploadJobs) {
    if (job.status !== "processing" && job.startedAt < cutoff) {
      bulkUploadJobs.delete(id);
    }
  }

  const weekKey = weekStartDate.toISOString();
  const conflicting = Array.from(bulkUploadJobs.values()).find(
    (job) => job.status === "processing" && job.weekKey === weekKey,
  );
  if (conflicting) {
    return { conflict: true, existingJobId: conflicting.jobId };
  }

  const jobId = `bulkupload_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  bulkUploadJobs.set(jobId, {
    jobId,
    weekKey,
    status: "processing",
    totalRows,
    processedRows: 0,
    batchSize,
    totalBatches: totalRows ? Math.ceil(totalRows / batchSize) : 0,
    batchesCompleted: 0,
    startedAt: Date.now(),
    partialResult: null,
    result: null,
    error: null,
  });
  return { conflict: false, jobId };
};


const updateBulkUploadJob = (jobId, patch) => {
  const job = bulkUploadJobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
};


const processBulkUploadJob = async (
  jobId,
  workbook,
  weekStartDate,
  batchSize = 100,
) => {
  console.log(
    `[weeklySchedule][job ${jobId}] START weekStart=${weekStartDate} batchSize=${batchSize}`,
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
        include: { route: true, trip: { include: { vehicle: true } } },
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
  for (const s of existingWeekRoster) {
    caches.scheduleByEmployeeId.set(s.employeeId, s);
    if (s.driverId && s.tripId) {
      caches.tripIdByDriver.set(s.driverId, s.tripId);
    }
    if (s.tripId) {
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

  console.log(`[weeklySchedule][job ${jobId}] Parsing sheets...`);

  const allEmployeeCodes = new Set();
  const allEmployeeData = [];

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
      if (code && /^\d+$/.test(code)) {
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
      const shiftTiming = get("shiftTiming");
      const driverEntries = parseDriverEntries(get("drivers"));

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
      const serviceType = deriveServiceType(officeArrivalTimeRaw, dropTimeRaw);
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
          vendorId: null,
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

  // Helper to sort trips by occupancy (highest first)
  const sortByOccupancy = (trips) => {
    return [...trips].sort((a, b) => {
      const aOcc = caches.tripOccupancy.get(a.id) || 0;
      const bOcc = caches.tripOccupancy.get(b.id) || 0;
      return bOcc - aOcc;
    });
  };

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
    if (unassigned.length > 0 && otherTrips.length > 0) {
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
  bulkUploadJobs,
  BULK_UPLOAD_JOB_TTL_MS,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
  createBulkUploadJob,
  updateBulkUploadJob,
  processBulkUploadJob,
};