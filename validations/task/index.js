const Joi = require("joi");

const createTaskSchema = Joi.object().keys({
    title: Joi.string().required().trim().min(1).max(255),
    description: Joi.string().optional().trim().allow(""),
});

const updateTaskSchema = Joi.object().keys({
    title: Joi.string().optional().trim().min(1).max(255),
    description: Joi.string().optional().trim().allow(""),
    status: Joi.string()
        .optional()
        .valid("todo", "in_progress", "done")
        .lowercase(),
});

const queryTaskSchema = Joi.object().keys({
    status: Joi.string().optional().valid("todo", "in_progress", "done").lowercase(),
    limit: Joi.number().optional().default(10).min(1).max(100),
    offset: Joi.number().optional().default(0).min(0),
});

module.exports = {
    createTaskSchema,
    updateTaskSchema,
    queryTaskSchema,
};
