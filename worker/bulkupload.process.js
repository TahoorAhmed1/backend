const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

// Load a .env file if one exists. override:false means real environment
// variables (AWS, PM2, system) always win, so this is safe in production too.
const envFile =
  process.env.NODE_ENV === "development" ? ".env.development"
  : process.env.NODE_ENV === "staging" ? ".env.staging"
  : process.env.NODE_ENV === "test" ? ".env.test"
  : ".env";

const envPath = path.resolve(__dirname, "..", envFile);
const fallbackPath = path.resolve(__dirname, "..", ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
} else if (fs.existsSync(fallbackPath)) {
  dotenv.config({ path: fallbackPath, override: false });
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