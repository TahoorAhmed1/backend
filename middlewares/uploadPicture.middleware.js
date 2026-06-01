const cloudinary = require("../configs/cloudinary");
const { okResponse } = require("../constants/responses");
const { logger } = require("../configs/logger");

const uploadImage = async (req, res, next) => {
  const file = req.files[0];
  const b64 = Buffer.from(file.buffer).toString("base64");
  const dataURI = `data:${file.mimetype};base64,${b64}`;

  try {
    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: "auto",
      folder: `assets/${file.fieldname}`,
      public_id: `${file.originalname.split(".")[0]}-${Date.now()}`,
    });
    const imageUrl = result.secure_url;
    const response = okResponse(imageUrl);
    return res.status(response.status.code).json(response);
  } catch (error) {
    logger.error("Error uploading image to Cloudinary.", error);
    return next(error);
  }
};

const uploadImageFromBuffer = async (file) => {
  const b64 = Buffer.from(file.buffer).toString("base64");
  const dataURI = `data:${file.mimetype};base64,${b64}`;

  const result = await cloudinary.uploader.upload(dataURI, {
    resource_type: "auto",
    folder: `assets/${file.fieldname}`,
    format: "webp",
    quality: "auto:good",
    public_id: `${file.originalname.split(".")[0]}-${Date.now()}`,
  });

  return result.secure_url;
};


const uploadVideoFromBuffer = async (file) => {
  if (!file.mimetype.startsWith('video/')) {
    throw new Error('Invalid file type. Expected video format.');
  }

  const b64 = Buffer.from(file.buffer).toString("base64");
  const dataURI = `data:${file.mimetype};base64,${b64}`;

  const uniqueId = `${file.originalname.split(".")[0]}-${Date.now()}`;

  const uploadOptions = {
    resource_type: "video",
    folder: `assets/videos`,
    public_id: uniqueId,
    quality: "auto",
    fetch_format: "auto",
    chunk_size: 6000000,
    eager: [

      {
        format: 'mp4',
        video_codec: 'auto',
        bit_rate: 'auto',
        transformation: [
          { width: 720, crop: "scale" }
        ]
      }
    ],
    eager_async: true,
    eager_notification_url: process.env.CLOUDINARY_NOTIFICATION_URL || null,

  };

  try {
    const result = await cloudinary.uploader.upload(dataURI, uploadOptions);

    return result.secure_url;
  } catch (error) {
    throw new Error(`Video upload failed: ${error.message}`);
  }
};

const uploadDocumentFromBuffer = async (file) => {


  const b64 = Buffer.from(file.buffer).toString("base64");
  const dataURI = `data:${file.mimetype};base64,${b64}`;

  const uniqueId = `${file.originalname.split(".")[0]}-${Date.now()}`;

  const result = await cloudinary.uploader.upload(dataURI, {
    resource_type: "raw",
    folder: `assets/documents`,
    public_id: uniqueId,

  });

  return result.secure_url;
};


const deleteCloudinaryImage = async (url) => {
  if (!url) return;

  try {
    const baseUrl = new URL(url);
    const parts = baseUrl.pathname.split("/");

    const versionIndex = parts.findIndex((p) => p.startsWith("v"));
    const folderAndFile = parts.slice(versionIndex + 1);

    if (folderAndFile?.length < 2) {
      logger.info(" Cloudinary path invalid, skipping deletion");
      return;
    }

    const publicIdWithExt = folderAndFile.join("/");
    const publicId = publicIdWithExt.replace(/\.[^/.]+$/, "");

    await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
    });
  } catch (err) {
    logger.info("Error deleting Cloudinary image:", err.message);
  }
};

module.exports = { uploadImage, uploadImageFromBuffer, deleteCloudinaryImage, uploadVideoFromBuffer, uploadDocumentFromBuffer };
