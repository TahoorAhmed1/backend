const env = require("dotenv");
const path = require("path");
const http = require("http");
const app = require("./app");
const { logger } = require("./configs/logger");

const envFile =
  process.env.NODE_ENV == "development"
    ? ".env.development"
    : process.env.NODE_ENV == "staging"
      ? ".env.staging"
      : process.env.NODE_ENV == "test"
        ? ".env.test"
        : ".env";

env.config({ path: path.resolve(__dirname, envFile), override: true });

const port = process.env.PORT;

const server = http.createServer(app);


server.listen(port, () => {
  logger.info(`listening on http://localhost:${port} 
     Environment: ${process.env.NODE_ENV || "live"}
     Loaded Config from: ${envFile}
     TEST_VAR: ${process.env.TEST_VAR}`);
});

app.get("/", async (req, res) => {
  res.send("server is running");
});

