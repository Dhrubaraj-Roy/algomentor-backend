const express = require("express");
const submitCodeRouter = express.Router();

const {
  submitCode,
  getUserProblemSubmissions,
  getSubmissionStream,
  getSubmissionStatus,
} = require("../controllers/submission.controller");
const userAuth = require("../middleware/userAuth");
const { submissionRateLimiter } = require("../middleware/rateLimiter");

// 1. Polling fallback to check submission status
submitCodeRouter.get("/status/:submissionId", userAuth, getSubmissionStatus);

// 2. Real-time Server-Sent Events (SSE) stream for live submission evaluation
submitCodeRouter.get("/events/:submissionId", userAuth, getSubmissionStream);
submitCodeRouter.get("/sse/:submissionId", userAuth, getSubmissionStream);

// 3. User Code Submission (Requires user login - rate limited per user to protect queue)
submitCodeRouter.post("/:problemId", userAuth, submissionRateLimiter, submitCode);

// 4. Get all submissions for a problem by logged-in user (Requires user login)
submitCodeRouter.get("/:problemId", userAuth, getUserProblemSubmissions);

module.exports = submitCodeRouter;
