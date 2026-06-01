const transporter = require("../configs/email");

const sendEmailVerificationOtp = async (email, otp) => {
  const mailOptions = {
    to: email,
    subject: "Email Verification",
    html: `<p>Please enter OTP to verify your email:</p>
            <h2>${otp}</h2>`,
  };

  await transporter.createAndSendEmail(mailOptions);
};
const sendResendPassword = async (email) => {
  const mailOptions = {
    to: email,
    subject: "Password Reset",
    html: `<p>Your password has been changed</p>`,
  };

  await transporter.createAndSendEmail(mailOptions);
};

module.exports = { sendEmailVerificationOtp, sendResendPassword };
