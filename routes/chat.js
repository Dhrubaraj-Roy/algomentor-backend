const express = require("express");
const chatRouter = express.Router();
const userAuth = require("../middleware/userAuth");
const { chatRateLimiter } = require("../middleware/rateLimiter");
const { handleChat } = require("../controllers/chat.controller");

// Route: POST /chat (also supports POST /chat/)
// Protected route: user must be authenticated, then rate-limited per user ID (5 req/min)
chatRouter.post("/", userAuth, chatRateLimiter, handleChat);
chatRouter.post("/chat", userAuth, chatRateLimiter, handleChat);

module.exports = chatRouter;


