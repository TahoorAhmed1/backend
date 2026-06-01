const Email_Template_Recommend = (formData) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
        }
        .container {
            background-color: #ffffff;
            padding: 30px;
            border-radius: 5px;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
            text-align: center;
        }
        h1 {
            color: #003366;
            margin-top: 0;
            border-bottom: 2px solid #003366;
            padding-bottom: 10px;
        }
        .message {
            font-size: 16px;
            margin-top: 20px;
        }
        .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 0.9em;
            color: #666666;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Recommendation Approved</h1>
        
        <p class="message">
            Dear ${formData.applicant_name},<br><br>
            We are pleased to inform you that your recommendation has been successfully reviewed and approved.<br>
            Thank you for your submission!
        </p>
        
        <p>If you have any questions, feel free to reach out to us at <a href="mailto:recommendations@organization.com">recommendations@organization.com</a>.</p>
        
        <div class="footer">
            <p>&copy; 2025 Ungrade.us. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
};

module.exports = { Email_Template_Recommend };
