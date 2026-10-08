const { Router } = require("express");
const router = Router();

router.use("/employees", require("./employee/employee.routes"));

router.use("/drivers", require("./driver/driver.routes"));
router.use("/device-tokens", require("./deviceToken/deviceToken.routes"));

module.exports = router;
