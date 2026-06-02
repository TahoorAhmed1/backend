const { prisma } = require("../../../lib/prisma");
const {
  createSuccessResponse,
  okResponse,
  updateSuccessResponse,
  deleteSuccessResponse,
  badRequestResponse,
} = require("../../../constants/responses");

const createTask = async (req, res, next) => {
  const { userId, userRole } = req.user;
  const { title, description, userId: assignToUserId } = req.body;

  try {
    if (userRole !== "admin") {
      return res.status(403).json(badRequestResponse("Only admins can create tasks."));
    }

    const task = await prisma.task.create({
      data: {
        title,
        description: description ?? null,
        userId: assignToUserId || null,  // Assign to user on creation
        createdBy: userId,                // Track which admin created the task
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
  const { userId, userRole } = req.user;

  try {
    const where = {};
    if (userRole !== "admin") {
      where.userId = userId;
    }



    const tasks = await prisma.task.findMany({
      where,

      orderBy: { createdAt: "desc" },
    });


    const response = okResponse({
      tasks,

    });
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTaskById = async (req, res, next) => {
  const { userId, userRole } = req.user;
  const { taskId } = req.params;

  try {
    const task = await prisma.task.findUnique({
      where: { id: parseInt(taskId) },
    });

    // Admins can view any task, users can only view their assigned tasks
    if (!task || (userRole !== "admin" && task.userId !== userId)) {
      return res.status(404).json(badRequestResponse("Task not found."));
    }

    const response = okResponse(task);
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const updateTask = async (req, res, next) => {
  const { userId, userRole } = req.user;
  const { taskId } = req.params;
  const { title, description, status, userId: assignToUserId } = req.body;

  try {
    const task = await prisma.task.findUnique({
      where: { id: parseInt(taskId) },
    });

    if (!task) {
      return res.status(404).json(badRequestResponse("Task not found."));
    }

    // Authorization: only admins can update any task, users can only update their own
    if (userRole !== "admin" && task.userId !== userId) {
      return res.status(403).json(badRequestResponse("Unauthorized to update this task."));
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (status !== undefined) updateData.status = status;

    // Only admins can assign tasks to users
    if (assignToUserId !== undefined && userRole === "admin") {
      updateData.userId = assignToUserId;
    }

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
  const { userId, userRole } = req.user;
  const { taskId } = req.params;

  try {
    const task = await prisma.task.findUnique({
      where: { id: parseInt(taskId) },
    });

    if (!task) {
      return res.status(404).json(badRequestResponse("Task not found."));
    }

    // Only admins can delete tasks
    if (userRole !== "admin") {
      return res.status(403).json(badRequestResponse("Only admins can delete tasks."));
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
