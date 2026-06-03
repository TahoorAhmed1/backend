const Joi = require("joi");

const createTaskSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    title: Joi.string().required().trim().min(1).max(255),
    description: Joi.string().optional().trim().allow(""),
    status: Joi.string()
      .optional()
      .valid("todo", "in_progress", "completed", "cancelled")
      .lowercase(),
    userId: Joi.string().optional().allow(null), // For admin to assign task to user on creation
  }),
});

const updateTaskSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({
    taskId: Joi.number().required(),
  }),
  body: Joi.object({
    title: Joi.string().optional().trim().min(1).max(255),
    description: Joi.string().optional().trim().allow(""),
    status: Joi.string()
      .optional()
      .valid("todo", "in_progress", "completed", "cancelled")
      .lowercase(),
    userId: Joi.string().optional().allow(null), // For admin to assign task to user
  }),
});

const queryTaskSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    status: Joi.string()
      .optional()
      .valid("todo", "in_progress", "completed", "cancelled")
      .lowercase(),
    limit: Joi.number().optional().default(10).min(1).max(100),
    offset: Joi.number().optional().default(0).min(0),
  }),
});

module.exports = {
  createTaskSchema,
  updateTaskSchema,
  queryTaskSchema,
};
