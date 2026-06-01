const verifyAndDecodeToken = require("../utils/verifyDecodeToken");
const {
  forbiddenResponse,
  badRequestResponse,
} = require("../constants/responses");

const verifyOTP = (req, res, next) => {
  const { authorization: token } = req.headers;

  if (!token) {
    const response = badRequestResponse("Token not provided.");
    return res.status(response.status.code).json(response);
  }

  const { tokenValid, decodedData } = verifyAndDecodeToken(token);

  if (!tokenValid) {
    const response = forbiddenResponse("Token Expired.");
    return res.status(response.status.code).json(response);
  }

  req.user = decodedData;

  next();
};

module.exports = verifyOTP;
