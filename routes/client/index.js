const { Router } = require("express");
const router = Router();


const taskRoute = require("./task/task.routes");



router.use("/task", taskRoute);

module.exports = router;
