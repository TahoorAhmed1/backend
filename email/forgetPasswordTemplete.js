const Email_Template_Reminder = (userId, token) => {
  return `
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password Reset</title>
  </head>
  <body>
    <table style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; border-collapse: collapse;">
      <tr>
        <td style="background-color: #007bff; text-align: center; padding: 20px; color: #fff; font-size: 24px;">
          Password Reset
        </td>
      </tr>
      <tr>
        <td style="background-color: #f4f4f4; padding: 20px;">
          <p>Hi,</p>
          <p>You've requested to reset your password. Please click the button below to reset it:</p>
          <table style="margin: 30px auto;">
            <tr>
              <td style="background-color: #007bff; padding: 10px 20px;">
                <a href="http://localhost:3000/reset-password/${token}?userId=${userId}" style="color: #fff; text-decoration: none;">Reset Password</a>
              </td>
            </tr>
          </table>
          <p>If you didn't request this, you can safely ignore this email. Your password will remain unchanged.</p>
        </td>
      </tr>
      <tr>
        <td style="background-color: #007bff; text-align: center; padding: 10px; color: #fff;">
          &copy; 2024 Your Website
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
};
module.exports = { Email_Template_Reminder };
