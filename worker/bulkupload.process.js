const dotenv = require("dotenv");
const path = require("path");

if (process.env.NODE_ENV !== "production") {
  const envFile =
    process.env.NODE_ENV === "development"
      ? ".env.development"
      : process.env.NODE_ENV === "staging"
        ? ".env.staging"
        : process.env.NODE_ENV === "test"
          ? ".env.test"
          : ".env";

  dotenv.config({
    path: path.resolve(__dirname, "..", envFile),
    override: false,
  });
}

console.log("[bulkUpload.process] environment:", {
  NODE_ENV: process.env.NODE_ENV,
  REDIS_URL: process.env.REDIS_URL ? "SET" : "MISSING",
  REDIS_TLS: process.env.REDIS_TLS,
  REDIS_SSL: process.env.REDIS_SSL,
});

if (!process.env.REDIS_URL) {
  throw new Error(
    "REDIS_URL is not configured. Set it to a valid Redis endpoint before starting the bulk upload queue.",
  );
}

const { startBulkUploadWorker } = require("./bulkupload.worker");

startBulkUploadWorker();