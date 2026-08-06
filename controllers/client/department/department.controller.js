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
} = require("../../../constants/responses");

const createDepartment = async (req, res, next) => {
  try {
    const { name } = req.body;

    const existingDepartment = await prisma.department.findUnique({
      where: { name },
    });
    if (existingDepartment) {
      const response = badRequestResponse(
        "Department with this name already exists.",
      );
      return res.status(response.status.code).json(response);
    }

    const response = await createRecord(prisma.department, { name });
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error)
    next(error);
  }
};

const getAllDepartments = async (req, res, next) => {
  try {
    const { skip = 0, take = 10 } = req.query;
    const departments = await prisma.department.findMany({
      skip: parseInt(skip),
      take: parseInt(take),

      orderBy: { createdAt: "desc" },
    });
    const response = okResponse(
      departments,
      "Departments retrieved successfully.",
    );
    console.log('response', response)
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getDepartmentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const response = await getRecordById(prisma.department, id, {
      employees: { select: { id: true, employeeCode: true, name: true } },
    });

    if (!response) {
      const errorResponse = badRequestResponse("Department not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateDepartment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) {
      const errorResponse = badRequestResponse("Department not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (name && name !== department.name) {
      const existingDepartment = await prisma.department.findUnique({
        where: { name },
      });
      if (existingDepartment) {
        const errorResponse = badRequestResponse(
          "Department with this name already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const response = await updateRecord(prisma.department, id, { name });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteDepartment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const department = await prisma.department.findUnique({
      where: { id },
      include: { employees: true },
    });

    if (!department) {
      const errorResponse = badRequestResponse("Department not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (department.employees.length > 0) {
      const errorResponse = badRequestResponse(
        "Cannot delete department with assigned employees.",
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const response = await deleteRecord(prisma.department, id);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createDepartment,
  getAllDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,
};  