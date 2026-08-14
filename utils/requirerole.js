const { forbiddenResponse } = require("../constants/responses");

// Usage: router.use(verifyUserByToken, requireRole("DRIVER"));
// Must run after verifyUserByToken so req.user (the decoded token: { userId, role })
// is already populated.
const requireRole =
  (...allowedRoles) =>
  (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      const response = forbiddenResponse(
        "You do not have access to this resource.",
      );
      return res.status(response.status.code).json(response);
    }
    next();
  };

module.exports = requireRole;