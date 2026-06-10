const Joi = require("joi");

const areaCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    name: Joi.string().required().min(2).max(100),
    city: Joi.string().optional().default("Karachi"),
  }),
});

const areaUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    name: Joi.string().optional().min(2).max(100),
    city: Joi.string().optional(),
  }),
});

const areaIdSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({}),
});

const subAreaCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    name: Joi.string().required().min(2).max(100),
    areaId: Joi.string().uuid().required(),
  }),
});

const subAreaUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    name: Joi.string().optional().min(2).max(100),
    areaId: Joi.string().uuid().optional(),
  }),
});

const subAreaIdSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({}),
});

const blockCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    name: Joi.string().required().min(1).max(100),
    subAreaId: Joi.string().uuid().required(),
  }),
});

const blockUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    name: Joi.string().optional().min(1).max(100),
    subAreaId: Joi.string().uuid().optional(),
  }),
});

const blockIdSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({}),
});

const departmentCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    name: Joi.string().required().min(2).max(100),
  }),
});

const departmentUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    name: Joi.string().optional().min(2).max(100),
  }),
});

const departmentIdSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({}),
});

const employeeCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    employeeCode: Joi.string().required().min(2).max(50),
    name: Joi.string().required().min(2).max(100),
    contactNumber: Joi.string().optional().allow(null),
    cnic: Joi.string().optional().allow(null),
    gender: Joi.string().optional().valid("MALE", "FEMALE", "OTHER"),
    designation: Joi.string().optional().allow(null),
    departmentId: Joi.string().uuid().optional().allow(null),
    entity: Joi.string()
      .optional()
      .valid("IBEX", "VW")
      .allow(null),
    officeLocation: Joi.string()
      .optional()
      .valid("IBT_1", "IBT_2", "IBT_3", "SKY_TOWER")
      .allow(null),
    areaId: Joi.string().uuid().optional().allow(null),
    subAreaId: Joi.string().uuid().optional().allow(null),
    blockId: Joi.string().uuid().optional().allow(null),
    address: Joi.string().optional().allow(null),
    serviceType: Joi.string()
      .optional()
      .default("PICK_AND_DROP")
      .valid("PICK_AND_DROP", "DROP_ONLY", "PICK_ONLY"),
    shiftTiming: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("ACTIVE")
      .valid("ACTIVE", "INACTIVE", "TERMINATED"),
  }),
});

const employeeUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    employeeCode: Joi.string().optional().min(2).max(50),
    name: Joi.string().optional().min(2).max(100),
    contactNumber: Joi.string().optional().allow(null),
    cnic: Joi.string().optional().allow(null),
    gender: Joi.string().optional().valid("MALE", "FEMALE", "OTHER"),
    designation: Joi.string().optional().allow(null),
    departmentId: Joi.string().uuid().optional().allow(null),
    entity: Joi.string()
      .optional()
      .valid("IBEX", "VW")
      .allow(null),
    officeLocation: Joi.string()
      .optional()
      .valid("IBT_1", "IBT_2", "IBT_3", "SKY_TOWER")
      .allow(null),
    areaId: Joi.string().uuid().optional().allow(null),
    subAreaId: Joi.string().uuid().optional().allow(null),
    blockId: Joi.string().uuid().optional().allow(null),
    address: Joi.string().optional().allow(null),
    serviceType: Joi.string()
      .optional()
      .valid("PICK_AND_DROP", "DROP_ONLY", "PICK_ONLY"),
    shiftTiming: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("ACTIVE", "INACTIVE", "TERMINATED"),
  }),
});

const employeeIdSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({}),
});

const vendorCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    name: Joi.string().required().min(2).max(100),
    shortName: Joi.string().optional().max(50),
    contactPerson: Joi.string().optional().allow(null),
    phone: Joi.string().optional().allow(null),
    email: Joi.string().optional().email().allow(null),
    status: Joi.string()
      .optional()
      .default("ACTIVE")
      .valid("ACTIVE", "INACTIVE"),
  }),
});

const vendorUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    name: Joi.string().optional().min(2).max(100),
    shortName: Joi.string().optional().max(50),
    contactPerson: Joi.string().optional().allow(null),
    phone: Joi.string().optional().allow(null),
    email: Joi.string().optional().email().allow(null),
    status: Joi.string().optional().valid("ACTIVE", "INACTIVE"),
  }),
});

const vendorIdSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({}),
});

const vehicleCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    vehicleNumber: Joi.string().required().min(5),
    type: Joi.string()
      .required()
      .valid("CAR", "VAN", "HIJET", "KARVAN", "BUS"),
    make: Joi.string().optional().allow(null),
    model: Joi.string().optional().allow(null),
    year: Joi.string().optional().allow(null),
    capacity: Joi.number().required().min(1),
    vendorId: Joi.string().uuid().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("ACTIVE")
      .valid("ACTIVE", "INACTIVE", "MAINTENANCE", "BREAKDOWN"),
    notes: Joi.string().optional().allow(null),
  }),
});

const vehicleUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    vehicleNumber: Joi.string().optional().min(5),
    type: Joi.string()
      .optional()
      .valid("CAR", "VAN", "HIJET", "KARVAN", "BUS"),
    make: Joi.string().optional().allow(null),
    model: Joi.string().optional().allow(null),
    year: Joi.string().optional().allow(null),
    capacity: Joi.number().optional().min(1),
    vendorId: Joi.string().uuid().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("ACTIVE", "INACTIVE", "MAINTENANCE", "BREAKDOWN"),
    notes: Joi.string().optional().allow(null),
  }),
});

const driverCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    name: Joi.string().required().min(2).max(100),
    phone: Joi.string().optional().allow(null),
    licenseNumber: Joi.string().optional().allow(null),
    cnic: Joi.string().optional().allow(null),
    vendorId: Joi.string().uuid().optional().allow(null),
    shiftType: Joi.string()
      .optional()
      .default("TWELVE_HOUR")
      .valid("TWELVE_HOUR", "TWENTY_FOUR_HOUR"),
    shiftLabel: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("AVAILABLE")
      .valid("AVAILABLE", "ON_RIDE", "OFFLINE", "INACTIVE"),
    notes: Joi.string().optional().allow(null),
  }),
});

const driverUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    name: Joi.string().optional().min(2).max(100),
    phone: Joi.string().optional().allow(null),
    licenseNumber: Joi.string().optional().allow(null),
    cnic: Joi.string().optional().allow(null),
    vendorId: Joi.string().uuid().optional().allow(null),
    shiftType: Joi.string()
      .optional()
      .valid("TWELVE_HOUR", "TWENTY_FOUR_HOUR"),
    shiftLabel: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("AVAILABLE", "ON_RIDE", "OFFLINE", "INACTIVE"),
    notes: Joi.string().optional().allow(null),
  }),
});

const routeCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    routeCode: Joi.string().required().min(2).max(50),
    routeName: Joi.string().required().min(2).max(100),
    areaId: Joi.string().uuid().optional().allow(null),
    subAreaId: Joi.string().uuid().optional().allow(null),
    officeLocation: Joi.string()
      .optional()
      .valid("IBT_1", "IBT_2", "IBT_3", "SKY_TOWER")
      .allow(null),
    serviceType: Joi.string()
      .optional()
      .default("PICK_AND_DROP")
      .valid("PICK_AND_DROP", "DROP_ONLY", "PICK_ONLY"),
    maxCapacity: Joi.number().required().min(1),
    shiftTiming: Joi.string().optional().allow(null),
    pickupStartTime: Joi.date().optional().allow(null),
    dropTime: Joi.date().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("ACTIVE")
      .valid("ACTIVE", "INACTIVE"),
  }),
});

const routeUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    routeCode: Joi.string().optional().min(2).max(50),
    routeName: Joi.string().optional().min(2).max(100),
    areaId: Joi.string().uuid().optional().allow(null),
    subAreaId: Joi.string().uuid().optional().allow(null),
    officeLocation: Joi.string()
      .optional()
      .valid("IBT_1", "IBT_2", "IBT_3", "SKY_TOWER")
      .allow(null),
    serviceType: Joi.string()
      .optional()
      .valid("PICK_AND_DROP", "DROP_ONLY", "PICK_ONLY"),
    maxCapacity: Joi.number().optional().min(1),
    shiftTiming: Joi.string().optional().allow(null),
    pickupStartTime: Joi.date().optional().allow(null),
    dropTime: Joi.date().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    status: Joi.string().optional().valid("ACTIVE", "INACTIVE"),
  }),
});

const rideCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    rideDate: Joi.date().required(),
    routeId: Joi.string().uuid().required(),
    driverId: Joi.string().uuid().optional().allow(null),
    vehicleId: Joi.string().uuid().optional().allow(null),
    vendorId: Joi.string().uuid().optional().allow(null),
    areaId: Joi.string().uuid().optional().allow(null),
    pickupTime: Joi.string().optional().allow(null),
    dropTime: Joi.string().optional().allow(null),
    employeeId: Joi.string().uuid().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("PENDING")
      .valid("PENDING", "STARTED", "ARRIVED", "COMPLETED", "CANCELLED"),
  }),
});

const rideUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    rideDate: Joi.date().optional(),
    routeId: Joi.string().uuid().optional(),
    driverId: Joi.string().uuid().optional().allow(null),
    vehicleId: Joi.string().uuid().optional().allow(null),
    vendorId: Joi.string().uuid().optional().allow(null),
    areaId: Joi.string().uuid().optional().allow(null),
    pickupTime: Joi.string().optional().allow(null),
    dropTime: Joi.string().optional().allow(null),
    employeeId: Joi.string().uuid().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("PENDING", "STARTED", "ARRIVED", "COMPLETED", "CANCELLED"),
  }),
});

const attendanceCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    rideDate: Joi.date().required(),
    employeeId: Joi.string().uuid().required(),
    rideId: Joi.string().uuid().optional().allow(null),
    arrivalTime: Joi.date().optional().allow(null),
    delayMinutes: Joi.number().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("PRESENT")
      .valid("PRESENT", "LATE", "ABSENT", "NO_SHOW"),
  }),
});

const attendanceScanSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    employeeId: Joi.string().uuid().required(),
    driverQrCode: Joi.string().required(),
    rideDate: Joi.date().required(),
    rideId: Joi.string().uuid().optional().allow(null),
    arrivalTime: Joi.date().optional().allow(null),
    delayMinutes: Joi.number().optional().allow(null),
    status: Joi.string().optional().valid("PRESENT", "LATE", "ABSENT", "NO_SHOW"),
  }),
});

const attendanceUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    rideDate: Joi.date().optional(),
    employeeId: Joi.string().uuid().optional(),
    rideId: Joi.string().uuid().optional().allow(null),
    arrivalTime: Joi.date().optional().allow(null),
    delayMinutes: Joi.number().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("PRESENT", "LATE", "ABSENT", "NO_SHOW"),
  }),
});

const complaintCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    employeeId: Joi.string().uuid().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    vehicleId: Joi.string().uuid().optional().allow(null),
    rideId: Joi.string().uuid().optional().allow(null),
    category: Joi.string()
      .optional()
      .default("OTHER")
      .valid(
        "DRIVER_BEHAVIOUR",
        "VEHICLE_CONDITION",
        "ROUTE_ISSUE",
        "TIMING_DELAY",
        "SCHEDULING",
        "OTHER"
      ),
    title: Joi.string().required().min(2).max(200),
    description: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("OPEN")
      .valid("OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"),
  }),
});

const complaintUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    category: Joi.string()
      .optional()
      .valid(
        "DRIVER_BEHAVIOUR",
        "VEHICLE_CONDITION",
        "ROUTE_ISSUE",
        "TIMING_DELAY",
        "SCHEDULING",
        "OTHER"
      ),
    title: Joi.string().optional().min(2).max(200),
    description: Joi.string().optional().allow(null),
    resolution: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"),
  }),
});

const weeklyScheduleCreateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    weekStart: Joi.date().required(),
    employeeId: Joi.string().uuid().required(),
    routeId: Joi.string().uuid().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    vehicleId: Joi.string().uuid().optional().allow(null),
    serviceType: Joi.string()
      .optional()
      .default("PICK_AND_DROP")
      .valid("PICK_AND_DROP", "DROP_ONLY", "PICK_ONLY"),
    monday: Joi.string()
      .optional()
      .default("BOTH")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    tuesday: Joi.string()
      .optional()
      .default("BOTH")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    wednesday: Joi.string()
      .optional()
      .default("BOTH")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    thursday: Joi.string()
      .optional()
      .default("BOTH")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    friday: Joi.string()
      .optional()
      .default("BOTH")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    saturday: Joi.string()
      .optional()
      .default("OFF")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    sunday: Joi.string()
      .optional()
      .default("OFF")
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    pickupTime: Joi.string().optional().allow(null),
    shiftTiming: Joi.string().optional().allow(null),
    officeArrivalTime: Joi.string().optional().allow(null),
    dropTime: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .default("ACTIVE")
      .valid("ACTIVE", "DRAFT", "CANCELLED"),
  }),
});

const weeklyScheduleUpdateSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    id: Joi.string().uuid().required(),
  }),
  body: Joi.object({
    routeId: Joi.string().uuid().optional().allow(null),
    driverId: Joi.string().uuid().optional().allow(null),
    vehicleId: Joi.string().uuid().optional().allow(null),
    serviceType: Joi.string()
      .optional()
      .valid("PICK_AND_DROP", "DROP_ONLY", "PICK_ONLY"),
    monday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    tuesday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    wednesday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    thursday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    friday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    saturday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    sunday: Joi.string()
      .optional()
      .valid("PICKUP", "DROP", "BOTH", "OFF", "ABSENT"),
    pickupTime: Joi.string().optional().allow(null),
    shiftTiming: Joi.string().optional().allow(null),
    officeArrivalTime: Joi.string().optional().allow(null),
    dropTime: Joi.string().optional().allow(null),
    status: Joi.string()
      .optional()
      .valid("ACTIVE", "DRAFT", "CANCELLED"),
  }),
});

module.exports = {
  
  areaCreateSchema,
  areaUpdateSchema,
  areaIdSchema,
  subAreaCreateSchema,
  subAreaUpdateSchema,
  subAreaIdSchema,
  blockCreateSchema,
  blockUpdateSchema,
  blockIdSchema,
  departmentCreateSchema,
  departmentUpdateSchema,
  departmentIdSchema,
  
  employeeCreateSchema,
  employeeUpdateSchema,
  employeeIdSchema,
  
  vendorCreateSchema,
  vendorUpdateSchema,
  vendorIdSchema,
  
  vehicleCreateSchema,
  vehicleUpdateSchema,
  
  driverCreateSchema,
  driverUpdateSchema,
  
  routeCreateSchema,
  routeUpdateSchema,
  
  rideCreateSchema,
  rideUpdateSchema,
  
  attendanceCreateSchema,
  attendanceScanSchema,
  attendanceUpdateSchema,
  
  complaintCreateSchema,
  complaintUpdateSchema,
  
  weeklyScheduleCreateSchema,
  weeklyScheduleUpdateSchema,
};
