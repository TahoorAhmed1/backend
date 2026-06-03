const { prisma } = require("../../../lib/prisma");

const {
  createSuccessResponse,
  okResponse,
  updateSuccessResponse,
  deleteSuccessResponse,
  badRequestResponse,
} = require("../../../constants/responses");

const createHistoryEntry = (
  tx,
  taskId,
  changedById,
  field,
  oldValue,
  newValue
) => {
  const oldVal = oldValue == null ? null : String(oldValue);
  const newVal = newValue == null ? null : String(newValue);

  if (oldVal === newVal) return null;

  return tx.taskHistory.create({
    data: {
      taskId,
      changedById,
      field,
      oldValue: oldVal,
      newValue: newVal,
    },
  });
};

const validateAssignedUser = async (userId) => {
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  return user;
};

const createTask = async (req, res, next) => {
  const { userId, userRole } = req.user;

  const {
    title,
    description,
    status,
    userId: assignedUserId,
  } = req.body;

  let normalizedStatus = null;
  if (status !== undefined) {
    normalizedStatus = normalizeStatus(status);
    if (!normalizedStatus) {
      return res
        .status(400)
        .json(badRequestResponse('Invalid status. Allowed: todo, in_progress, completed, cancelled'));
    }
  }

  try {
    if (userRole !== "admin") {
      return res
        .status(403)
        .json(badRequestResponse("Only admins can create tasks."));
    }

    if (!title) {
      return res
        .status(400)
        .json(badRequestResponse("Title is required."));
    }

    const normalizedStatus = normalizeStatus(status);
    if (status && !normalizedStatus) {
      return res
        .status(400)
        .json(badRequestResponse('Invalid status. Allowed: todo, in_progress, completed, cancelled'));
    }

    if (assignedUserId) {
      const assignedUser = await validateAssignedUser(assignedUserId);

      if (!assignedUser) {
        return res
          .status(404)
          .json(badRequestResponse("Assigned user not found."));
      }
    }

    const task = await prisma.task.create({
      data: {
        title,
        description: description || null,
        status: normalizedStatus || "todo",
        userId: assignedUserId || null,
        createdBy: userId,
        updatedById: userId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        admin: {
          select: {
            id: true,
            name: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await prisma.taskHistory.create({
      data: {
        taskId: task.id,
        changedById: userId,
        field: "status",
        oldValue: null,
        newValue: task.status,
      },
    });

    req.app.get("io").emit("task:created", task);

    const response = createSuccessResponse(
      task,
      "Task created successfully."
    );

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
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        admin: {
          select: {
            id: true,
            name: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const response = okResponse({ tasks });

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTaskById = async (req, res, next) => {
  const { userId, userRole } = req.user;
  const taskId = Number(req.params.taskId);

  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        admin: {
          select: {
            id: true,
            name: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            name: true,
          },
        },
        history: {
          include: {
            changedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!task) {
      return res
        .status(404)
        .json(badRequestResponse("Task not found."));
    }

    if (
      userRole !== "admin" &&
      task.userId !== userId
    ) {
      return res
        .status(403)
        .json(badRequestResponse("Unauthorized."));
    }

    const response = okResponse(task);

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};
const updateTask = async (req, res, next) => {
  const { userId, userRole } = req.user;
  const taskId = Number(req.params.taskId);

  const {
    title,
    description,
    status,
    userId: assignedUserId,
  } = req.body;

  let normalizedStatus = undefined;

  if (status !== undefined) {
    normalizedStatus = normalizeStatus(status);

    if (!normalizedStatus) {
      return res.status(400).json(
        badRequestResponse(
          "Invalid status. Allowed: todo, in_progress, completed, cancelled"
        )
      );
    }
  }

  try {
    if (userRole !== "admin") {
      if (
        title !== undefined ||
        description !== undefined ||
        assignedUserId !== undefined
      ) {
        return res.status(403).json(
          badRequestResponse("Users can only update status.")
        );
      }
    }

    if (assignedUserId && userRole === "admin") {
      const assignedUser = await validateAssignedUser(
        assignedUserId
      );

      if (!assignedUser) {
        return res.status(404).json(
          badRequestResponse("Assigned user not found.")
        );
      }
    }

    const task = await prisma.$transaction(
      async (tx) => {
        const current = await tx.task.findUnique({
          where: { id: taskId },
        });

        if (!current) {
          throw new Error("TASK_NOT_FOUND");
        }

        if (
          userRole !== "admin" &&
          current.userId !== userId
        ) {
          throw new Error("UNAUTHORIZED");
        }

        const updateData = {
          updatedById: userId,
        };

        if (title !== undefined) {
          updateData.title = title;
        }

        if (description !== undefined) {
          updateData.description = description;
        }

        if (status !== undefined) {
          updateData.status = normalizedStatus;
        }

        if (
          assignedUserId !== undefined &&
          userRole === "admin"
        ) {
          updateData.userId = assignedUserId;
        }

        const updatedTask = await tx.task.update({
          where: { id: taskId },
          data: updateData,
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            admin: {
              select: {
                id: true,
                name: true,
              },
            },
            updatedBy: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        const historyEntries = [];

        if (title !== undefined) {
          const entry = createHistoryEntry(
            tx,
            taskId,
            userId,
            "title",
            current.title,
            title
          );

          if (entry) historyEntries.push(entry);
        }

        if (description !== undefined) {
          const entry = createHistoryEntry(
            tx,
            taskId,
            userId,
            "description",
            current.description,
            description
          );

          if (entry) historyEntries.push(entry);
        }

        if (status !== undefined) {
          const entry = createHistoryEntry(
            tx,
            taskId,
            userId,
            "status",
            current.status,
            normalizedStatus
          );

          if (entry) historyEntries.push(entry);
        }

        if (
          assignedUserId !== undefined &&
          userRole === "admin"
        ) {
          const entry = createHistoryEntry(
            tx,
            taskId,
            userId,
            "assignedUser",
            current.userId,
            assignedUserId
          );

          if (entry) historyEntries.push(entry);
        }

        if (historyEntries.length) {
          await Promise.all(historyEntries);
        }

        return updatedTask;
      },
      {
        maxWait: 10000,
        timeout: 15000,
      }
    );

    req.app.get("io").emit("task:updated", task);

    const response = updateSuccessResponse(
      task,
      "Task updated successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    if (error.message === "TASK_NOT_FOUND") {
      return res
        .status(404)
        .json(badRequestResponse("Task not found."));
    }

    if (error.message === "UNAUTHORIZED") {
      return res
        .status(403)
        .json(badRequestResponse("Unauthorized."));
    }

    console.error("Update task error:", error);
    next(error);
  }
};

const deleteTask = async (req, res, next) => {
  const { userRole } = req.user;
  const taskId = Number(req.params.taskId);

  try {
    if (userRole !== "admin") {
      return res
        .status(403)
        .json(
          badRequestResponse(
            "Only admins can delete tasks."
          )
        );
    }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res
        .status(404)
        .json(badRequestResponse("Task not found."));
    }

    await prisma.task.delete({
      where: { id: taskId },
    });

    req.app.get("io").emit("task:deleted", { taskId });

    const response = deleteSuccessResponse(
      {},
      "Task deleted successfully."
    );

    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

const getTaskHistory = async (req, res, next) => {
  const { userId, userRole } = req.user;
  const taskId = Number(req.params.taskId);

  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res
        .status(404)
        .json(badRequestResponse("Task not found."));
    }

    if (
      userRole !== "admin" &&
      task.userId !== userId
    ) {
      return res
        .status(403)
        .json(badRequestResponse("Unauthorized."));
    }

    const history = await prisma.taskHistory.findMany({
      where: {
        taskId,
      },
      include: {
        changedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    const response = okResponse({
      history,
    });

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
  getTaskHistory,
};

const STATUS_MAP = {
  todo: "todo",
  "to-do": "todo",
  "in_progress": "in_progress",
  "in-progress": "in_progress",
  "in progress": "in_progress",
  inprogress: "in_progress",
  completed: "completed",
  done: "completed",
  finished: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const normalizeStatus = (s) => {
  if (s == null) return null;
  const key = String(s).trim().toLowerCase();
  return STATUS_MAP[key] || null;
};