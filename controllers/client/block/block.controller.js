const { prisma } = require("../../../lib/prisma");
const { createRecord, getRecords, getRecordById, updateRecord, deleteRecord } = require("../../../utils/crudHelper");
const { badRequestResponse } = require("../../../constants/responses");

const createBlock = async (req, res, next) => {
  try {
    const { name, subAreaId } = req.body;

    const existingBlock = await prisma.block.findFirst({ where: { name, subAreaId } });
    if (existingBlock) {
      const response = badRequestResponse("Block with this name already exists in the selected sub-area.");
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.block, { name, subAreaId });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getAllBlocks = async (req, res, next) => {
  try {
    const { skip = 0, take = 10, subAreaId } = req.query;
    const where = {};
    if (subAreaId) where.subAreaId = subAreaId;

    const response = await getRecords(prisma.block, {
      where,
      skip: parseInt(skip),
      take: parseInt(take),
      include: {
        subArea: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getBlockById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const response = await getRecordById(prisma.block, id, {
      subArea: {
        include: { area: true },
      },
      employees: { select: { id: true, employeeCode: true, name: true } },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Block not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateBlock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, subAreaId } = req.body;

    const block = await prisma.block.findUnique({ where: { id } });
    if (!block) {
      const errorResponse = badRequestResponse("Block not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (name && subAreaId && (name !== block.name || subAreaId !== block.subAreaId)) {
      const existingBlock = await prisma.block.findFirst({ where: { name, subAreaId } });
      if (existingBlock) {
        const errorResponse = badRequestResponse("Block with this name already exists in the selected sub-area.");
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.block, id, { name, subAreaId });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteBlock = async (req, res, next) => {
  try {
    const { id } = req.params;

    const block = await prisma.block.findUnique({ where: { id }, include: { employees: true } });
    if (!block) {
      const errorResponse = badRequestResponse("Block not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (block.employees.length > 0) {
      const errorResponse = badRequestResponse("Cannot delete block with assigned employees.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.block, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createBlock,
  getAllBlocks,
  getBlockById,
  updateBlock,
  deleteBlock,
};
