const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  complaintCreateSchema,
  complaintUpdateSchema,
} = require("../../../validations/common");
const {
  createComplaint,
  getAllComplaints,
  getComplaintById,
  updateComplaint,
  deleteComplaint,
  updateComplaintStatus,
  getComplaintsByCategory,
  getComplaintStats,
} = require("../../../controllers/client/complaint/complaint.controller");
const verifyUserByToken = require("../../../middlewares/verifyUserByToken");
const requireRole = require("../../../utils/requirerole");

router.use(verifyUserByToken, requireRole("ADMIN"));

router.post("/", validateRequest(complaintCreateSchema), createComplaint);

router.get("/", getAllComplaints);

router.get("/stats/overview", getComplaintStats);

router.get("/category/:category", getComplaintsByCategory);

router.patch("/:id/status", updateComplaintStatus);

router.get("/:id", getComplaintById);

router.put("/:id", updateComplaint);

router.delete("/:id", deleteComplaint);

module.exports = router;
