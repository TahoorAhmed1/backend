require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })


const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");


// ── helpers ──────────────────────────────────────────────────────────────────
const hash = (pw) => bcrypt.hash(pw, 10);

const empQR = (code) => `EMP-${code}-${randomUUID()}`;
const drvQR = (cnic) => `DRV-${cnic}-${randomUUID()}`;


const startOfCurrentWeekUTC = () => {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday),
  );
};

/** `base` (a UTC-midnight date) plus `days`, with a specific UTC time of day set. */
const atTime = (base, days, hh, mm) => {
  const dt = new Date(base);
  dt.setUTCDate(dt.getUTCDate() + days);
  dt.setUTCHours(hh, mm, 0, 0);
  return dt;
};
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱 Seeding database …");

  // ══════════════════════════════════════════════════════════════════════════
  // 1. AREAS
  // ══════════════════════════════════════════════════════════════════════════
  const [gulshan, dha, northNazimabad, johar, clifton, nazimabad] =
    await Promise.all([
      prisma.area.upsert({ where: { name: "Gulshan-e-Iqbal" }, update: {}, create: { name: "Gulshan-e-Iqbal", city: "Karachi" } }),
      prisma.area.upsert({ where: { name: "DHA"              }, update: {}, create: { name: "DHA",              city: "Karachi" } }),
      prisma.area.upsert({ where: { name: "North Nazimabad"  }, update: {}, create: { name: "North Nazimabad",  city: "Karachi" } }),
      prisma.area.upsert({ where: { name: "Gulistan-e-Johar" }, update: {}, create: { name: "Gulistan-e-Johar", city: "Karachi" } }),
      prisma.area.upsert({ where: { name: "Clifton"          }, update: {}, create: { name: "Clifton",          city: "Karachi" } }),
      prisma.area.upsert({ where: { name: "Nazimabad"        }, update: {}, create: { name: "Nazimabad",        city: "Karachi" } }),
    ]);
  console.log("✅ Areas");

  // ══════════════════════════════════════════════════════════════════════════
  // 2. SUB-AREAS
  // ══════════════════════════════════════════════════════════════════════════
  const [gulshan1, gulshan6, dhaP2, dhaP5, nnH, nnL, johar14B, cliff4, naz3] =
    await Promise.all([
      prisma.subArea.upsert({ where: { name_areaId: { name: "Block 1",     areaId: gulshan.id        } }, update: {}, create: { name: "Block 1",     areaId: gulshan.id        } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Block 6",     areaId: gulshan.id        } }, update: {}, create: { name: "Block 6",     areaId: gulshan.id        } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Phase 2",     areaId: dha.id            } }, update: {}, create: { name: "Phase 2",     areaId: dha.id            } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Phase 5",     areaId: dha.id            } }, update: {}, create: { name: "Phase 5",     areaId: dha.id            } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Block H",     areaId: northNazimabad.id } }, update: {}, create: { name: "Block H",     areaId: northNazimabad.id } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Block L",     areaId: northNazimabad.id } }, update: {}, create: { name: "Block L",     areaId: northNazimabad.id } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Sector 14-B", areaId: johar.id          } }, update: {}, create: { name: "Sector 14-B", areaId: johar.id          } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Block 4",     areaId: clifton.id        } }, update: {}, create: { name: "Block 4",     areaId: clifton.id        } }),
      prisma.subArea.upsert({ where: { name_areaId: { name: "Block 3",     areaId: nazimabad.id      } }, update: {}, create: { name: "Block 3",     areaId: nazimabad.id      } }),
    ]);
  console.log("✅ SubAreas");

  // ══════════════════════════════════════════════════════════════════════════
  // 3. BLOCKS
  // ══════════════════════════════════════════════════════════════════════════
  const [blk_gul1_s5, blk_gul6_s12, blk_dhaP2_A, blk_dhaP5_C, blk_nnH_150, blk_nnL_51] =
    await Promise.all([
      prisma.block.upsert({ where: { name_subAreaId: { name: "Street 5",     subAreaId: gulshan1.id } }, update: {}, create: { name: "Street 5",     subAreaId: gulshan1.id } }),
      prisma.block.upsert({ where: { name_subAreaId: { name: "Street 12",    subAreaId: gulshan6.id } }, update: {}, create: { name: "Street 12",    subAreaId: gulshan6.id } }),
      prisma.block.upsert({ where: { name_subAreaId: { name: "Lane A",       subAreaId: dhaP2.id   } }, update: {}, create: { name: "Lane A",       subAreaId: dhaP2.id   } }),
      prisma.block.upsert({ where: { name_subAreaId: { name: "Lane C",       subAreaId: dhaP5.id   } }, update: {}, create: { name: "Lane C",       subAreaId: dhaP5.id   } }),
      prisma.block.upsert({ where: { name_subAreaId: { name: "House 1-50",   subAreaId: nnH.id     } }, update: {}, create: { name: "House 1-50",   subAreaId: nnH.id     } }),
      prisma.block.upsert({ where: { name_subAreaId: { name: "House 51-100", subAreaId: nnL.id     } }, update: {}, create: { name: "House 51-100", subAreaId: nnL.id     } }),
    ]);
  console.log("✅ Blocks");

  // ══════════════════════════════════════════════════════════════════════════
  // 4. DEPARTMENTS
  // ══════════════════════════════════════════════════════════════════════════
  const [techDept, hrDept, financeDept, opsDept, salesDept, qaDept] =
    await Promise.all([
      prisma.department.upsert({ where: { name: "Technology"       }, update: {}, create: { name: "Technology"       } }),
      prisma.department.upsert({ where: { name: "Human Resources"  }, update: {}, create: { name: "Human Resources"  } }),
      prisma.department.upsert({ where: { name: "Finance"          }, update: {}, create: { name: "Finance"          } }),
      prisma.department.upsert({ where: { name: "Operations"       }, update: {}, create: { name: "Operations"       } }),
      prisma.department.upsert({ where: { name: "Sales & Marketing"}, update: {}, create: { name: "Sales & Marketing"} }),
      prisma.department.upsert({ where: { name: "Quality Assurance"}, update: {}, create: { name: "Quality Assurance"} }),
    ]);
  console.log("✅ Departments");

  // ══════════════════════════════════════════════════════════════════════════
  // 5. VENDORS
  // ══════════════════════════════════════════════════════════════════════════
  const [artVendor, ccsVendor, plgVendor, mmvVendor, swtVendor] =
    await Promise.all([
      prisma.vendor.upsert({ where: { name: "Al-Rehman Transport" }, update: {}, create: { name: "Al-Rehman Transport", shortName: "ART", contactPerson: "Muhammad Rehman", phone: "03001234567", email: "info@alrehman.com",      status: "ACTIVE"   } }),
      prisma.vendor.upsert({ where: { name: "City Cab Services"   }, update: {}, create: { name: "City Cab Services",   shortName: "CCS", contactPerson: "Tariq Mehmood",   phone: "03111234567", email: "citycab@gmail.com",      status: "ACTIVE"   } }),
      prisma.vendor.upsert({ where: { name: "Pak Logistics"       }, update: {}, create: { name: "Pak Logistics",       shortName: "PLG", contactPerson: "Asif Khan",        phone: "03211234567", email: "paklogistics@outlook.com",status: "ACTIVE"   } }),
      prisma.vendor.upsert({ where: { name: "Metro Movers"        }, update: {}, create: { name: "Metro Movers",        shortName: "MMV", contactPerson: "Salman Akhtar",    phone: "03451234567", email: "metromo@yahoo.com",      status: "INACTIVE" } }),
      prisma.vendor.upsert({ where: { name: "Speedway Transport"  }, update: {}, create: { name: "Speedway Transport",  shortName: "SWT", contactPerson: "Bilal Hussain",    phone: "03561234567", email: "speedway@gmail.com",     status: "ACTIVE"   } }),
    ]);
  console.log("✅ Vendors");

  // ══════════════════════════════════════════════════════════════════════════
  // 6. SYSTEM USERS  (Admin / Manager / Dispatcher — no employee/driver link)
  // ══════════════════════════════════════════════════════════════════════════
  const defaultPw = await hash("Admin@1234");

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@ibex.com" },
    update: {},
    create: { email: "admin@ibex.com", name: "System Admin", passwordHash: defaultPw, role: "ADMIN", isActive: true },
  });
  const managerUser = await prisma.user.upsert({
    where: { email: "manager@ibex.com" },
    update: {},
    create: { email: "manager@ibex.com", name: "Transport Manager", passwordHash: defaultPw, role: "MANAGER", isActive: true },
  });
  const dispatcherUser = await prisma.user.upsert({
    where: { email: "dispatcher@ibex.com" },
    update: {},
    create: { email: "dispatcher@ibex.com", name: "Dispatcher One", passwordHash: defaultPw, role: "DISPATCHER", isActive: true },
  });
  console.log("✅ System Users (Admin / Manager / Dispatcher)");

  // ══════════════════════════════════════════════════════════════════════════
  // 7. DRIVER USERS  → then Drivers (User first so userId is available)
  //
  //  QR format: DRV-<cnic>-<uuid>
  //  Role     : DRIVER
  //  Flow     : Scanner at office gate reads QR → looks up User.qr_code
  //             → resolves Driver → marks driver shift start/end
  //  NOTE: Email is set to employeeCode (DRV-<cnic> for uniqueness)
  // ══════════════════════════════════════════════════════════════════════════
  const driverUserData = [
    { email: "DRV-4210101234567",      name: "Imran Ali",        cnic: "4210101234567", vendorId: artVendor.id, shiftType: "TWELVE_HOUR",      shiftLabel: "Morning", status: "AVAILABLE", maxDailyHours: 12, maxWeeklyHours: 60, notes: "Senior driver, prefers morning routes" },
    { email: "DRV-4210204321098",      name: "Kamran Siddiqui",  cnic: "4210204321098", vendorId: ccsVendor.id, shiftType: "TWELVE_HOUR",      shiftLabel: "Morning", status: "AVAILABLE", maxDailyHours: 12, maxWeeklyHours: 60, notes: null },
    { email: "DRV-4210399887766",      name: "Shahid Nawaz",     cnic: "4210399887766", vendorId: plgVendor.id, shiftType: "TWENTY_FOUR_HOUR", shiftLabel: "Night",   status: "ON_RIDE",   maxDailyHours: 24, maxWeeklyHours: 72, notes: "24-hour shift, bus route" },
    { email: "DRV-4210455667788",      name: "Faisal Qureshi",   cnic: "4210455667788", vendorId: artVendor.id, shiftType: "TWELVE_HOUR",      shiftLabel: "Evening", status: "AVAILABLE", maxDailyHours: 12, maxWeeklyHours: 60, notes: null },
    { email: "DRV-4210511223344",      name: "Zubair Ahmed",     cnic: "4210511223344", vendorId: swtVendor.id, shiftType: "TWELVE_HOUR",      shiftLabel: "Morning", status: "AVAILABLE", maxDailyHours: 12, maxWeeklyHours: 60, notes: "Handles evening Johar route" },
    { email: "DRV-4210677889900",      name: "Nadeem Butt",      cnic: "4210677889900", vendorId: ccsVendor.id, shiftType: "TWELVE_HOUR",      shiftLabel: "Morning", status: "OFFLINE",   maxDailyHours: 12, maxWeeklyHours: 60, notes: "On leave this week" },
    { email: "DRV-4210788990011",      name: "Waqar Sheikh",     cnic: "4210788990011", vendorId: artVendor.id, shiftType: "TWELVE_HOUR",      shiftLabel: "Morning", status: "AVAILABLE", maxDailyHours: 12, maxWeeklyHours: 60, notes: "Backup driver — covers overflow trips when a route exceeds vehicle capacity" },
  ];

  const driverPw = await hash("Driver@1234");
  const drivers = [];

  for (const d of driverUserData) {
    // 1️⃣ Create / find the User with a unique QR code
    const drvUser = await prisma.user.upsert({
      where: { email: d.email },
      update: {},
      create: {
        email:        d.email,
        name:         d.name,
        passwordHash: driverPw,
        role:         "DRIVER",
        qrCode:       drvQR(d.cnic),   // ← QR payload stored here
        isActive:     true,
      },
    });

    // 2️⃣ Create / find the Driver linked to that User
    const driver = await prisma.driver.upsert({
      where: { cnic: d.cnic },
      update: { userId: drvUser.id },
      create: {
        name:          d.name,
        phone:         `030${Math.floor(10000000 + Math.random() * 90000000)}`,
        licenseNumber: `KHI-${2017 + drivers.length}-${100000 + drivers.length}`,
        cnic:          d.cnic,
        vendorId:      d.vendorId,
        shiftType:     d.shiftType,
        shiftLabel:    d.shiftLabel,
        status:        d.status,
        maxDailyHours:  d.maxDailyHours,
        maxWeeklyHours: d.maxWeeklyHours,
        notes:          d.notes,
        userId:        drvUser.id,     // ← link back
      },
    });

    drivers.push(driver);
  }

  const [driver1, driver2, driver3, driver4, driver5, driver6, driver7] = drivers;
  console.log("✅ Driver Users + Drivers (with QR codes)");

  // ══════════════════════════════════════════════════════════════════════════
  // 8. VEHICLES  (linked to drivers)
  // ══════════════════════════════════════════════════════════════════════════
  const [van1, hijet1, bus1, car1, karvan1, van2, car2] = await Promise.all([
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-A-1234" }, update: {}, create: { vehicleNumber: "KHI-A-1234", type: "VAN",    make: "Toyota",   model: "HiAce",    year: "2021", capacity: 14, vendorId: artVendor.id, driverId: driver1.id, status: "ACTIVE"      } }),
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-B-5678" }, update: {}, create: { vehicleNumber: "KHI-B-5678", type: "HIJET",  make: "Daihatsu", model: "HiJet",    year: "2020", capacity: 8,  vendorId: ccsVendor.id, driverId: driver2.id, status: "ACTIVE"      } }),
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-C-9012" }, update: {}, create: { vehicleNumber: "KHI-C-9012", type: "BUS",    make: "Hino",     model: "Dutro",    year: "2019", capacity: 30, vendorId: plgVendor.id, driverId: driver3.id, status: "ACTIVE"      } }),
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-D-3456" }, update: {}, create: { vehicleNumber: "KHI-D-3456", type: "CAR",    make: "Honda",    model: "City",     year: "2022", capacity: 4,  vendorId: artVendor.id, driverId: driver4.id, status: "ACTIVE"      } }),
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-E-7890" }, update: {}, create: { vehicleNumber: "KHI-E-7890", type: "KARVAN", make: "Suzuki",   model: "Every",    year: "2021", capacity: 10, vendorId: swtVendor.id, driverId: driver5.id, status: "ACTIVE"      } }),
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-F-1122" }, update: {}, create: { vehicleNumber: "KHI-F-1122", type: "VAN",    make: "Toyota",   model: "HiAce GL", year: "2018", capacity: 14, vendorId: mmvVendor.id,                       status: "MAINTENANCE", notes: "Engine overhaul in progress" } }),
    prisma.vehicle.upsert({ where: { vehicleNumber: "KHI-G-3344" }, update: {}, create: { vehicleNumber: "KHI-G-3344", type: "CAR",    make: "Honda",    model: "City",     year: "2022", capacity: 4,  vendorId: artVendor.id, driverId: driver7.id, status: "ACTIVE", notes: "Overflow vehicle for CLF-IBT3-AM Trip 2" } }),
  ]);
  console.log("✅ Vehicles");

  // ══════════════════════════════════════════════════════════════════════════
  // 9. ROUTES
  // ══════════════════════════════════════════════════════════════════════════
  const [route1, route2, route3, route4, route5, route6] = await Promise.all([
    prisma.route.upsert({ where: { routeCode: "GUL-IBT1-AM" }, update: {}, create: { routeCode: "GUL-IBT1-AM", routeName: "Gulshan Block 1 → IBT-1 Morning",     areaId: gulshan.id,        subAreaId: gulshan1.id, officeLocation: "IBT_1",     serviceType: "PICK_AND_DROP", maxCapacity: 14, shiftTiming: "09:00", pickupStartTime: new Date("2024-01-01T07:30:00Z"), dropTime: new Date("2024-01-01T18:30:00Z"), driverId: driver1.id, status: "ACTIVE"   } }),
    prisma.route.upsert({ where: { routeCode: "DHA-SKY-AM"  }, update: {}, create: { routeCode: "DHA-SKY-AM",  routeName: "DHA Phase 5 → Sky Tower Morning",      areaId: dha.id,            subAreaId: dhaP5.id,    officeLocation: "SKY_TOWER", serviceType: "PICK_AND_DROP", maxCapacity: 8,  shiftTiming: "09:00", pickupStartTime: new Date("2024-01-01T07:00:00Z"), dropTime: new Date("2024-01-01T18:00:00Z"), driverId: driver2.id, status: "ACTIVE"   } }),
    prisma.route.upsert({ where: { routeCode: "NN-IBT2-AM"  }, update: {}, create: { routeCode: "NN-IBT2-AM",  routeName: "North Nazimabad → IBT-2 Morning",       areaId: northNazimabad.id, subAreaId: nnH.id,      officeLocation: "IBT_2",     serviceType: "PICK_AND_DROP", maxCapacity: 30, shiftTiming: "09:00", pickupStartTime: new Date("2024-01-01T07:15:00Z"), dropTime: new Date("2024-01-01T18:15:00Z"), driverId: driver3.id, status: "ACTIVE"   } }),
    prisma.route.upsert({ where: { routeCode: "CLF-IBT3-AM" }, update: {}, create: { routeCode: "CLF-IBT3-AM", routeName: "Clifton → IBT-3 Morning",               areaId: clifton.id,        subAreaId: cliff4.id,   officeLocation: "IBT_3",     serviceType: "PICK_ONLY",     maxCapacity: 8,  shiftTiming: "09:00", pickupStartTime: new Date("2024-01-01T08:00:00Z"),                                                     driverId: driver4.id, status: "ACTIVE"   } }),
    prisma.route.upsert({ where: { routeCode: "JHR-IBT1-PM" }, update: {}, create: { routeCode: "JHR-IBT1-PM", routeName: "Johar → IBT-1 Evening Shift",           areaId: johar.id,          subAreaId: johar14B.id, officeLocation: "IBT_1",     serviceType: "PICK_AND_DROP", maxCapacity: 10, shiftTiming: "18:00", pickupStartTime: new Date("2024-01-01T15:30:00Z"), dropTime: new Date("2024-01-01T20:30:00Z"), driverId: driver5.id, status: "ACTIVE"   } }),
    prisma.route.upsert({ where: { routeCode: "NAZ-SKY-AM"  }, update: {}, create: { routeCode: "NAZ-SKY-AM",  routeName: "Nazimabad → Sky Tower Morning",         areaId: nazimabad.id,      subAreaId: naz3.id,     officeLocation: "SKY_TOWER", serviceType: "PICK_AND_DROP", maxCapacity: 14, shiftTiming: "09:00", pickupStartTime: new Date("2024-01-01T07:45:00Z"), dropTime: new Date("2024-01-01T18:45:00Z"),                       status: "INACTIVE" } }),
  ]);
  console.log("✅ Routes");

  // ══════════════════════════════════════════════════════════════════════════
  // 9B. TRIPS  (a Trip = one vehicle/driver actually running a Route.
  //   Trip capacity = Trip.vehicle.capacity, this is the source of truth for
  //   how many employees that trip can carry. A route gets ONE trip as long
  //   as its assigned riders fit in one vehicle. CLF-IBT3-AM has 5 employees
  //   assigned but car1 only seats 4, so Trip 1 (driver4/car1) takes the
  //   first 4 and a Trip 2 (driver7/car2, SAME shiftTiming) is opened with a
  //   new driver+vehicle to carry the overflow rider — this is the pattern
  //   to repeat (Trip 3, Trip 4, ...) if a route keeps growing past what the
  //   newest vehicle can hold. route6 has no driver/vehicle assigned yet,
  //   matching its INACTIVE status.)
  // ══════════════════════════════════════════════════════════════════════════
  const [trip1a, trip2a, trip3a, trip4a, trip4b, trip5a, trip6a] = await Promise.all([
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route1.id, tripNumber: 1 } }, update: {}, create: { routeId: route1.id, tripNumber: 1, driverId: driver1.id, vehicleId: van1.id,    status: "ACTIVE"   } }),
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route2.id, tripNumber: 1 } }, update: {}, create: { routeId: route2.id, tripNumber: 1, driverId: driver2.id, vehicleId: hijet1.id,  status: "ACTIVE"   } }),
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route3.id, tripNumber: 1 } }, update: {}, create: { routeId: route3.id, tripNumber: 1, driverId: driver3.id, vehicleId: bus1.id,    status: "ACTIVE"   } }),
    // route4 (Clifton → IBT-3): 5 employees assigned, car1 capacity is only 4
    // → Trip 1 fills the vehicle to capacity...
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route4.id, tripNumber: 1 } }, update: {}, create: { routeId: route4.id, tripNumber: 1, driverId: driver4.id, vehicleId: car1.id,    status: "ACTIVE"   } }),
    // ...and the 5th (overflow) employee rides Trip 2, same shiftTiming/pickup, new driver+vehicle.
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route4.id, tripNumber: 2 } }, update: {}, create: { routeId: route4.id, tripNumber: 2, driverId: driver7.id, vehicleId: car2.id,    status: "ACTIVE"   } }),
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route5.id, tripNumber: 1 } }, update: {}, create: { routeId: route5.id, tripNumber: 1, driverId: driver5.id, vehicleId: karvan1.id, status: "ACTIVE"   } }),
    prisma.trip.upsert({ where: { routeId_tripNumber: { routeId: route6.id, tripNumber: 1 } }, update: {}, create: { routeId: route6.id, tripNumber: 1,                                              status: "INACTIVE" } }),
  ]);
  console.log("✅ Trips");

  // ══════════════════════════════════════════════════════════════════════════
  // 10. EMPLOYEE USERS  → then Employees
  //
  //  QR format: EMP-<employeeCode>-<uuid>
  //  Role     : EMPLOYEE
  //  Flow     : Driver has a handheld scanner (or phone camera).
  //             Employee shows their QR when boarding.
  //             Scanner hits POST /attendance/scan  { qr_code }
  //             → server resolves User → Employee → marks Attendance PRESENT
  //  NOTE: Email is set to employeeCode for uniqueness
  // ══════════════════════════════════════════════════════════════════════════
  const empPw = await hash("Employee@1234");

  const empSeeds = [
    {
      employeeCode:   "IBX-0001",
      name:           "Sara Khan",
      email:          "IBX-0001", // Changed to employeeCode
      contactNumber:  "03101112233",
      cnic:           "4210100011111",
      gender:         "FEMALE",
      designation:    "Senior Agent",
      entity:         "IBEX",
      officeLocation: "IBT_1",
      departmentId:   techDept.id,
      areaId:         gulshan.id,
      subAreaId:      gulshan1.id,
      blockId:        blk_gul1_s5.id,
      address:        "House 15, Street 5, Block 1, Gulshan-e-Iqbal, Karachi",
      serviceType:    "PICK_AND_DROP",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0002",
      name:           "Ali Hassan",
      email:          "IBX-0002", // Changed to employeeCode
      contactNumber:  "03202223344",
      cnic:           "4210200022222",
      gender:         "MALE",
      designation:    "Team Lead",
      entity:         "IBEX",
      officeLocation: "IBT_1",
      departmentId:   opsDept.id,
      areaId:         northNazimabad.id,
      subAreaId:      nnH.id,
      blockId:        blk_nnH_150.id,
      address:        "House 42, Block H, North Nazimabad, Karachi",
      serviceType:    "PICK_AND_DROP",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0003",
      name:           "Fatima Noor",
      email:          "IBX-0003", // Changed to employeeCode
      contactNumber:  "03303334455",
      cnic:           "4210300033333",
      gender:         "FEMALE",
      designation:    "Quality Analyst",
      entity:         "IBEX",
      officeLocation: "IBT_2",
      departmentId:   qaDept.id,
      areaId:         johar.id,
      subAreaId:      johar14B.id,
      address:        "Flat 7, Sector 14-B, Gulistan-e-Johar, Karachi",
      serviceType:    "PICK_AND_DROP",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0004",
      name:           "Usman Tariq",
      email:          "IBX-0004", // Changed to employeeCode
      contactNumber:  "03404445566",
      cnic:           "4210400044444",
      gender:         "MALE",
      designation:    "HR Executive",
      entity:         "IBEX",
      officeLocation: "SKY_TOWER",
      departmentId:   hrDept.id,
      areaId:         dha.id,
      subAreaId:      dhaP5.id,
      blockId:        blk_dhaP5_C.id,
      address:        "Plot 22, Lane C, Phase 5, DHA, Karachi",
      serviceType:    "PICK_AND_DROP",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0005",
      name:           "Zara Malik",
      email:          "IBX-0005", // Changed to employeeCode
      contactNumber:  "03505556677",
      cnic:           "4210500055555",
      gender:         "FEMALE",
      designation:    "Finance Officer",
      entity:         "IBEX",
      officeLocation: "IBT_1",
      departmentId:   financeDept.id,
      areaId:         clifton.id,
      subAreaId:      cliff4.id,
      address:        "Apartment 3B, Block 4, Clifton, Karachi",
      serviceType:    "PICK_ONLY",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "VW-0001",
      name:           "Haris Raza",
      email:          "VW-0001", // Changed to employeeCode
      contactNumber:  "03606667788",
      cnic:           "4210600066666",
      gender:         "MALE",
      designation:    "Sales Executive",
      entity:         "VW",
      officeLocation: "IBT_3",
      departmentId:   salesDept.id,
      areaId:         nazimabad.id,
      subAreaId:      naz3.id,
      address:        "House 8, Block 3, Nazimabad, Karachi",
      serviceType:    "PICK_AND_DROP",
      shiftTiming:    "18:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0006",
      name:           "Nadia Farooq",
      email:          "IBX-0006", // Changed to employeeCode
      contactNumber:  "03707778899",
      cnic:           "4210700077777",
      gender:         "FEMALE",
      designation:    "Agent",
      entity:         "IBEX",
      officeLocation: "IBT_1",
      departmentId:   techDept.id,
      areaId:         gulshan.id,
      subAreaId:      gulshan6.id,
      blockId:        blk_gul6_s12.id,
      address:        "House 31, Street 12, Block 6, Gulshan-e-Iqbal, Karachi",
      serviceType:    "DROP_ONLY",
      shiftTiming:    "09:00",
      status:         "INACTIVE",
    },
    // ── The next 4 employees all ride route4 (CLF-IBT3-AM). Combined with
    // Zara Malik above that's 5 riders on a route whose Trip 1 vehicle
    // (car1) only seats 4 — the 5th, Hina Sheikh, is the one who overflows
    // onto Trip 2 (driver7/car2) below. ──────────────────────────────────
    {
      employeeCode:   "IBX-0007",
      name:           "Kashif Malik",
      email:          "IBX-0007",
      contactNumber:  "03808889900",
      cnic:           "4210800088888",
      gender:         "MALE",
      designation:    "Support Engineer",
      entity:         "IBEX",
      officeLocation: "IBT_3",
      departmentId:   opsDept.id,
      areaId:         clifton.id,
      subAreaId:      cliff4.id,
      address:        "Apartment 5C, Block 4, Clifton, Karachi",
      serviceType:    "PICK_ONLY",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0008",
      name:           "Ayesha Siddiqui",
      email:          "IBX-0008",
      contactNumber:  "03909990011",
      cnic:           "4210900099999",
      gender:         "FEMALE",
      designation:    "QA Analyst",
      entity:         "IBEX",
      officeLocation: "IBT_3",
      departmentId:   qaDept.id,
      areaId:         clifton.id,
      subAreaId:      cliff4.id,
      address:        "House 9, Block 4, Clifton, Karachi",
      serviceType:    "PICK_ONLY",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0009",
      name:           "Bilal Ahmed",
      email:          "IBX-0009",
      contactNumber:  "03011112223",
      cnic:           "4211000000001",
      gender:         "MALE",
      designation:    "Sales Associate",
      entity:         "IBEX",
      officeLocation: "IBT_3",
      departmentId:   salesDept.id,
      areaId:         clifton.id,
      subAreaId:      cliff4.id,
      address:        "Flat 11, Block 4, Clifton, Karachi",
      serviceType:    "PICK_ONLY",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
    {
      employeeCode:   "IBX-0010",
      name:           "Hina Sheikh",
      email:          "IBX-0010",
      contactNumber:  "03122223344",
      cnic:           "4211100000002",
      gender:         "FEMALE",
      designation:    "Finance Analyst",
      entity:         "IBEX",
      officeLocation: "IBT_3",
      departmentId:   financeDept.id,
      areaId:         clifton.id,
      subAreaId:      cliff4.id,
      address:        "House 20, Block 4, Clifton, Karachi",
      serviceType:    "PICK_ONLY",
      shiftTiming:    "09:00",
      status:         "ACTIVE",
    },
  ];

  const employees = [];

  for (const e of empSeeds) {
    // 1️⃣ User with QR code
    const empUser = await prisma.user.upsert({
      where: { email: e.email },
      update: {},
      create: {
        email:        e.email,
        name:         e.name,
        passwordHash: empPw,
        role:         "EMPLOYEE",
        qrCode:       empQR(e.employeeCode),
        isActive:     e.status === "ACTIVE",
      },
    });

    // 2️⃣ Employee linked to User
    const emp = await prisma.employee.upsert({
      where: { employeeCode: e.employeeCode },
      update: { userId: empUser.id },
      create: {
        employeeCode:   e.employeeCode,
        name:           e.name,
        contactNumber:  e.contactNumber,
        cnic:           e.cnic,
        gender:         e.gender,
        designation:    e.designation,
        entity:         e.entity,
        officeLocation: e.officeLocation,
        departmentId:   e.departmentId,
        areaId:         e.areaId,
        subAreaId:      e.subAreaId,
        blockId:        e.blockId ?? null,
        address:        e.address,
        serviceType:    e.serviceType,
        shiftTiming:    e.shiftTiming,
        status:         e.status,
        userId:         empUser.id,           // ← link back
      },
    });

    employees.push(emp);
  }

  const [emp1, emp2, emp3, emp4, emp5, emp6, emp7, emp8, emp9, emp10, emp11] = employees;
  console.log("✅ Employee Users + Employees (with QR codes)");

  // ══════════════════════════════════════════════════════════════════════════
  // 11. WEEKLY SCHEDULES
  // ══════════════════════════════════════════════════════════════════════════
  const weekStart = startOfCurrentWeekUTC();

  await Promise.all([
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp1.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp1.id, routeId: route1.id, tripId: trip1a.id, driverId: driver1.id, vehicleId: van1.id,   vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_AND_DROP", monday: "BOTH", tuesday: "BOTH", wednesday: "BOTH",   thursday: "BOTH", friday: "BOTH", saturday: "OFF", sunday: "OFF", pickupTime: "07:30", shiftTiming: "09:00", officeArrivalTime: "09:00", dropTime: "18:30", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp2.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp2.id, routeId: route3.id, tripId: trip3a.id, driverId: driver3.id, vehicleId: bus1.id,   vendorId: plgVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_AND_DROP", monday: "BOTH", tuesday: "BOTH", wednesday: "ABSENT", thursday: "BOTH", friday: "BOTH", saturday: "OFF", sunday: "OFF", pickupTime: "07:15", shiftTiming: "09:00", officeArrivalTime: "09:00", dropTime: "18:15", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp3.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp3.id, routeId: route5.id, tripId: trip5a.id, driverId: driver5.id, vehicleId: karvan1.id, vendorId: swtVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_AND_DROP", monday: "BOTH", tuesday: "BOTH", wednesday: "BOTH",   thursday: "BOTH", friday: "BOTH", saturday: "OFF", sunday: "OFF", pickupTime: "15:30", shiftTiming: "18:00", officeArrivalTime: "18:00", dropTime: "20:30", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp4.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp4.id, routeId: route2.id, tripId: trip2a.id, driverId: driver2.id, vehicleId: hijet1.id, vendorId: ccsVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_AND_DROP", monday: "BOTH", tuesday: "BOTH", wednesday: "BOTH",   thursday: "BOTH", friday: "BOTH", saturday: "OFF", sunday: "OFF", pickupTime: "07:00", shiftTiming: "09:00", officeArrivalTime: "09:00", dropTime: "18:00", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp5.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp5.id, routeId: route4.id, tripId: trip4a.id, driverId: driver4.id, vehicleId: car1.id,   vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_ONLY",     monday: "PICKUP", tuesday: "PICKUP", wednesday: "PICKUP", thursday: "PICKUP", friday: "PICKUP", saturday: "OFF", sunday: "OFF", pickupTime: "08:00", shiftTiming: "09:00", officeArrivalTime: "09:00", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp6.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp6.id, routeId: route1.id, tripId: trip1a.id, driverId: driver1.id, vehicleId: van1.id,   vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_AND_DROP", monday: "BOTH", tuesday: "BOTH", wednesday: "BOTH",   thursday: "BOTH", friday: "BOTH", saturday: "OFF", sunday: "OFF", pickupTime: "07:30", shiftTiming: "09:00", officeArrivalTime: "09:00", dropTime: "18:30", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp7.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp7.id, routeId: route1.id, tripId: trip1a.id, driverId: driver1.id, vehicleId: van1.id,   vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "DROP_ONLY",     monday: "DROP",   tuesday: "DROP",   wednesday: "DROP",   thursday: "DROP",   friday: "DROP",   saturday: "OFF", sunday: "OFF", dropTime: "18:30", shiftTiming: "09:00", offDay: "Saturday & Sunday", status: "DRAFT" } }),
    // ── route4 (CLF-IBT3-AM): 5 riders total, car1 seats 4 → 4 on Trip 1, 1 overflows to Trip 2 ──
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp8.id,  weekStart } }, update: {}, create: { weekStart, employeeId: emp8.id,  routeId: route4.id, tripId: trip4a.id, driverId: driver4.id, vehicleId: car1.id, vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_ONLY", monday: "PICKUP", tuesday: "PICKUP", wednesday: "PICKUP", thursday: "PICKUP", friday: "PICKUP", saturday: "OFF", sunday: "OFF", pickupTime: "08:00", shiftTiming: "09:00", officeArrivalTime: "09:00", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp9.id,  weekStart } }, update: {}, create: { weekStart, employeeId: emp9.id,  routeId: route4.id, tripId: trip4a.id, driverId: driver4.id, vehicleId: car1.id, vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_ONLY", monday: "PICKUP", tuesday: "PICKUP", wednesday: "PICKUP", thursday: "PICKUP", friday: "PICKUP", saturday: "OFF", sunday: "OFF", pickupTime: "08:00", shiftTiming: "09:00", officeArrivalTime: "09:00", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp10.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp10.id, routeId: route4.id, tripId: trip4a.id, driverId: driver4.id, vehicleId: car1.id, vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_ONLY", monday: "PICKUP", tuesday: "PICKUP", wednesday: "PICKUP", thursday: "PICKUP", friday: "PICKUP", saturday: "OFF", sunday: "OFF", pickupTime: "08:00", shiftTiming: "09:00", officeArrivalTime: "09:00", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
    // emp11 is the 5th rider — car1 (Trip 1) is already full at 4/4, so she's on Trip 2 (driver7/car2), same pickup/shift timing as Trip 1
    prisma.weeklySchedule.upsert({ where: { employeeId_weekStart: { employeeId: emp11.id, weekStart } }, update: {}, create: { weekStart, employeeId: emp11.id, routeId: route4.id, tripId: trip4b.id, driverId: driver7.id, vehicleId: car2.id, vendorId: artVendor.id, vehicleEntity: "IBEX", serviceType: "PICK_ONLY", monday: "PICKUP", tuesday: "PICKUP", wednesday: "PICKUP", thursday: "PICKUP", friday: "PICKUP", saturday: "OFF", sunday: "OFF", pickupTime: "08:00", shiftTiming: "09:00", officeArrivalTime: "09:00", offDay: "Saturday & Sunday", status: "ACTIVE" } }),
  ]);
  console.log("✅ Weekly Schedules");

  // ══════════════════════════════════════════════════════════════════════════
  // 12. RIDES
  // ══════════════════════════════════════════════════════════════════════════
  const d1 = weekStart;                 // Monday this week
  const d2 = atTime(weekStart, 1, 0, 0); // Tuesday this week
  const d3 = atTime(weekStart, 2, 0, 0); // Wednesday this week

  const [ride1, ride2, ride3, ride4, ride5, ride6] = await Promise.all([
    prisma.ride.create({ data: { rideDate: d1, routeId: route1.id, driverId: driver1.id, vehicleId: van1.id,    vendorId: artVendor.id, areaId: gulshan.id,        pickupTime: "07:30", dropTime: "18:30", status: "COMPLETED" } }),
    prisma.ride.create({ data: { rideDate: d1, routeId: route2.id, driverId: driver2.id, vehicleId: hijet1.id,  vendorId: ccsVendor.id, areaId: dha.id,            pickupTime: "07:00", dropTime: "18:00", status: "COMPLETED" } }),
    prisma.ride.create({ data: { rideDate: d2, routeId: route3.id, driverId: driver3.id, vehicleId: bus1.id,    vendorId: plgVendor.id, areaId: northNazimabad.id, pickupTime: "07:15", dropTime: "18:15", status: "COMPLETED" } }),
    prisma.ride.create({ data: { rideDate: d2, routeId: route4.id, driverId: driver4.id, vehicleId: car1.id,    vendorId: artVendor.id, areaId: clifton.id,        pickupTime: "08:00",                   status: "COMPLETED" } }),
    prisma.ride.create({ data: { rideDate: d3, routeId: route5.id, driverId: driver5.id, vehicleId: karvan1.id, vendorId: swtVendor.id, areaId: johar.id,          pickupTime: "15:30", dropTime: "20:30", status: "STARTED"   } }),
    prisma.ride.create({ data: { rideDate: d3, routeId: route1.id, driverId: driver1.id, vehicleId: van1.id,    vendorId: artVendor.id, areaId: gulshan.id,        pickupTime: "07:30", dropTime: "18:30", status: "PENDING"   } }),
  ]);
  console.log("✅ Rides");

  // ══════════════════════════════════════════════════════════════════════════
  // 13. RIDE PASSENGERS
  // ══════════════════════════════════════════════════════════════════════════
  await Promise.all([
    prisma.ridePassenger.create({ data: { rideId: ride1.id, employeeId: emp1.id, address: emp1.address ?? "", contact: "03101112233" } }),
    prisma.ridePassenger.create({ data: { rideId: ride1.id, employeeId: emp7.id, address: emp7.address ?? "", contact: "03707778899" } }),
    prisma.ridePassenger.create({ data: { rideId: ride2.id, employeeId: emp4.id, address: emp4.address ?? "", contact: "03404445566" } }),
    prisma.ridePassenger.create({ data: { rideId: ride3.id, employeeId: emp2.id, address: emp2.address ?? "", contact: "03202223344" } }),
    prisma.ridePassenger.create({ data: { rideId: ride4.id, employeeId: emp5.id, address: emp5.address ?? "", contact: "03505556677" } }),
    prisma.ridePassenger.create({ data: { rideId: ride5.id, employeeId: emp3.id, address: emp3.address ?? "", contact: "03303334455" } }),
  ]);
  console.log("✅ Ride Passengers");

  // ══════════════════════════════════════════════════════════════════════════
  // 14. ATTENDANCE
  //   Populated via QR scan simulation:
  //   Driver scans employee QR → POST /attendance/scan → PRESENT / LATE marked
  // ══════════════════════════════════════════════════════════════════════════
  await Promise.all([
    prisma.attendance.create({ data: { rideDate: d1, employeeId: emp1.id, rideId: ride1.id, arrivalTime: atTime(weekStart, 0, 9, 5),  delayMinutes: 5,  status: "LATE"    } }),
    prisma.attendance.create({ data: { rideDate: d1, employeeId: emp4.id, rideId: ride2.id, arrivalTime: atTime(weekStart, 0, 8, 58), delayMinutes: 0,  status: "PRESENT" } }),
    prisma.attendance.create({ data: { rideDate: d2, employeeId: emp2.id, rideId: ride3.id,                                                                  status: "ABSENT"  } }),
    prisma.attendance.create({ data: { rideDate: d2, employeeId: emp5.id, rideId: ride4.id, arrivalTime: atTime(weekStart, 1, 9, 0),  delayMinutes: 0,  status: "PRESENT" } }),
    prisma.attendance.create({ data: { rideDate: d3, employeeId: emp3.id, rideId: ride5.id, arrivalTime: atTime(weekStart, 2, 18, 12), delayMinutes: 12, status: "LATE"    } }),
    prisma.attendance.create({ data: { rideDate: d3, employeeId: emp7.id, rideId: ride6.id,                                                                  status: "NO_SHOW" } }),
  ]);
  console.log("✅ Attendance");

  // ══════════════════════════════════════════════════════════════════════════
  // 15. COMPLAINTS
  // ══════════════════════════════════════════════════════════════════════════
  await Promise.all([
    prisma.complaint.create({ data: { employeeId: emp1.id, driverId: driver1.id, vehicleId: van1.id,   rideId: ride1.id, category: "DRIVER_BEHAVIOUR",  title: "Driver was rude",                   description: "Driver used inappropriate language during morning pickup.",                                             status: "IN_PROGRESS"                                                           } }),
    prisma.complaint.create({ data: { employeeId: emp4.id,                        vehicleId: hijet1.id, rideId: ride2.id, category: "VEHICLE_CONDITION", title: "AC not working",                    description: "Air conditioning non-functional for entire ride.",                                                       status: "OPEN"                                                                  } }),
    prisma.complaint.create({ data: { employeeId: emp2.id,                                              rideId: ride3.id, category: "TIMING_DELAY",      title: "Pickup 30 minutes late",            description: "Driver arrived 30 mins late, employee missed morning meeting.",                                          status: "RESOLVED",    resolution: "Driver counseled. Delay note added to record."    } }),
    prisma.complaint.create({ data: { employeeId: emp5.id, driverId: driver4.id,                                         category: "ROUTE_ISSUE",        title: "Wrong route taken",                 description: "Driver took unnecessarily long route, adding 20 extra minutes.",                                         status: "OPEN"                                                                  } }),
    prisma.complaint.create({ data: { employeeId: emp3.id,                                                                category: "SCHEDULING",         title: "Schedule not updated after shift change", description: "Employee shift changed but transport schedule not updated for 2 weeks.",                             status: "RESOLVED",    resolution: "Schedule updated. Dispatcher alerted."            } }),
    prisma.complaint.create({ data: { employeeId: emp6.id, driverId: driver5.id, vehicleId: karvan1.id,                  category: "OTHER",              title: "Overcrowded vehicle",               description: "More passengers than seat capacity — uncomfortable and unsafe.",                                         status: "IN_PROGRESS"                                                           } }),
  ]);
  console.log("✅ Complaints");

  // ══════════════════════════════════════════════════════════════════════════
  // 16. AUDIT LOGS
  // ══════════════════════════════════════════════════════════════════════════
  await prisma.auditLog.createMany({
    data: [
      { userId: adminUser.id,      action: "CREATE", model: "Route",   recordId: route1.id,  after:  { routeCode: "GUL-IBT1-AM", status: "ACTIVE"   },                                        ipAddress: "192.168.1.10" },
      { userId: managerUser.id,    action: "UPDATE", model: "Driver",  recordId: driver3.id, before: { status: "AVAILABLE"  }, after: { status: "ON_RIDE"    },                              ipAddress: "192.168.1.15" },
      { userId: dispatcherUser.id, action: "CREATE", model: "Ride",    recordId: ride1.id,   after:  { routeId: route1.id,   status: "PENDING"  },                                            ipAddress: "192.168.1.20" },
      { userId: dispatcherUser.id, action: "UPDATE", model: "Ride",    recordId: ride1.id,   before: { status: "STARTED"    }, after: { status: "COMPLETED"  },                              ipAddress: "192.168.1.20" },
      { userId: adminUser.id,      action: "UPDATE", model: "Vehicle", recordId: van2.id,    before: { status: "ACTIVE"     }, after: { status: "MAINTENANCE"},                              ipAddress: "192.168.1.10" },
    ],
  });
  console.log("✅ Audit Logs");

  // ══════════════════════════════════════════════════════════════════════════
  // 16B. SCHEDULE EXCEPTIONS  (rows from a bulk weekly-schedule upload that
  //   couldn't be auto-matched/applied and need manual review)
  // ══════════════════════════════════════════════════════════════════════════
  await prisma.scheduleException.createMany({
    data: [
      { weekStart, employeeCode: "IBX-0099", rowNumber: 12, reason: "Employee code not found in system",     rawData: { employeeCode: "IBX-0099", name: "Unknown Employee", route: "GUL-IBT1-AM" }, resolved: false },
      { weekStart, employeeCode: "VW-0002",  rowNumber: 27, reason: "Duplicate entry for same week",         rawData: { employeeCode: "VW-0002", name: "Haris Raza", route: "NAZ-SKY-AM" },         resolved: true  },
      { weekStart, employeeCode: null,       rowNumber: 33, reason: "Missing route code in upload sheet",    rawData: { name: "Nadia Farooq", pickupTime: "07:30" },                                 resolved: false },
    ],
  });
  console.log("✅ Schedule Exceptions");

  // ══════════════════════════════════════════════════════════════════════════
  // 17. NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════
  // resolve userIds from employees array
  const empUserIds = await prisma.employee.findMany({
    where: { id: { in: employees.map((e) => e.id) } },
    select: { id: true, userId: true, name: true },
  });
  const byEmpId = Object.fromEntries(empUserIds.map((e) => [e.id, e.userId]));

  await prisma.notification.createMany({
    data: [
      { userId: byEmpId[emp1.id],   title: "Ride Scheduled",                body: "Morning pickup confirmed for tomorrow at 07:30 from Block 1, Gulshan.",         status: "UNREAD", link: "/rides"      },
      { userId: byEmpId[emp2.id],   title: "Attendance Marked Absent",       body: "You were marked absent on Wed Jan 8. Contact HR if incorrect.",                 status: "READ",   link: "/attendance" },
      { userId: byEmpId[emp3.id],   title: "Complaint Resolved",             body: "Your scheduling complaint has been resolved by the dispatcher.",                 status: "UNREAD", link: "/complaints" },
      { userId: managerUser.id,     title: "New Complaint Filed",            body: "Driver Behaviour complaint filed by Sara Khan — please review.",                 status: "UNREAD", link: "/complaints" },
      { userId: dispatcherUser.id,  title: "Vehicle in Maintenance",         body: "KHI-F-1122 (Toyota HiAce GL) moved to maintenance. Reassign if needed.",        status: "READ",   link: "/vehicles"   },
      { userId: byEmpId[emp4.id],   title: "Route Updated",                  body: "Your route changed to DHA Phase 5 → Sky Tower. Pickup at 07:00.",              status: "UNREAD", link: "/schedules"  },
    ],
  });
  console.log("✅ Notifications");

  console.log(`
╔══════════════════════════════════════════════════════╗
║         ✅  SEED COMPLETE — Summary                  ║
╠══════════════════════════════════════════════════════╣
║  Areas            6   SubAreas      9   Blocks    6  ║
║  Departments      6   Vendors       5              ║
║  Driver Users     7   Drivers       7  (QR coded)   ║
║  Employee Users  11   Employees    11  (QR coded)   ║
║  System Users     3   (Admin/Mgr/Dispatch)           ║
║  Vehicles         7   Routes        6              ║
║  Trips            7   Weekly Schedules  11         ║
║  Rides            6   Ride Passengers   6          ║
║  Attendance       6   Complaints        6          ║
║  Audit Logs       5   Schedule Exceptions 3        ║
║  Notifications    6                               ║
╠══════════════════════════════════════════════════════╣
║  Default passwords:                                  ║
║    Admin/Mgr/Dispatch → Admin@1234                   ║
║    Drivers            → Driver@1234                  ║
║    Employees          → Employee@1234                ║
╚══════════════════════════════════════════════════════╝
`);
}

main()
  .catch((e) => { console.error("❌ Seed failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());