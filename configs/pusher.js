const Pusher = require("pusher");

const pusher = new Pusher({
  appId: "2190497",
  key: "65e6d6039348fb7e77e4",
  secret: "e5c9f7a48f846d11d6d4",
  cluster: "ap2",
  useTLS: true,
});

module.exports = { pusher };
