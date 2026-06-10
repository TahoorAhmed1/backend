

const { prisma } = require("../../../lib/prisma");
const {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
} = require("../../../utils/crudHelper");
const { badRequestResponse, okResponse } = require("../../../constants/responses");

const createVendor = async (req, res, next) => {
  try {
    const { name, shortName, contactPerson, phone, email, status } = req.body;

    
    const existingVendor = await prisma.vendor.findUnique({
      where: { name },
    });

    if (existingVendor) {
      const response = badRequestResponse("Vendor with this name already exists.");
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.vendor, {
      name,
      shortName,
      contactPerson,
      phone,
      email,
      status: status || "ACTIVE",
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllVendors = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, status } = req.query;

    const where = {};
    if (status) where.status = status;

    const options = {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        vehicles: { select: { id: true, vehicleNumber: true } },
        drivers: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    };

    const response = await getRecords(prisma.vendor, options);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getVendorById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const response = await getRecordById(prisma.vendor, id, {
      vehicles: true,
      drivers: true,
      rides: { select: { id: true, rideDate: true } },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
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

    
    if (updateData.name && updateData.name !== vendor.name) {
      const existingName = await prisma.vendor.findUnique({
        where: { name: updateData.name },
      });
      if (existingName) {
        const errorResponse = badRequestResponse("Vendor name already exists.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.vendor, id, updateData);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteVendor = async (req, res, next) => {
  try {
    const { id } = req.params;

    
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        vehicles: true,
        drivers: true,
        rides: true,
      },
    });

    if (!vendor) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    
    if (vendor.vehicles.length > 0 || vendor.drivers.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete vendor with active vehicles or drivers."
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.vendor, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getVendorVehicles = async (req, res, next) => {
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
      },
    });

    if (!vendor) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        vendorId: vendor.id,
        vendorName: vendor.name,
        vehicles: vendor.vehicles,
      },
      "Vendor vehicles retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getVendorDrivers = async (req, res, next) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        drivers: {
          include: {
            vehicle: { select: { id: true, vehicleNumber: true } },
          },
        },
      },
    });

    if (!vendor) {
      const errorResponse = badRequestResponse("Vendor not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = okResponse(
      {
        vendorId: vendor.id,
        vendorName: vendor.name,
        drivers: vendor.drivers,
      },
      "Vendor drivers retrieved successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
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
