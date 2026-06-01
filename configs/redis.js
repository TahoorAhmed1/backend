const { createClient } = require("redis");

const redis = createClient({
  url: "redis://default:3FCXTFQpEEIIG1NfxdpmPi5SDIUwNWHq@redis-18651.c98.us-east-1-4.ec2.redns.redis-cloud.com:18651",
});

redis.connect()
  .then(() => "")
  .catch();
module.exports = redis