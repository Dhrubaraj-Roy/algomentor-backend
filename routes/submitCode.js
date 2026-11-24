const express = require("express");
const submitCodeRouter = express.Router();

const {
  submitCode,
  getUserProblemSubmissions,
  getSubmissionStream,
  getSubmissionStatus,
} = require("../controllers/submission.controller");
const userAuth = require("../middleware/userAuth");

// 1. Polling fallback to check submission status
submitCodeRouter.get("/status/:submissionId", userAuth, getSubmissionStatus);

// 2. Real-time Server-Sent Events (SSE) stream for live submission evaluation
submitCodeRouter.get("/events/:submissionId", userAuth, getSubmissionStream);
submitCodeRouter.get("/sse/:submissionId", userAuth, getSubmissionStream);

// 3. User Code Submission (Requires user login - responds 202 Accepted via BullMQ)
submitCodeRouter.post("/:problemId", userAuth, submitCode);

// 4. Get all submissions for a problem by logged-in user (Requires user login)
submitCodeRouter.get("/:problemId", userAuth, getUserProblemSubmissions);

module.exports = submitCodeRouter;
