const jwt = require("jsonwebtoken");

const verifyAndDecodeToken = (token) => {
  const result = jwt.verify(
    token,
    process.env.JWT_SECRET_KEY,
    (err, decodedData) => {
      if (err) {
        return { tokenValid: false };
      }
      return { tokenValid: true, decodedData };
    }
  );
  return result;
};

module.exports = verifyAndDecodeToken;
