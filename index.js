const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
require("dotenv").config();

const connectDB = require("./config/db");
const redisClient = require("./config/redis");
const { initWorkers, closeWorkers } = require("./workers");
const authRouter = require("./routes/auth");
const problemRouter = require("./routes/problem");
const submitCodeRouter = require("./routes/submitCode");
const chatRouter = require("./routes/chat");
const videoCreatorRouter = require("./routes/videoCreator");

const app = express();

// Middlewares
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Routes
app.use("/", authRouter);
app.use("/problem", problemRouter);
app.use("/submit", submitCodeRouter);
app.use("/chat", chatRouter);
app.use("/video", videoCreatorRouter);
app.use("/videoCreator", videoCreatorRouter);

// Health check route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", message: "Server is healthy" });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await connectDB();
    console.log("Database connection established successfully.");

    await redisClient.connect();
    console.log("Redis connection established successfully.");

    initWorkers();
    console.log("BullMQ background workers initialized successfully.");

    const server = app.listen(PORT, () => {
      console.log(`Server is successfully listening on port ${PORT}...`);
    });

    let isShuttingDown = false;
    const gracefulShutdown = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);
      server.close(async () => {
        try {
          await closeWorkers();
          console.log("BullMQ workers shut down.");
          if (redisClient.isOpen) {
            await redisClient.quit();
            console.log("Redis client disconnected.");
          }
          process.exit(0);
        } catch (err) {
          console.error("Error during graceful shutdown:", err);
          process.exit(1);
        }
      });
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  } catch (err) {
    console.error("Server startup error:", err.message);
  }
};

startServer();
