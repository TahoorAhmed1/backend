const env = require("dotenv");
const path = require("path");

const envFile =
  process.env.NODE_ENV == "development"
    ? ".env.development"
    : process.env.NODE_ENV == "staging"
      ? ".env.staging"
      : process.env.NODE_ENV == "test"
        ? ".env.test"
        : ".env";

env.config({ path: path.resolve(__dirname, "..", envFile), override: true });

const { startBulkUploadWorker } = require("./bulkupload.worker");

startBulkUploadWorker();