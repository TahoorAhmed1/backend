const { Router } = require("express");
const router = Router();

const auth = require("./auth.routes");

router.use("/auth", auth);

module.exports = router;
