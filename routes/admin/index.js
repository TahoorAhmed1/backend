const { Router } = require("express");
const router = Router();

router.use("/employees", require("./employee/employee.routes"));

router.use("/drivers", require("./driver/driver.routes"));

module.exports = router;
