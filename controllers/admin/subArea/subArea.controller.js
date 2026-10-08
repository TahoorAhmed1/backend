const { prisma } = require("../../../lib/prisma");
const { createRecord, getRecords, getRecordById, updateRecord, deleteRecord } = require("../../../utils/crudHelper");
const { badRequestResponse } = require("../../../constants/responses");

const createSubArea = async (req, res, next) => {
  try {
    const { name, areaId } = req.body;

    const existingSubArea = await prisma.subArea.findFirst({ where: { name, areaId } });
    if (existingSubArea) {
      const response = badRequestResponse("SubArea with this name already exists in the selected area.");
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.subArea, { name, areaId });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllSubAreas = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, areaId } = req.query;
    const where = {};
    if (areaId) where.areaId = areaId;

    const response = await getRecords(prisma.subArea, {
      where,
  
      include: {
        area: { select: { id: true, name: true } },
        blocks: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getSubAreaById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const response = await getRecordById(prisma.subArea, id, {
      area: true,
      blocks: true,
      employees: { select: { id: true, employeeCode: true, name: true } },
      routes: { select: { id: true, routeCode: true, routeName: true } },
    });

    if (!response) {
      const errorResponse = badRequestResponse("SubArea not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateSubArea = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, areaId } = req.body;

    const subArea = await prisma.subArea.findUnique({ where: { id } });
    if (!subArea) {
      const errorResponse = badRequestResponse("SubArea not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (name && areaId && (name !== subArea.name || areaId !== subArea.areaId)) {
      const existingSubArea = await prisma.subArea.findFirst({ where: { name, areaId } });
      if (existingSubArea) {
        const errorResponse = badRequestResponse("SubArea with this name already exists in the selected area.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.subArea, id, { name, areaId });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteSubArea = async (req, res, next) => {
  try {
    const { id } = req.params;

    const subArea = await prisma.subArea.findUnique({ where: { id }, include: { blocks: true, employees: true, routes: true } });
    if (!subArea) {
      const errorResponse = badRequestResponse("SubArea not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (subArea.blocks.length > 0 || subArea.employees.length > 0 || subArea.routes.length > 0) {
      const errorResponse = badRequestResponse("Cannot delete subArea with linked blocks, employees, or routes.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.subArea, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createSubArea,
  getAllSubAreas,
  getSubAreaById,
  updateSubArea,
  deleteSubArea,
};
