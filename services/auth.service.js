const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const createToken = (params, expiresIn) => {
  const token = jwt.sign({ ...params }, process.env.JWT_SECRET_KEY, {
    expiresIn: expiresIn ? expiresIn : "10h",
  });
  return token;
};

const createOtpToken = (params) => {
  const token = jwt.sign({ ...params }, process.env.OTP_JWT_SECRET_KEY);

  return token;
};

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

const verifyAndDecodeOTPToken = (token) => {
  const result = jwt.verify(
    token,
    process.env.OTP_JWT_SECRET_KEY,
    (err, decodedData) => {
      if (err) {
        return { tokenValid: false };
      }
      return { tokenValid: true, decodedData };
    }
  );
  return result;
};

const hashPassword = async (password) => {
  const hashedPassword = await bcrypt.hash(password, 10);
  return hashedPassword;
};

const comparePasswords = async (password, hashedPassword) => {
  const isMatch = await bcrypt.compare(password, hashedPassword);
  return isMatch;
};

const generateOTP = (length = 6) => {
  const otp = Array.from({ length }, () => Math.floor(Math.random() * 10)).join(
    ""
  );
  return otp;
};

module.exports = {
  generateOTP,
  createToken,
  hashPassword,
  createOtpToken,
  comparePasswords,
  verifyAndDecodeToken,
  verifyAndDecodeOTPToken,
};
