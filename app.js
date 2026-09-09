const express = require("express");
const cors = require("cors");
const compression = require("compression");
const errorHandler = require("./middlewares/errorHandler.middleware");
const verifyUserByToken = require("./middlewares/verifyUserByToken");
const { pusher } = require("./configs/pusher");
const helmet = require("helmet");
const zlib = require("zlib");

const app = express();

app.use(helmet());
app.use(
  compression({
    threshold: 0,
    level: zlib.constants.Z_BEST_SPEED,
  }),
);
app.use(cors({ origin: "*" }));
app.set("json spaces", 0);
app.set("etag", "strong");
app.disable("x-powered-by");

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: false }));

if (process.env.NODE_ENV !== "production") {
  const { reqLogger } = require("./configs/logger");
  app.use(reqLogger);
}

app.use("/api", require("./routes/auth"));
app.use("/api/client", require("./routes/client"));
app.use("/api/mobile", require("./routes/admin"));

app.post("/pusher/auth", verifyUserByToken, (req, res) => {
  try {
    const { socket_id, channel_name } = req.body;
    const userId = req.user.userId;

    if (channel_name !== `private-user-${userId}`) {
      return res.status(403).send("Forbidden");
    }

    const authResponse = pusher.authorizeChannel(socket_id, channel_name);
    return res.send(authResponse);
  } catch (error) {
    console.error("Error occurred while authorizing Pusher channel:", error);
    return res.status(500).send("Internal Server Error");
  }
});



app.use(errorHandler);

module.exports = app;
