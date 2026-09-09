const { Router } = require("express");
const router = Router();

router.use("/areas", require("./area/area.routes"));

router.use("/departments", require("./department/department.routes"));

router.use("/sub-areas", require("./subArea/subArea.routes"));

router.use("/blocks", require("./block/block.routes"));

router.use("/employees", require("./employee/employee.routes"));

router.use("/routes", require("./route/route.routes"));

router.use("/vendors", require("./vendor/vendor.routes"));

router.use("/drivers", require("./driver/driver.routes"));

router.use("/vehicles", require("./vehicle/vehicle.routes"));

router.use("/rides", require("./ride/ride.routes"));

router.use("/attendance", require("./attendance/attendance.routes"));

router.use("/complaints", require("./complaint/complaint.routes"));

router.use("/notifications", require("./notification/notification.routes"));

router.use("/schedules", require("./schedule/weeklySchedule.routes"));
router.use("/dashboard", require("./dashboard/dashboard.routes"));

module.exports = router;
