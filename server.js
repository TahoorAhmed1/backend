const dotenv = require("dotenv");
const path = require("path");
const http = require("http");
const { logger } = require("./configs/logger");

const envFile =
  process.env.NODE_ENV === "development"
    ? ".env.development"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : process.env.NODE_ENV === "test"
        ? ".env.test"
        : ".env";

dotenv.config({
  path: path.resolve(__dirname, envFile),
  override: false,
});

const port = Number(process.env.PORT) || 8000;
const app = require("./app");
const server = http.createServer(app);

server.listen(port, () => {
  logger.info(`Server listening on http://localhost:${port}`);
  
  // Inform PM2 that the process is fully ready
  if (process.send) {
    process.send("ready"); 
  }
});

app.get("/", (req, res) => {
  res.send("server is running");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
