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
  createSuccessResponse,
} = require("../../../constants/responses");

const createDepartment = async (req, res, next) => {
  try {
    const { name } = req.body;

    // Validate name
    if (!name || !name.trim()) {
      const response = badRequestResponse("Department name is required.");
      return res.status(response.status.code).json(response);
    }

    const trimmedName = name.trim();

    const existingDepartment = await prisma.department.findUnique({
      where: { name: trimmedName },
    });
    if (existingDepartment) {
      const response = badRequestResponse(
        "Department with this name already exists.",
      );
      return res.status(response.status.code).json(response);
    }

    const department = await prisma.department.create({
      data: { name: trimmedName },
    });

    const response = createSuccessResponse(
      department,
      "Department created successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getAllDepartments = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    const [departments, total] = await Promise.all([
      prisma.department.findMany({
        where,
        skip,
        take,
        include: {
          _count: {
            select: { employees: true },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.department.count({ where }),
    ]);

    // Map departments to include employee count
    const departmentsWithCount = departments.map((dept) => ({
      ...dept,
      employeeCount: dept._count.employees,
      _count: undefined, // Remove _count from response
    }));

    const response = okResponse(
      {
        departments: departmentsWithCount,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNextPage: parseInt(page) < Math.ceil(total / take),
          hasPrevPage: parseInt(page) > 1,
        },
      },
      "Departments retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const getDepartmentById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const department = await prisma.department.findUnique({
      where: { id },
      include: {
        employees: {
          select: {
            id: true,
            employeeCode: true,
            name: true,
            designation: true,
            status: true,
          },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: { employees: true },
        },
      },
    });

    if (!department) {
      const errorResponse = badRequestResponse("Department not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    const departmentWithCount = {
      ...department,
      employeeCount: department._count.employees,
      _count: undefined,
    };

    const response = okResponse(
      departmentWithCount,
      "Department retrieved successfully.",
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const updateDepartment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    // Validate name
    if (!name || !name.trim()) {
      const response = badRequestResponse("Department name is required.");
      return res.status(response.status.code).json(response);
    }

    const trimmedName = name.trim();

    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) {
      const errorResponse = badRequestResponse("Department not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (trimmedName !== department.name) {
      const existingDepartment = await prisma.department.findUnique({
        where: { name: trimmedName },
      });
      if (existingDepartment) {
        const errorResponse = badRequestResponse(
          "Department with this name already exists.",
        );
        return res.status(errorResponse.status.code).json(errorResponse);
      }
    }

    const updatedDepartment = await prisma.department.update({
      where: { id },
      data: { name: trimmedName },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    const departmentWithCount = {
      ...updatedDepartment,
      employeeCount: updatedDepartment._count.employees,
      _count: undefined,
    };

    const response = okResponse(
      departmentWithCount,
      "Department updated successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
    next(error);
  }
};

const deleteDepartment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const department = await prisma.department.findUnique({
      where: { id },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    if (!department) {
      const errorResponse = badRequestResponse("Department not found.");
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    if (department._count.employees > 0) {
      const errorResponse = badRequestResponse(
        `Cannot delete department. It has ${department._count.employees} assigned employee(s). Remove or reassign employees first.`,
      );
      return res.status(errorResponse.status.code).json(errorResponse);
    }

    await prisma.department.delete({
      where: { id },
    });

    const response = okResponse(
      { id, name: department.name },
      "Department deleted successfully.",
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    console.log('error', error);
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