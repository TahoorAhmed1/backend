const env = require("dotenv");
const path = require("path");
const http = require("http");
const app = require("./app");
const { logger } = require("./configs/logger");
const { Server } = require("socket.io");

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

// Create HTTP server for Socket.io
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: ["https://tradematch-frontend.vercel.app", "http://localhost:3000", "http://localhost:3001"],
    credentials: true,
  },
});

// Attach io to app for access in routes/controllers
app.set("io", io);

// Socket.io connection handler
io.on("connection", (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on("disconnect", () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

server.listen(port, () => {
  logger.info(`listening on http://localhost:${port} 
     Environment: ${process.env.NODE_ENV || "live"}
     Loaded Config from: ${envFile}
     TEST_VAR: ${process.env.TEST_VAR}`);
});

app.get("/", async (req, res) => {
  res.send("server is running");
});

