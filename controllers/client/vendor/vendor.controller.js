const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { 
  badRequestResponse, 
  okResponse, 
  createSuccessResponse 
} = require("../../../constants/responses");

const createVendor = async (req, res, next) => {
  try {
    const { name, shortName, contactPerson, phone, email, status } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      const response = badRequestResponse("Vendor name is required.");
      return res.status(response.status.code).json(response);
    }

    const trimmedName = name.trim();

    // Check if vendor exists
    const existingVendor = await prisma.vendor.findUnique({
      where: { name: trimmedName },
    });

    if (existingVendor) {
      const response = badRequestResponse("Vendor with this name already exists.");
      return res.status(response.status.code).json(response);
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const response = badRequestResponse("Invalid email format.");
      return res.status(response.status.code).json(response);
    }

    const vendor = await prisma.vendor.create({
      data: {
        name: trimmedName,
        shortName: shortName?.trim() || null,
        contactPerson: contactPerson?.trim() || null,
        phone: phone?.trim() || null,
        email: email?.toLowerCase().trim() || null,
        status: status || "ACTIVE",
      },
    });

    const response = createSuccessResponse(
      vendor,
      "Vendor created successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getAllVendors = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    // Filters
    if (status) where.status = status;

    // Search functionality
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { shortName: { contains: search, mode: "insensitive" } },
        { contactPerson: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        skip,
        take,
        include: {
          _count: {
            select: {
              vehicles: true,
              drivers: true,
              rides: true,
              weeklySchedules: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.vendor.count({ where }),
    ]);

    // Map vendors to include counts
    const vendorsWithCounts = vendors.map((vendor) => ({
      ...vendor,
      vehicleCount: vendor._count.vehicles,
      driverCount: vendor._count.drivers,
      rideCount: vendor._count.rides,
      scheduleCount: vendor._count.weeklySchedules,
      _count: undefined,
    }));

    const response = okResponse(
      {
        vendors: vendorsWithCounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Vendors retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getVendorById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        vehicles: {
          include: {
            driver: { select: { id: true, name: true } },
          },
        },
        drivers: {
          include: {
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
        rides: {
          take: 10,
          orderBy: { rideDate: "desc" },
          include: {
            route: { select: { id: true, routeName: true } },
          },
        },
        weeklySchedules: {
          take: 10,
          orderBy: { weekStart: "desc" },
        },
        _count: {
          select: {
            vehicles: true,
            drivers: true,
            rides: true,
            weeklySchedules: true,
          },
        },
      },
    });

    if (!vendor) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const vendorWithCounts = {
      ...vendor,
      vehicleCount: vendor._count.vehicles,
      driverCount: vendor._count.drivers,
      rideCount: vendor._count.rides,
      scheduleCount: vendor._count.weeklySchedules,
      _count: undefined,
    };

    const response = okResponse(
      vendorWithCounts,
      "Vendor retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const updateVendor = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const vendor = await prisma.vendor.findUnique({ where: { id } });
    if (!vendor) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check name uniqueness
    if (updateData.name && updateData.name.trim() !== vendor.name) {
      const trimmedName = updateData.name.trim();
      const existingName = await prisma.vendor.findUnique({
        where: { name: trimmedName },
      });
      if (existingName) {
        const errorResponse = badRequestResponse("Vendor name already exists.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
      updateData.name = trimmedName;
    }

    // Validate email format if provided
    if (updateData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updateData.email)) {
      const errorResponse = badRequestResponse("Invalid email format.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Normalize data
    if (updateData.name) updateData.name = updateData.name.trim();
    if (updateData.shortName) updateData.shortName = updateData.shortName.trim();
    if (updateData.contactPerson) updateData.contactPerson = updateData.contactPerson.trim();
    if (updateData.phone) updateData.phone = updateData.phone.trim();
    if (updateData.email) updateData.email = updateData.email.toLowerCase().trim();

    const updatedVendor = await prisma.vendor.update({
      where: { id },
      data: updateData,
      include: {
        _count: {
          select: {
            vehicles: true,
            drivers: true,
            rides: true,
          },
        },
      },
    });

    const vendorWithCounts = {
      ...updatedVendor,
      vehicleCount: updatedVendor._count.vehicles,
      driverCount: updatedVendor._count.drivers,
      rideCount: updatedVendor._count.rides,
      _count: undefined,
    };

    const response = okResponse(
      vendorWithCounts,
      "Vendor updated successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const deleteVendor = async (req, res, next) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            vehicles: true,
            drivers: true,
            rides: true,
            weeklySchedules: true,
          },
        },
      },
    });

    if (!vendor) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    // Check for dependent records
    const blocking = [];
    if (vendor._count.vehicles > 0) blocking.push(`${vendor._count.vehicles} vehicle(s)`);
    if (vendor._count.drivers > 0) blocking.push(`${vendor._count.drivers} driver(s)`);
    if (vendor._count.rides > 0) blocking.push(`${vendor._count.rides} ride(s)`);
    if (vendor._count.weeklySchedules > 0) blocking.push(`${vendor._count.weeklySchedules} schedule(s)`);

    if (blocking.length > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete vendor: referenced by ${blocking.join(", ")}. Remove related records first.`
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const deletedVendor = await prisma.vendor.delete({
      where: { id },
    });

    const response = okResponse(
      { id: deletedVendor.id, name: deletedVendor.name },
      "Vendor deleted successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getVendorVehicles = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status, search } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { vendorId: id };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { vehicleNumber: { contains: search, mode: "insensitive" } },
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
      ];
    }

    const [vehicles, total] = await Promise.all([
      prisma.vehicle.findMany({
        where,
        skip,
        take,
        include: {
          driver: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.vehicle.count({ where }),
    ]);

    const response = okResponse(
      {
        vendorId: id,
        vehicles,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Vendor vehicles retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getVendorDrivers = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, status, search } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { vendorId: id };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { cnic: { contains: search, mode: "insensitive" } },
        { licenseNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const [drivers, total] = await Promise.all([
      prisma.driver.findMany({
        where,
        skip,
        take,
        include: {
          vehicle: { select: { id: true, vehicleNumber: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.driver.count({ where }),
    ]);

    const response = okResponse(
      {
        vendorId: id,
        drivers,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Vendor drivers retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

module.exports = {
  createVendor,
  getAllVendors,
  getVendorById,
  updateVendor,
  deleteVendor,
  getVendorVehicles,
  getVendorDrivers,
};