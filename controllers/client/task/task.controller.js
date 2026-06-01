const { prisma } = require("../../../configs/prisma");
const {
  createSuccessResponse,
  okResponse,
  updateSuccessResponse,
  deleteSuccessResponse,
  badRequestResponse,
} = require("../../../constants/responses");

const createTask = async (req, res, next) => {
  const { userId } = req.user;
  const { title, description } = req.body;

  try {
    const task = await prisma.task.create({
      data: {
        title,
        description: description || null,
        userId,
        status: "todo",
        updatedBy: userId,
      },
    });

    const io = req.app.get("io");
    io.emit("task:updated", {
      action: "created",
      task,
    });

    const response = createSuccessResponse(task, "Task created successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTasks = async (req, res, next) => {
  const { userId } = req.user;
  const { status, limit = 10, offset = 0 } = req.query;

  try {
    const where = { userId };

    if (status) {
      where.status = status;
    }

    const tasks = await prisma.task.findMany({
      where,
      take: parseInt(limit),
      skip: parseInt(offset),
      orderBy: {
        createdAt: "desc",
      },
    });

    const total = await prisma.task.count({ where });

    const response = okResponse({
      tasks,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTaskById = async (req, res, next) => {
  const { userId } = req.user;
  const { taskId } = req.params;

  try {
    const task = await prisma.task.findUnique({
      where: { id: parseInt(taskId) },
    });

    if (!task || task.userId !== userId) {
      return res.status(404).json(badRequestResponse("Task not found."));
    }

    const response = okResponse(task);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateTask = async (req, res, next) => {
  const { userId } = req.user;
  const { taskId } = req.params;
  const { title, description, status } = req.body;

  try {
    const task = await prisma.task.findUnique({
      where: { id: parseInt(taskId) },
    });

    if (!task || task.userId !== userId) {
      return res.status(404).json(badRequestResponse("Task not found."));
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (status !== undefined) updateData.status = status;
    updateData.updatedBy = userId;

    const updatedTask = await prisma.task.update({
      where: { id: parseInt(taskId) },
      data: updateData,
    });

    const io = req.app.get("io");
    io.emit("task:updated", {
      action: "updated",
      task: updatedTask,
    });

    const response = updateSuccessResponse(
      updatedTask,
      "Task updated successfully."
    );
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const deleteTask = async (req, res, next) => {
  const { userId } = req.user;
  const { taskId } = req.params;

  try {
    const task = await prisma.task.findUnique({
      where: { id: parseInt(taskId) },
    });

    if (!task || task.userId !== userId) {
      return res.status(404).json(badRequestResponse("Task not found."));
    }

    await prisma.task.delete({
      where: { id: parseInt(taskId) },
    });

    // Emit Socket.io event
    const io = req.app.get("io");
    io.emit("task:updated", {
      action: "deleted",
      taskId: parseInt(taskId),
    });

    const response = deleteSuccessResponse({}, "Task deleted successfully.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createTask,
  getTasks,
  getTaskById,
  updateTask,
  deleteTask,
};
