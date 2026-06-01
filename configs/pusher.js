const Pusher = require("pusher");

const pusher = new Pusher({
    appId: "1981649",
    key: "5a8f542f7e4c1f452d53",
    secret: "5dce5d15134bd5f8586d",
    cluster: "ap2",
    useTLS: true
});


module.exports = { pusher };