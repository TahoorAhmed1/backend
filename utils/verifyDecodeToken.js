const jwt = require("jsonwebtoken");

const verifyAndDecodeToken = (token) => {
  try {
    const decodedData = jwt.verify(token, process.env.JWT_SECRET_KEY);
    return { tokenValid: true, decodedData };
  } catch (err) {
    return { tokenValid: false };
  }
};

module.exports = verifyAndDecodeToken;
