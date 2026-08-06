const {
  okResponse,
  createSuccessResponse,
  updateSuccessResponse,
  deleteSuccessResponse,
  badRequestResponse,
  serverErrorResponse,
} = require("../constants/responses");

const createRecord = async (prismaModel, data) => {
  try {
    const record = await prismaModel.create({ data });
    return createSuccessResponse(record, "Record created successfully.");
  } catch (error) {
    // Handle Prisma unique constraint error (P2002) and return a bad request response
    if (
      error &&
      error.name === "PrismaClientKnownRequestError" &&
      error.code === "P2002"
    ) {
      let fields = null;
      if (Array.isArray(error.meta?.target)) fields = error.meta.target;
      else if (Array.isArray(error.meta?.fields)) fields = error.meta.fields;
      else if (Array.isArray(error.meta?.driverAdapterError?.cause?.constraint?.fields))
        fields = error.meta.driverAdapterError.cause.constraint.fields;

      const fieldList = fields ? fields.join(", ") : "field";
      return badRequestResponse(
        `Unique constraint failed on the fields: (${fieldList})`
      );
    }

    return serverErrorResponse(error?.message || "Internal server error");
  }
};

const getRecords = async (prismaModel, options = {}) => {
  try {
    const { where, include, orderBy, skip, take } = options;

    const [data, count] = await Promise.all([
      prismaModel.findMany({
        where,
        include,
        orderBy,
        skip,
        take,
      }),
      prismaModel.count({ where }),
    ]);

    return okResponse(
      {
        data,
        pagination: {
          total: count,
          limit: take || count,
          offset: skip || 0,
        },
      },
      "Records retrieved successfully.",
    );
  } catch (error) {
    throw error;
  }
};

const getRecordById = async (prismaModel, id, include = {}) => {
  try {
    const record = await prismaModel.findUnique({
      where: { id },
      include,
    });

    if (!record) {
      return null;
    }

    return okResponse(record, "Record retrieved successfully.");
  } catch (error) {
    throw error;
  }
};

const updateRecord = async (prismaModel, id, data, include = {}) => {
  try {
    const record = await prismaModel.update({
      where: { id },
      data,
      include,
    });

    return updateSuccessResponse(record, "Record updated successfully.");
  } catch (error) {
    // Handle Prisma unique constraint error (P2002) and return a bad request response
    if (
      error &&
      error.name === "PrismaClientKnownRequestError" &&
      error.code === "P2002"
    ) {
      let fields = null;
      if (Array.isArray(error.meta?.target)) fields = error.meta.target;
      else if (Array.isArray(error.meta?.fields)) fields = error.meta.fields;
      else if (Array.isArray(error.meta?.driverAdapterError?.cause?.constraint?.fields))
        fields = error.meta.driverAdapterError.cause.constraint.fields;

      const fieldList = fields ? fields.join(", ") : "field";
      return badRequestResponse(
        `Unique constraint failed on the fields: (${fieldList})`
      );
    }

    return serverErrorResponse(error?.message || "Internal server error");
  }
};

const deleteRecord = async (prismaModel, id) => {
  try {
    const record = await prismaModel.delete({
      where: { id },
    });

    return deleteSuccessResponse(record, "Record deleted successfully.");
  } catch (error) {
    throw error;
  }
};

const bulkCreateRecords = async (prismaModel, dataArray) => {
  try {
    const records = await prismaModel.createMany({
      data: dataArray,
      skipDuplicates: true,
    });

    return createSuccessResponse(
      records,
      `${records.count} records created successfully.`,
    );
  } catch (error) {
    throw error;
  }
};

const findRecordByField = async (prismaModel, where, include = {}) => {
  try {
    const record = await prismaModel.findFirst({
      where,
      include,
    });

    if (!record) {
      return null;
    }

    return okResponse(record, "Record retrieved successfully.");
  } catch (error) {
    throw error;
  }
};

module.exports = {
  createRecord,
  getRecords,
  getRecordById,
  updateRecord,
  deleteRecord,
  bulkCreateRecords,
  findRecordByField,
};
