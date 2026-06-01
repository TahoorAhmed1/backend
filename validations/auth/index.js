const Joi = require("joi");

/**
 * Schema for user registration
 * Required: email, password, name
 */
const userRegisterSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    name: Joi.string().optional(),
  }),
});

/**
 * Schema for user login
 * Required: email, password
 */
const userLoginSchema = Joi.object({
  query: Joi.object({}),
  params: Joi.object({}),
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
  }),
});

module.exports = {
  userRegisterSchema,
  userLoginSchema,
};
