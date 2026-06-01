const nodemailer = require("nodemailer");

const verifyEmail = async (email) => {
  const apiKey = '73118493-c24e-4b63-964c-0c2f3868b3d6';

  try {
    const response = await fetch(`https://api.mails.so/v1/validate?email=${email}`, {
      method: 'GET',
      headers: {
        'x-mails-api-key': apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.data.result === 'deliverable' && result.data.is_disposable === false) {
      return true;
    } else {
      return false;
    }

  } catch (error) {
    return false;
  }
};

const createAndSendEmail = async (opts) => {
  try {

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SERVER_HOST,
      port: process.env.EMAIL_SERVER_PORT,
      secure: true,
      auth: {
        user: process.env.SENDER_USERNAME,
        pass: process.env.SENDER_EMAIL_PASSWORD,
      },
    });

    await transporter.verify((error) => {
      if (error) {
        throw new Error("SMTP server verification failed");
      }
    });

    const mailOpts = {
      from: process.env.SENDER_EMAIL_HERE,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    };

    return transporter.sendMail(mailOpts, (error, info) => {
      if (error) {
        return { error, response: null };
      }
      return { error: null, response: `Message sent: ${info.messageId} ${info.response}` };
    });

  } catch (error) {
    return { error: error.message, response: null };
  }
};

module.exports = { createAndSendEmail, verifyEmail };