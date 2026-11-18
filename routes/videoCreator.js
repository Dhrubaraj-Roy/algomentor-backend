const express = require("express");
const videoCreatorRouter = express.Router();

const {
  getUploadSignature,
  saveVideometadata,
  deleteVideo,
  getVideoByProblemId,
} = require("../controllers/video.controller");

const userAuth = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");

// ==========================================
// Admin-Only Routes (Requires Admin Login)
// ==========================================

// 1. Create / Get Digital Signature for direct Cloudinary upload (with own URL style)
videoCreatorRouter.post("/create", userAuth, adminAuth, getUploadSignature);
videoCreatorRouter.post("/create-signature", userAuth, adminAuth, getUploadSignature);

// 2. Save video metadata (verifies problem existence, prevents duplicates, creates thumbnail on the go)
videoCreatorRouter.post("/save", userAuth, adminAuth, saveVideometadata);

// 3. Delete video by ID (uses Cloudinary destroy command and deletes DB record)
videoCreatorRouter.delete("/delete/:id", userAuth, adminAuth, deleteVideo);
videoCreatorRouter.delete("/:id", userAuth, adminAuth, deleteVideo);

// ==========================================
// User Routes (Requires User Login)
// ==========================================

// 4. Fetch/watch solution video by Problem ID (One problem, one solution video)
videoCreatorRouter.get("/problem/:problemId", userAuth, getVideoByProblemId);
videoCreatorRouter.get("/:problemId", userAuth, getVideoByProblemId);

module.exports = videoCreatorRouter;

