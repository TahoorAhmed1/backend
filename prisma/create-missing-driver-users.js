require("dotenv/config");

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { hashPassword } = require("../services/auth.service");
const QRCode = require("qrcode");

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

// ==================================================
// CONFIG
// ==================================================

const DATA_PATH = path.join(
  __dirname,
  "driver-data.json"
);

const DRIVER_EMAIL_DOMAIN = "ibex.com";
const DEFAULT_DRIVER_PASSWORD = "12345678";

const QR_DIR = path.join(
  __dirname,
  "..",
  "qrcodes",
  "drivers"
);

// ==================================================
// HELPERS
// ==================================================

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeLicense(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getSeedId(driver) {
  return driver?.seedId
    ? String(driver.seedId).trim()
    : null;
}

function safeEmailLocalPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}

function safeFileName(name) {
  return String(name || "driver")
    .replace(/\s+/g, "")
    .replace(/[\\/:*?"<>|]/g, "");
}

// ==================================================
// MAIN
// ==================================================

async function main() {
  console.log("\n");
  console.log("==============================================");
  console.log("      DRIVER USER + QR SYNC STARTED");
  console.log("==============================================");
  console.log("\n");

  // ==================================================
  // 1. LOAD JSON
  // ==================================================

  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(
      `driver-data.json not found:\n${DATA_PATH}`
    );
  }

  const jsonData = JSON.parse(
    fs.readFileSync(DATA_PATH, "utf8")
  );

  const {
    vendors = [],
    drivers = [],
    vehicles = [],
  } = jsonData;

  console.log(
    `JSON drivers found: ${drivers.length}`
  );

  console.log(
    `JSON vendors found: ${vendors.length}`
  );

  console.log(
    `JSON vehicles found: ${vehicles.length}`
  );

  // ==================================================
  // 2. CLEAN JSON DRIVER DATA
  // ==================================================

  console.log("\n");
  console.log("==============================================");
  console.log("      CLEANING DRIVER DATA FROM JSON");
  console.log("==============================================");
  console.log("\n");

  const uniqueDrivers = [];

  const seenLicenses = new Map();
  const seenSeedIds = new Map();

  let duplicateJsonSkipped = 0;
  let noLicenseSkipped = 0;
  let duplicateSeedIdSkipped = 0;

  for (const driver of drivers) {
    const license = normalizeLicense(
      driver.licenseNumber
    );

    const seedId = normalize(
      driver.seedId
    );

    // ==================================================
    // NO LICENSE = NO DRIVER
    // ==================================================

    if (!license) {
      noLicenseSkipped++;

      console.log(
        `SKIPPED - NO LICENSE: ${driver.name || "Unknown"} (${driver.seedId || "No seedId"})`
      );

      continue;
    }

    // ==================================================
    // DUPLICATE LICENSE
    // ==================================================

    if (seenLicenses.has(license)) {
      const existing =
        seenLicenses.get(license);

      duplicateJsonSkipped++;

      console.log("\nDUPLICATE LICENSE FOUND");
      console.log("----------------------------------------------");

      console.log(
        `Name       : ${driver.name}`
      );

      console.log(
        `License    : ${driver.licenseNumber}`
      );

      console.log(
        `Skipped ID : ${driver.seedId || "N/A"}`
      );

      console.log(
        `Keeping    : ${existing.name}`
      );

      console.log(
        `Keeping ID : ${existing.seedId || "N/A"}`
      );

      console.log("----------------------------------------------");

      continue;
    }

    // ==================================================
    // DUPLICATE SEED ID
    // ==================================================

    if (
      seedId &&
      seenSeedIds.has(seedId)
    ) {
      const existing =
        seenSeedIds.get(seedId);

      duplicateSeedIdSkipped++;

      console.log("\nDUPLICATE SEED ID FOUND");
      console.log("----------------------------------------------");

      console.log(
        `Seed ID : ${driver.seedId}`
      );

      console.log(
        `Skipped : ${driver.name}`
      );

      console.log(
        `Keeping : ${existing.name}`
      );

      console.log("----------------------------------------------");

      continue;
    }

    // ==================================================
    // KEEP FIRST DRIVER
    // ==================================================

    seenLicenses.set(
      license,
      driver
    );

    if (seedId) {
      seenSeedIds.set(
        seedId,
        driver
      );
    }

    uniqueDrivers.push(driver);
  }

  console.log("\n");
  console.log("JSON CLEANUP COMPLETE");
  console.log("----------------------------------------------");

  console.log(
    `Original drivers        : ${drivers.length}`
  );

  console.log(
    `Valid unique drivers    : ${uniqueDrivers.length}`
  );

  console.log(
    `No-license skipped      : ${noLicenseSkipped}`
  );

  console.log(
    `Duplicate license skip  : ${duplicateJsonSkipped}`
  );

  console.log(
    `Duplicate seedId skip   : ${duplicateSeedIdSkipped}`
  );

  console.log("----------------------------------------------");

  // ==================================================
  // 3. MAKE QR DIRECTORY
  // ==================================================

  fs.mkdirSync(
    QR_DIR,
    {
      recursive: true,
    }
  );

  // ==================================================
  // 4. DELETE EXISTING DB DRIVERS WITHOUT LICENSE
  // ==================================================

  console.log("\n");
  console.log("==============================================");
  console.log("      CHECKING DATABASE LICENSES");
  console.log("==============================================");
  console.log("\n");

  const driversWithoutLicense =
    await prisma.driver.findMany({
      where: {
        OR: [
          {
            licenseNumber: null,
          },
          {
            licenseNumber: "",
          },
        ],
      },
      select: {
        id: true,
        name: true,
        licenseNumber: true,
        userId: true,
      },
    });

  console.log(
    `DB drivers without license: ${driversWithoutLicense.length}`
  );

  let driversDeleted = 0;
  let driverDeleteFailed = 0;

  for (
    const driver of driversWithoutLicense
  ) {
    try {
      // ----------------------------------------------
      // Delete linked user
      // ----------------------------------------------

      if (driver.userId) {
        try {
          await prisma.user.delete({
            where: {
              id: driver.userId,
            },
          });

          console.log(
            `Deleted User: ${driver.userId}`
          );
        } catch (error) {
          if (error.code !== "P2025") {
            throw error;
          }
        }
      }

      // ----------------------------------------------
      // Delete driver
      // ----------------------------------------------

      await prisma.driver.delete({
        where: {
          id: driver.id,
        },
      });

      driversDeleted++;

      console.log(
        `DELETED DRIVER WITHOUT LICENSE: ${driver.name} (${driver.id})`
      );
    } catch (error) {
      driverDeleteFailed++;

      console.error(
        `FAILED TO DELETE DRIVER: ${driver.name} (${driver.id})`
      );

      console.error(
        error.message
      );
    }
  }

  // ==================================================
  // 5. REMOVE DUPLICATE DRIVERS FROM DATABASE
  // SAME LICENSE = SAME DRIVER
  // ==================================================

  console.log("\n");
  console.log("==============================================");
  console.log("      CHECKING DATABASE DUPLICATES");
  console.log("==============================================");
  console.log("\n");

  const allDbDrivers =
    await prisma.driver.findMany({
      orderBy: {
        createdAt: "asc",
      },
      select: {
        id: true,
        name: true,
        licenseNumber: true,
        userId: true,
        createdAt: true,
      },
    });

  const seenDbLicenses = new Map();

  let duplicateDriversDeleted = 0;
  let duplicateDriverDeleteFailed = 0;

  for (
    const driver of allDbDrivers
  ) {
    const license =
      normalizeLicense(
        driver.licenseNumber
      );

    // No license should already have
    // been deleted above.
    if (!license) {
      continue;
    }

    if (
      !seenDbLicenses.has(license)
    ) {
      seenDbLicenses.set(
        license,
        driver
      );

      continue;
    }

    const originalDriver =
      seenDbLicenses.get(
        license
      );

    console.log("\nDATABASE DUPLICATE FOUND");
    console.log("----------------------------------------------");

    console.log(
      `Name       : ${driver.name}`
    );

    console.log(
      `License    : ${driver.licenseNumber}`
    );

    console.log(
      `Keeping ID : ${originalDriver.id}`
    );

    console.log(
      `Deleting ID: ${driver.id}`
    );

    console.log("----------------------------------------------");

    try {
      // ----------------------------------------------
      // Delete duplicate user's login
      // ----------------------------------------------

      if (driver.userId) {
        try {
          await prisma.user.delete({
            where: {
              id: driver.userId,
            },
          });

          console.log(
            `Deleted duplicate User: ${driver.userId}`
          );
        } catch (error) {
          if (error.code !== "P2025") {
            throw error;
          }
        }
      }

      // ----------------------------------------------
      // Delete duplicate driver
      // ----------------------------------------------

      await prisma.driver.delete({
        where: {
          id: driver.id,
        },
      });

      duplicateDriversDeleted++;

      console.log(
        `Deleted duplicate Driver: ${driver.id}`
      );
    } catch (error) {
      duplicateDriverDeleteFailed++;

      console.error(
        `FAILED TO DELETE DUPLICATE: ${driver.id}`
      );

      console.error(
        error.message
      );
    }
  }

  // ==================================================
  // 6. FETCH CURRENT DATABASE DRIVERS
  // ==================================================

  console.log("\n");
  console.log("Fetching current database drivers...\n");

  const currentDbDrivers =
    await prisma.driver.findMany({
      include: {
        user: true,
      },
    });

  console.log(
    `Current DB drivers: ${currentDbDrivers.length}`
  );

  // ==================================================
  // 7. CREATE MAP BY LICENSE
  // ==================================================

  const dbDriverByLicense =
    new Map();

  for (
    const driver of currentDbDrivers
  ) {
    const license =
      normalizeLicense(
        driver.licenseNumber
      );

    if (!license) {
      continue;
    }

    if (
      !dbDriverByLicense.has(
        license
      )
    ) {
      dbDriverByLicense.set(
        license,
        driver
      );
    }
  }

  // ==================================================
  // 8. HASH PASSWORD ONCE
  // ==================================================

  console.log(
    "\nCreating password hash..."
  );

  const passwordHash =
    await hashPassword(
      DEFAULT_DRIVER_PASSWORD
    );

  // ==================================================
  // 9. COUNTERS
  // ==================================================

  let driversCreated = 0;
  let driversUpdated = 0;
  let driversSkipped = 0;

  let usersCreated = 0;
  let usersLinked = 0;
  let usersAlreadyExist = 0;
  let usersEmailMigrated = 0;
  let usersEmailMigrationSkipped = 0;
  let usersEmailMigrationFailed = 0;

  // Populated below as each driver is created/verified, so the vehicle
  // -> driver assignment step (10.5) can resolve `primaryDriverSeedId`
  // without a second DB round trip. seedId itself isn't a column on
  // Driver (see schema.prisma) — it only exists in the JSON — so this
  // map is the only bridge between the two.
  const driverIdBySeedId = new Map();

  let qrTokensCreated = 0;
  let qrImagesCreated = 0;
  let qrImagesSkipped = 0;

  let failed = 0;

  // ==================================================
  // 10. PROCESS ONLY CLEAN UNIQUE DRIVERS
  // ==================================================

  console.log("\n");
  console.log("==============================================");
  console.log("      PROCESSING VALID DRIVERS");
  console.log("==============================================");

  for (
    const sourceDriver of uniqueDrivers
  ) {
    try {
      const license =
        normalizeLicense(
          sourceDriver.licenseNumber
        );

      // Extra safety
      // Never create driver without license.
      if (!license) {
        driversSkipped++;

        console.log(
          `SKIPPED WITHOUT LICENSE: ${sourceDriver.name}`
        );

        continue;
      }

      const sourceName =
        sourceDriver.name?.trim();

      const seedId =
        getSeedId(
          sourceDriver
        );

      console.log("\n----------------------------------------------");
      console.log(
        `Processing: ${sourceName}`
      );
      console.log(
        `License   : ${sourceDriver.licenseNumber}`
      );
      console.log(
        `Seed ID   : ${seedId || "N/A"}`
      );
      console.log("----------------------------------------------");

      // ==================================================
      // FIND EXISTING DRIVER BY LICENSE
      // ==================================================

      let driver =
        dbDriverByLicense.get(
          license
        );

      // ==================================================
      // CREATE DRIVER
      // ==================================================

      if (!driver) {
        driver =
          await prisma.driver.create({
            data: {
              name: sourceDriver.name,
              phone:
                sourceDriver.phone ||
                undefined,
              cnic:
                sourceDriver.cnic ||
                undefined,
              licenseNumber:
                sourceDriver.licenseNumber,
              status:
                sourceDriver.status ||
                "AVAILABLE",
              notes:
                sourceDriver.notes ||
                undefined,
            },
            include: {
              user: true,
            },
          });

        driversCreated++;

        console.log(
          `CREATED DRIVER: ${driver.id}`
        );

        dbDriverByLicense.set(
          license,
          driver
        );
      } else {
        // ==================================================
        // UPDATE EXISTING DRIVER
        // ==================================================

        driver =
          await prisma.driver.update({
            where: {
              id: driver.id,
            },
            data: {
              name:
                sourceDriver.name,
              phone:
                sourceDriver.phone ||
                undefined,
              cnic:
                sourceDriver.cnic ||
                undefined,
              licenseNumber:
                sourceDriver.licenseNumber,
              status:
                sourceDriver.status ||
                "AVAILABLE",
              notes:
                sourceDriver.notes ||
                undefined,
            },
            include: {
              user: true,
            },
          });

        driversUpdated++;

        console.log(
          `EXISTING DRIVER VERIFIED: ${driver.id}`
        );
      }

      // ==================================================
      // RECORD SEED ID -> DRIVER ID
      // ==================================================
      // Needed by the vehicle-assignment step below (10.5), since seedId
      // only exists in the JSON, never in the Driver table itself.

      if (seedId) {
        driverIdBySeedId.set(normalize(seedId), driver.id);
      }

      // ==================================================
      // CREATE / LINK USER
      // ==================================================

      let user =
        driver.user;

      /*
       * IMPORTANT:
       *
       * Email is based on SEED ID when available.
       *
       * Example:
       *
       * DRV-001@ibex.com
       *
       * seedId is already de-duplicated earlier in this
       * script (see "DUPLICATE SEED ID" check), so this is
       * safe from collisions. If a driver has no seedId,
       * we fall back to the DATABASE DRIVER ID so every
       * driver still gets a guaranteed-unique email.
       */

      const emailLocalPart =
        safeEmailLocalPart(seedId) ||
        driver.id;

      const email =
        `${emailLocalPart}@${DRIVER_EMAIL_DOMAIN}`;

      // ----------------------------------------------
      // DRIVER HAS NO USER
      // ----------------------------------------------

      if (!user) {
        const existingUser =
          await prisma.user.findUnique({
            where: {
              email,
            },
          });

        if (existingUser) {
          // ------------------------------------------
          // Link existing user
          // ------------------------------------------

          user =
            await prisma.user.update({
              where: {
                id: existingUser.id,
              },
              data: {
                name:
                  driver.name,
                role: "DRIVER",
              },
            });

          await prisma.driver.update({
            where: {
              id: driver.id,
            },
            data: {
              userId: user.id,
            },
          });

          usersLinked++;

          console.log(
            `LINKED EXISTING USER: ${user.email}`
          );
          console.log(
            `PASSWORD             : (unchanged, not reset by this script)`
          );
        } else {
          // ------------------------------------------
          // Create new user
          // ------------------------------------------

          user =
            await prisma.user.create({
              data: {
                email,
                name:
                  driver.name,
                passwordHash,
                role: "DRIVER",
              },
            });

          await prisma.driver.update({
            where: {
              id: driver.id,
            },
            data: {
              userId: user.id,
            },
          });

          usersCreated++;

          console.log(
            `CREATED LOGIN: ${user.email}`
          );
          console.log(
            `PASSWORD      : ${DEFAULT_DRIVER_PASSWORD}`
          );
        }
      } else {
        usersAlreadyExist++;

        console.log(
          `LOGIN ALREADY EXISTS: ${user.email}`
        );
        console.log(
          `PASSWORD             : (unchanged, not reset by this script)`
        );

        // ------------------------------------------
        // Migrate email to seedId-based address
        // if it doesn't match already (e.g. old
        // driver-id-based emails).
        // ------------------------------------------

        if (user.email !== email) {
          const emailTaken =
            await prisma.user.findUnique({
              where: {
                email,
              },
            });

          if (
            emailTaken &&
            emailTaken.id !== user.id
          ) {
            usersEmailMigrationSkipped++;

            console.log(
              `EMAIL MIGRATION SKIPPED (already in use by ${emailTaken.id}): ${email}`
            );
          } else {
            try {
              user =
                await prisma.user.update({
                  where: {
                    id: user.id,
                  },
                  data: {
                    email,
                  },
                });

              usersEmailMigrated++;

              console.log(
                `EMAIL UPDATED: ${email}`
              );
            } catch (error) {
              usersEmailMigrationFailed++;

              console.error(
                `FAILED TO UPDATE EMAIL: ${email}`
              );

              console.error(
                error.message
              );
            }
          }
        }

        // Make sure role is DRIVER
        if (
          user.role !== "DRIVER"
        ) {
          user =
            await prisma.user.update({
              where: {
                id: user.id,
              },
              data: {
                role: "DRIVER",
              },
            });

          console.log(
            `UPDATED USER ROLE TO DRIVER: ${user.email}`
          );
        }
      }

      // ==================================================
      // QR TOKEN
      // ==================================================

      if (!user.qrCode) {
        const qrToken =
          crypto.randomUUID();

        user =
          await prisma.user.update({
            where: {
              id: user.id,
            },
            data: {
              qrCode: qrToken,
            },
          });

        qrTokensCreated++;

        console.log(
          "CREATED QR TOKEN"
        );
      } else {
        console.log(
          "QR TOKEN ALREADY EXISTS"
        );
      }

      // ==================================================
      // QR IMAGE
      // ==================================================

      const qrFileName =
        `driver-${driver.id}.png`;

      const qrPath =
        path.join(
          QR_DIR,
          qrFileName
        );

      if (
        !fs.existsSync(qrPath)
      ) {
        await QRCode.toFile(
          qrPath,
          user.qrCode,
          {
            width: 400,
            margin: 2,
            errorCorrectionLevel: "M",
          }
        );

        qrImagesCreated++;

        console.log(
          `CREATED QR IMAGE: ${qrFileName}`
        );
      } else {
        qrImagesSkipped++;

        console.log(
          `QR IMAGE EXISTS: ${qrFileName}`
        );
      }
    } catch (error) {
      failed++;

      console.error("\nFAILED DRIVER");
      console.error(
        `Name    : ${sourceDriver.name}`
      );
      console.error(
        `License : ${sourceDriver.licenseNumber}`
      );
      console.error(
        `Seed ID : ${sourceDriver.seedId}`
      );

      console.error(
        error.message
      );
    }
  }

  // ==================================================
  // 10.5 ASSIGN VEHICLES TO DRIVERS (BY SEED ID)
  // ==================================================

  console.log("\n");
  console.log("==============================================");
  console.log("      ASSIGNING VEHICLES TO DRIVERS");
  console.log("==============================================");

  let vehiclesCreated = 0;
  let vehiclesUpdated = 0;
  let vehiclesSkippedNoNumber = 0;
  let vehiclesSkippedMissingFields = 0;
  let vehiclesSkippedNoDriverMatch = 0;
  let vehicleAssignmentConflicts = 0;
  let vehicleReassignedFromOtherVehicle = 0;
  let vehicleVendorNotFound = 0;
  let vehiclesFailed = 0;

  // Vehicle.driverId is @unique in the schema — one vehicle per driver,
  // max. If two vehicles in the JSON both claim the same
  // primaryDriverSeedId, only the FIRST one gets the driver; later ones
  // are saved with no driver assigned instead of crashing the whole run
  // on a Prisma unique-constraint error.
  const seedIdsClaimedThisRun = new Set();

  for (const sourceVehicle of vehicles) {
    const vehicleNumber = String(
      sourceVehicle.vehicleNumber || ""
    ).trim();

    if (!vehicleNumber) {
      vehiclesSkippedNoNumber++;
      console.log(
        `\nSKIPPED VEHICLE - NO vehicleNumber: ${JSON.stringify(sourceVehicle)}`
      );
      continue;
    }

    console.log("\n----------------------------------------------");
    console.log(`Processing Vehicle: ${vehicleNumber}`);
    console.log(
      `Driver Seed ID    : ${sourceVehicle.primaryDriverSeedId || "N/A"}`
    );
    console.log("----------------------------------------------");

    const primarySeedId = sourceVehicle.primaryDriverSeedId
      ? normalize(sourceVehicle.primaryDriverSeedId)
      : null;

    let driverId = null;

    if (primarySeedId) {
      driverId = driverIdBySeedId.get(primarySeedId) || null;

      if (!driverId) {
        vehiclesSkippedNoDriverMatch++;

        console.log(
          `NO DRIVER MATCH for seedId "${sourceVehicle.primaryDriverSeedId}" — vehicle will be saved WITHOUT a driver.`
        );
      } else if (seedIdsClaimedThisRun.has(primarySeedId)) {
        // Same driver already claimed by an earlier vehicle in this
        // same file — Vehicle.driverId can't point two vehicles at one
        // driver, so this one is left unassigned rather than failing.
        vehicleAssignmentConflicts++;

        console.log(
          `CONFLICT: seedId "${sourceVehicle.primaryDriverSeedId}" is already assigned to another vehicle earlier in this file — leaving this vehicle's driver unassigned.`
        );

        driverId = null;
      }
    }

    // NOTE: previously this is where the OTHER vehicle holding `driverId`
    // got cleared — but that ran before we'd even checked whether THIS
    // vehicle could be created (see the type/capacity guard below). If
    // this vehicle then got skipped, the driver was left stranded with no
    // vehicle at all. That clear now happens inside the transaction below,
    // only once we're certain this vehicle's write is going through.

    // Vendor is matched by exact name (Vendor.name is @unique) — this
    // script only LINKS to an existing vendor, it never creates one, so
    // a typo in the JSON just logs a warning instead of silently
    // creating a duplicate/junk vendor record.
    let vendorId;
    if (sourceVehicle.vendor) {
      const vendorRecord = await prisma.vendor.findUnique({
        where: { name: sourceVehicle.vendor },
      });

      if (vendorRecord) {
        vendorId = vendorRecord.id;
      } else {
        vehicleVendorNotFound++;

        console.log(
          `VENDOR NOT FOUND: "${sourceVehicle.vendor}" — vehicle will be saved without a vendor link.`
        );
      }
    }

    try {
      const existingVehicle = await prisma.vehicle.findUnique({
        where: { vehicleNumber },
      });

      const capacity =
        sourceVehicle.capacity !== undefined &&
        sourceVehicle.capacity !== null &&
        sourceVehicle.capacity !== ""
          ? Number(sourceVehicle.capacity)
          : undefined;

      if (
        !existingVehicle &&
        (!sourceVehicle.type || capacity === undefined || Number.isNaN(capacity))
      ) {
        // type and capacity are required (non-nullable) columns on
        // Vehicle — can't create a new row without them. An existing
        // row can still be updated with whatever fields ARE present.
        // Bail out BEFORE touching any other vehicle's driverId — this
        // row never gets written, so nothing else should change either.
        vehiclesSkippedMissingFields++;

        console.log(
          `SKIPPED - new vehicle missing required type/capacity: ${vehicleNumber}`
        );

        continue;
      }

      const data = {
        vehicleNumber,
        type: sourceVehicle.type || undefined,
        make: sourceVehicle.make || undefined,
        model: sourceVehicle.model || undefined,
        capacity,
        status: sourceVehicle.status || undefined,
        notes: sourceVehicle.notes || undefined,
        vendorId,
        // Explicit null (not undefined) so an existing vehicle whose
        // driver no longer matches anyone gets correctly UNASSIGNED
        // rather than keeping a stale driverId forever.
        driverId: driverId || null,
      };

      // Now — and only now, since we know this vehicle's write is going
      // through — clear the driver off whatever OTHER vehicle currently
      // holds it (Vehicle.driverId is @unique, so it can't be on both).
      // Both writes happen in one transaction: either the handoff fully
      // completes, or neither write lands, so a mid-run crash can never
      // leave a driver stripped from their old vehicle with nowhere to go.
      const vehicle = await prisma.$transaction(async (tx) => {
        if (driverId) {
          const otherVehicleWithThisDriver = await tx.vehicle.findUnique({
            where: { driverId },
          });

          if (
            otherVehicleWithThisDriver &&
            otherVehicleWithThisDriver.vehicleNumber !== vehicleNumber
          ) {
            await tx.vehicle.update({
              where: { id: otherVehicleWithThisDriver.id },
              data: { driverId: null },
            });

            vehicleReassignedFromOtherVehicle++;

            console.log(
              `REASSIGNED: driver was linked to ${otherVehicleWithThisDriver.vehicleNumber}, moving to ${vehicleNumber}`
            );
          }
        }

        if (existingVehicle) {
          const updated = await tx.vehicle.update({
            where: { id: existingVehicle.id },
            data,
          });

          vehiclesUpdated++;

          console.log(`UPDATED VEHICLE: ${updated.vehicleNumber}`);

          return updated;
        }

        const created = await tx.vehicle.create({ data });

        vehiclesCreated++;

        console.log(`CREATED VEHICLE: ${created.vehicleNumber}`);

        return created;
      });

      if (driverId) {
        console.log(`ASSIGNED DRIVER: ${driverId}`);

        if (primarySeedId) {
          seedIdsClaimedThisRun.add(primarySeedId);
        }
      } else {
        console.log(`ASSIGNED DRIVER: none`);
      }
    } catch (error) {
      vehiclesFailed++;

      console.error(`FAILED VEHICLE: ${vehicleNumber}`);
      console.error(error.message);
    }
  }

  // ==================================================
  // 11. FINAL DATABASE DUPLICATE CHECK
  // ==================================================

  console.log("\n");
  console.log("==============================================");
  console.log("      FINAL DUPLICATE VERIFICATION");
  console.log("==============================================");
  console.log("\n");

  const finalDrivers =
    await prisma.driver.findMany({
      select: {
        id: true,
        name: true,
        licenseNumber: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

  const finalLicenseMap =
    new Map();

  let finalDuplicates = 0;

  for (
    const driver of finalDrivers
  ) {
    const license =
      normalizeLicense(
        driver.licenseNumber
      );

    // No license should never exist
    if (!license) {
      console.error(
        `WARNING: Driver without license still exists: ${driver.id}`
      );

      continue;
    }

    if (
      finalLicenseMap.has(
        license
      )
    ) {
      finalDuplicates++;

      const original =
        finalLicenseMap.get(
          license
        );

      console.error(
        `DUPLICATE STILL EXISTS: ${driver.name} / ${driver.licenseNumber}`
      );

      console.error(
        `Original: ${original.id}`
      );

      console.error(
        `Duplicate: ${driver.id}`
      );
    } else {
      finalLicenseMap.set(
        license,
        driver
      );
    }
  }

  // ==================================================
  // 12. FINAL JSON -> DB VERIFICATION
  // ==================================================

  let missingAfterSync = 0;

  for (
    const sourceDriver of uniqueDrivers
  ) {
    const license =
      normalizeLicense(
        sourceDriver.licenseNumber
      );

    if (!license) {
      continue;
    }

    const dbDriver =
      finalLicenseMap.get(
        license
      );

    if (!dbDriver) {
      missingAfterSync++;

      console.error(
        `MISSING AFTER SYNC: ${sourceDriver.name} - ${sourceDriver.licenseNumber}`
      );
    }
  }

  // ==================================================
  // 13. FINAL SUMMARY
  // ==================================================

  console.log("\n\n");
  console.log("==============================================");
  console.log("       DRIVER USER + QR SYNC COMPLETE");
  console.log("==============================================");

  console.log("\nJSON CLEANUP");
  console.log(
    `Original JSON drivers       : ${drivers.length}`
  );
  console.log(
    `Valid unique drivers        : ${uniqueDrivers.length}`
  );
  console.log(
    `No-license skipped          : ${noLicenseSkipped}`
  );
  console.log(
    `Duplicate license skipped   : ${duplicateJsonSkipped}`
  );
  console.log(
    `Duplicate seedId skipped    : ${duplicateSeedIdSkipped}`
  );

  console.log("\nDATABASE CLEANUP");
  console.log(
    `No-license deleted          : ${driversDeleted}`
  );
  console.log(
    `No-license delete failures  : ${driverDeleteFailed}`
  );
  console.log(
    `DB duplicates deleted       : ${duplicateDriversDeleted}`
  );
  console.log(
    `DB duplicate failures       : ${duplicateDriverDeleteFailed}`
  );

  console.log("\nDRIVERS");
  console.log(
    `Drivers created             : ${driversCreated}`
  );
  console.log(
    `Drivers verified/updated    : ${driversUpdated}`
  );
  console.log(
    `Drivers skipped             : ${driversSkipped}`
  );

  console.log("\nUSERS / LOGIN");
  console.log(
    `Users created               : ${usersCreated}`
  );
  console.log(
    `Users linked                : ${usersLinked}`
  );
  console.log(
    `Users already existed       : ${usersAlreadyExist}`
  );
  console.log(
    `Emails migrated to seedId   : ${usersEmailMigrated}`
  );
  console.log(
    `Email migration skipped     : ${usersEmailMigrationSkipped}`
  );
  console.log(
    `Email migration failed      : ${usersEmailMigrationFailed}`
  );

  console.log("\nQR");
  console.log(
    `QR tokens created           : ${qrTokensCreated}`
  );
  console.log(
    `QR images created           : ${qrImagesCreated}`
  );
  console.log(
    `QR images already existed   : ${qrImagesSkipped}`
  );

  console.log("\nVEHICLES");
  console.log(
    `Vehicles created             : ${vehiclesCreated}`
  );
  console.log(
    `Vehicles updated             : ${vehiclesUpdated}`
  );
  console.log(
    `Skipped - no vehicleNumber   : ${vehiclesSkippedNoNumber}`
  );
  console.log(
    `Skipped - missing type/cap.  : ${vehiclesSkippedMissingFields}`
  );
  console.log(
    `Skipped - no driver match    : ${vehiclesSkippedNoDriverMatch}`
  );
  console.log(
    `Assignment conflicts (dupe)  : ${vehicleAssignmentConflicts}`
  );
  console.log(
    `Reassigned from old vehicle  : ${vehicleReassignedFromOtherVehicle}`
  );
  console.log(
    `Vendor not found             : ${vehicleVendorNotFound}`
  );
  console.log(
    `Vehicle processing failures  : ${vehiclesFailed}`
  );

  console.log("\nVERIFICATION");
  console.log(
    `Final DB drivers            : ${finalDrivers.length}`
  );
  console.log(
    `Final duplicate licenses    : ${finalDuplicates}`
  );
  console.log(
    `JSON drivers missing in DB  : ${missingAfterSync}`
  );

  console.log("\nPROCESSING");
  console.log(
    `Processing failures         : ${failed}`
  );

  console.log("\n----------------------------------------------");

  if (
    finalDuplicates === 0 &&
    missingAfterSync === 0 &&
    failed === 0
  ) {
    console.log(
      "SUCCESS: DRIVER DATA IS CLEAN AND SYNCED."
    );
  } else {
    console.log(
      "WARNING: CHECK THE ERRORS ABOVE."
    );
  }

  console.log("----------------------------------------------");

  console.log("\n");
}

// ==================================================
// RUN
// ==================================================

main()
  .catch((error) => {
    console.error("\n==============================================");
    console.error("SCRIPT FAILED");
    console.error("==============================================");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });