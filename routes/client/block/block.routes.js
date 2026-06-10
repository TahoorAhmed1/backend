const { Router } = require("express");
const router = Router();
const validateRequest = require("../../../middlewares/validateRequestJoi.middleware");
const {
  blockCreateSchema,
  blockUpdateSchema,
  blockIdSchema,
} = require("../../../validations/common");
const {
  createBlock,
  getAllBlocks,
  getBlockById,
  updateBlock,
  deleteBlock,
} = require("../../../controllers/client/block/block.controller");

router.post("/", validateRequest(blockCreateSchema), createBlock);
router.get("/", getAllBlocks);
router.get("/:id", validateRequest(blockIdSchema), getBlockById);
router.put("/:id", validateRequest(blockUpdateSchema), updateBlock);
router.delete("/:id", validateRequest(blockIdSchema), deleteBlock);

module.exports = router;
