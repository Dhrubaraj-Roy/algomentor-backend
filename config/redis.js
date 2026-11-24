const { createClient } = require("redis");

const redisClient = createClient({
  username: "default",
  password: process.env.REDIS_PASS,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    reconnectStrategy: (retries) => {
      // Reconnection backoff strategy: retries with incremental delay capped at 3000ms
      return Math.min(retries * 100, 3000);
    },
  },
});

// Production Resilient Error Listener:
// Prevents unhandled 'error' events from terminating the Node.js process during network hiccups or Redis restarts
redisClient.on("error", (err) => {
  console.error("Redis Client Error (Non-fatal):", err.message);
});

module.exports = redisClient;
