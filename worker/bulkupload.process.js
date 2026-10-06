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
  dotenv.config({ path: envPath });
} else if (fs.existsSync(fallbackPath)) {
  dotenv.config({ path: fallbackPath });
}

const {
  jobType,
  accountKey,
  QUEUE_DISPLAY_NAME,
  ensureQueueConfigured,
} = require("../lib/queue");
ensureQueueConfigured();

console.log("[bulkUpload.process] starting account worker", {
  NODE_ENV: process.env.NODE_ENV,
  jobType,
  accountKey,
  queueName: QUEUE_DISPLAY_NAME,
});

const { startBulkUploadWorker } = require("./bulkupload.worker");

startBulkUploadWorker();