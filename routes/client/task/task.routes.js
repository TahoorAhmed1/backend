const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");

const {
    createTaskSchema,
    updateTaskSchema,
    queryTaskSchema,
} = require("../../../validations/task");

const {
    createTask,
    getTasks,
    getTaskById,
    updateTask,
    deleteTask,
} = require("../../../controllers/client/task/task.controller");

router.use(verifyUserByToken);

router.get("/", validateRequest(queryTaskSchema, "query"), getTasks);

router.get("/:taskId", getTaskById);

router.post("/", validateRequest(createTaskSchema), createTask);

router.patch("/:taskId", validateRequest(updateTaskSchema), updateTask);

router.delete("/:taskId", deleteTask);

module.exports = router;
