const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const mongoose = require("mongoose");
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

// Configure trust proxy dynamically:
// - In production behind a reverse proxy (Render, Heroku, AWS, Nginx), trust proxy hops (default 1).
// - In local development, default to false to prevent header spoofing.
// - Supports explicit booleans ('true'/'false'), numbers (1, 2, ...), or string presets ('loopback').
const parseTrustProxy = (val) => {
  if (val === undefined || val === null || val === "") {
    return process.env.NODE_ENV === "production" ? 1 : false;
  }
  const normalized = String(val).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const num = Number(normalized);
  return Number.isNaN(num) ? val : num;
};

app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

// Middlewares
app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
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

// Global error-handling middleware (4 arguments required by Express)
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  console.error("Unhandled Express error:", err);

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      status: 400,
      message: "Invalid JSON payload in request body.",
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      status: 413,
      message: "Request payload exceeds the 1MB limit.",
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const isProduction = process.env.NODE_ENV === "production";
  const message =
    statusCode >= 500 && isProduction
      ? "Internal server error."
      : err.message || "Internal server error.";

  return res.status(statusCode).json({
    status: statusCode,
    message,
  });
});

const PORT = process.env.PORT || 3000;

let server = null;
let isShuttingDown = false;

const shutdown = async (reason, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nReceived ${reason}. Shutting down gracefully...`);

  // Ensure process exits even if open sockets hang during shutdown
  const forceExitTimer = setTimeout(() => {
    console.error("Forced exit after shutdown timeout.");
    process.exit(exitCode || 1);
  }, 5000);
  forceExitTimer.unref();

  const cleanup = async () => {
    try {
      await closeWorkers();
      console.log("BullMQ workers shut down.");
      if (redisClient.isOpen) {
        await redisClient.quit();
        console.log("Redis client disconnected.");
      }
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        console.log("MongoDB connection closed.");
      }
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    } catch (err) {
      console.error("Error during graceful shutdown:", err);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  if (server) {
    server.close(cleanup);
  } else {
    await cleanup();
  }
};

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Promise Rejection:", reason);
  shutdown("unhandledRejection", 1);
});

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));

const startServer = async () => {
  try {
    await connectDB();
    console.log("Database connection established successfully.");

    await redisClient.connect();
    console.log("Redis connection established successfully.");

    initWorkers();
    console.log("BullMQ background workers initialized successfully.");

    server = app.listen(PORT, () => {
      console.log(`Server is successfully listening on port ${PORT}...`);
    });
  } catch (err) {
    console.error("Server startup error:", err);
    process.exit(1);
  }
};

startServer();
