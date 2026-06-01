const Email_Template_Reminder = (data, user, filter_course) => {
  return `<html lang="en">

  <head>
      <meta charset="UTF-8" />
      <meta http-equiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Reminder</title>
  </head>
  
  <body style="font-family: sans-serif; margin: 0px; min-width: 380px">
      <!-- Start of header -->
      <table style="
            max-width: 650px;
            min-width: 300px;
            color: rgb(0, 0, 0);
            background: #ffffff;
            width: 100%;
            margin: auto;
            font-family: sans-serif;
            border-spacing: 0;
          ">
          <thead>
              <tr>
                  <td style="text-align: center">
                      <img style="margin-top: 20px; margin-bottom: 20px; width: 226.25px"
                          src="https://firebasestorage.googleapis.com/v0/b/ungradeus.appspot.com/o/email%2Fungrade-logo.png?alt=media&token=1f6e2f3e-671d-4e62-8368-25d8d36b5a3c" />
                  </td>
              </tr>
          </thead>
      </table>
      <!-- End of header -->
  
      <!-- Start of body -->
      <div>
          <table style="
              max-width: 650px;
              min-width: 300px;
              color: rgb(0, 0, 0);
              background: #ffffff;
              width: 100%;
              margin: auto;
              font-family: sans-serif;
              border-spacing: 0;
            ">
              <thead>
                  <tr>
                      <td style="
                    padding-left: 77.87px;
                    padding-right: 77.87px;
                    padding-top: 35px;
                    padding-bottom: 26px;
                    text-align: left;
                  ">
                          <p style="
                      font-family: sans-serif;
                      font-style: normal;
                      font-weight: 700;
                      font-size: 16px;
                      line-height: 32px;
                      margin: 0;
                      color: #000000;
                    ">
                              Dear <strong>${user?.username}</strong>
                          </p>
                      </td>
                  </tr>
                  <tr>
                      <td style="
                    padding-left: 77.87px;
                    padding-right: 77.87px;
                    /* padding-top: 35px; */
                    padding-bottom: 26px;
                    text-align: left;
                  ">
                          <p style="
                      font-family: sans-serif;
                      font-style: normal;
                      font-weight: 500;
                      font-size: 14px;
                      line-height: 24px;
                      margin: 0;
                      color: #000000;
                    ">
                              We hope this message finds you well. As part of our commitment to continuous improvement, we
                              value your feedback on the recent assessment process.
                          </p>
                      </td>
                  </tr>
                  <tr>
                      <td style="
                    padding-left: 77.87px;
                    padding-right: 77.87px;
                    /* padding-top: 35px; */
                    padding-bottom: 26px;
                    text-align: left;
                  ">
                          <p style="
                      font-family: sans-serif;
                      font-style: normal;
                      font-weight: 500;
                      font-size: 14px;
                      line-height: 24px;
                      margin: 0;
                      color: #000000;
                    ">
                              Your insights are essential in helping us understand what worked well and areas where we can
                              improve. Your honest feedback will enable us to refine our approach and ensure future
                              assessments are even more effective.
                          </p>
                      </td>
                  </tr>
                  <tr>
                      <td style="
                      padding-left: 77.87px;
                      padding-right: 77.87px;
                      /* padding-top: 35px; */
                      padding-bottom: 26px;
                      text-align: left;
                    ">
                          <p style="
                        font-family: sans-serif;
                        font-style: normal;
                        font-weight: 500;
                        font-size: 14px;
                        line-height: 24px;
                        margin: 0;
                        color: #000000;
                      ">
                              Please take a few moments to share your thoughts by clicking the link below:
                          </p>
                      </td>
                  </tr>
                  <tr>
                      <td style="
                    padding-left: 77.87px;
                    padding-right: 77.87px;
                    text-align: center;
                    padding-bottom: 26px;
  
                  ">
                          <a href=${`http://localhost:3000?course=${filter_course?.id}&userid=${user?.id}&professorId=${data?.professor_id}&universityId=${data?.university_id}&assessmentType=${data?.assessmentType}`}> <button style="
                      max-width: 250px;
                      padding: 10px 20px;
                      background: #053c6f;
                      border-radius: 10px;
                      color: white;
                      text-align: center;
                      font-family: sans-serif;
                      font-style: normal;
                      font-weight: 700;
                      font-size: 14px;
                      line-height: 36px;
                      width: 100%;
                      border: #ffffff;
                    ">
                                  <a href="https://www.google.com/"> </a><a href=${`http://localhost:3000?course=${filter_course?.id}&userid=${user?.id}&professorId=${data?.professor_id}&universityId=${data?.university_id}&assessmentType=${data?.assessmentType}`}
                                      style="color: #ffffff; text-decoration: none">Add Your Reviews
                                  </a>
                              </button>
                          </a>
                      </td>
                  </tr>
                  <tr>
                      <td style="
                    padding-left: 77.87px;
                    padding-right: 77.87px;
                    /* padding-top: 35px; */
                    padding-bottom: 26px;
                    text-align: left;
                  ">
                          <p style="
                      font-family: sans-serif;
                      font-style: normal;
                      font-weight: 500;
                      font-size: 14px;
                      line-height: 24px;
                      margin: 0;
                      color: #000000;
                    ">
                              Thank you for your time and valuable input. Should you have any questions or need further
                              assistance, feel free to reach out.
                          </p>
                      </td>
                  </tr>
                  <tr>
                      <td style="
                    padding-left: 77.87px;
                    padding-right: 77.87px;
                    /* padding-top: 35px; */
                    padding-bottom: 26px;
                    text-align: left;
                  ">
                          <p style="
                      font-family: sans-serif;
                      font-style: normal;
                      font-weight: 500;
                      font-size: 14px;
                      line-height: 24px;
                      margin: 0;
                      color: #000000;
                    ">
                              Best regards,<br />
                              <strong>Ungrade.us</strong>
                          </p>
                      </td>
                  </tr>
              </thead>
          </table>
      </div>
      <!-- End of body -->
  
      <!-- Footer start here -->
      <div>
          <table style="
              max-width: 650px;
              min-width: 300px;
              color: white;
              background: #3d3c3c;
              padding: 25px 7.5%;
              width: 100%;
              margin: auto;
              text-align: center;
              /* margin-top: 51.51px; */
            ">
              <tbody>
                  <!-- <tr>
                <td
                  class="WriterTitle iconsDiv"
                  style="
                    color: #3d3c3c;
                    font-size: 13px;
                    margin: auto;
                    width: 200px;
                  "
                >
                  <a
                    target="_blank"
                    style="text-decoration: none; margin-left: 10px"
                    href="https://www.facebook.com/ungrade"
                    ><img
                      style="margin: auto; width: 30px"
                      src="https://firebasestorage.googleapis.com/v0/b/ungradeus.appspot.com/o/email%2Ffacebook.png?alt=media&token=cb4ba0a7-1c13-402b-bc8f-2a8de7df17b9"
                    />
                  </a>
                  <a
                    target="_blank"
                    style="text-decoration: none; margin-left: 10px"
                    href="https://twitter.com/ungrade"
                  >
                    <img
                      style="margin: auto; width: 30px"
                      src="https://firebasestorage.googleapis.com/v0/b/ungradeus.appspot.com/o/email%2Ftwitter.png?alt=media&token=ec5ea8d4-567b-46c2-b42e-087b431bf93f"
                    />
                  </a>
                  <a
                    target="_blank"
                    style="text-decoration: none; margin-left: 10px"
                    href="https://www.instagram.com/ungrade/"
                  >
                    <img
                      style="margin: auto; width: 30px"
                      src="https://firebasestorage.googleapis.com/v0/b/ungradeus.appspot.com/o/email%2Finstagram.png?alt=media&token=5a337bd4-3180-489e-9625-b975f1252975"
                    />
                  </a>
                  <a
                    target="_blank"
                    style="text-decoration: none; margin-left: 10px"
                    href="https://www.linkedin.com/ungrade"
                  >
                    <img
                      style="margin: auto; width: 30px"
                      src="https://firebasestorage.googleapis.com/v0/b/ungradeus.appspot.com/o/email%2Flinkden.png?alt=media&token=44a5fdeb-5b16-4d01-b5c3-dff050e02357"
                    />
                  </a>
                </td>
              </tr> -->
                  <tr>
                      <td class="WriterTitle" style="
                    padding-top: 14.28px;
                    color: white;
                    font-size: 15px;
                    text-align: center;
                  ">
                          Copyright © ungrade.us Inc. All rights reserved.
                      </td>
                  </tr>
              </tbody>
          </table>
      </div>
      <!-- Footer end here -->
  </body>
  
  </html>`;
};
module.exports = { Email_Template_Reminder };
