const Email_Template_Professor = (student, professor) => {
  return `<html xmlns="http://www.w3.org/1999/xhtml">
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 24px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: white; border-radius: 8px; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);">
          <tr>
            <td style="padding: 24px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="line-height: 0;">
                      <tr>
                        <td style="padding-right: 8px;">
                          <img src="https://ungrade.us/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fwhite_new_logo.8f280654.png&w=3840&q=75" alt="Ungrade.US Logo" width="24" height="24" style="border: 0; display: block;" />
                        </td>
                        <td style="vertical-align: middle;">
                          <p style="margin: 0; font-size: 14px; color: #6b7280;">Ungrade.US</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Content Section -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 24px;">
                <tr>
                  <td>
                    <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #111827;">Dear ${professor.name},</h2>
                    
                    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #4b5563;">
                      We hope you're doing well. ${student?.name} has demonstrated exceptional academic performance and is requesting a letter of recommendation. Given their outstanding achievements, they would greatly appreciate your support in their application.
                    </p>
                    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #4b5563;">
To review ${student?.name}’s performance, please click the button below:
                    </p>

                  
                    <a href="https://dev.ungrade.us/student?studentId=${student?.id}" style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #ffffff; padding: 8px 15px; background-color: #07525C; text-decoration: none; border-radius: 6px;">
View Profile
</a>
                
                    <p style="margin: 20 0 16px 0; font-size: 14px; line-height: 1.6; color: #4b5563;">
                      If you have any questions or need further details, feel free to reach out. Thank you for your time and consideration.
                    </p>



                  </td>
                </tr>
              </table>

              <!-- Signature Section -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 24px;">
                <tr>
                  <td>
                    <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #6b7280;">
                      Best regards,<br />
                      Ungrade.US<br />
                     ${process.env.SENDER_EMAIL_HERE}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
};
module.exports = { Email_Template_Professor };
