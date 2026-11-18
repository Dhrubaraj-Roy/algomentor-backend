const cloudinary = require("../config/cloudinary");
const Video = require("../models/video.model");
const Problem = require("../models/problem.model");
const { isValidObjectId } = require("../utils/validator");

/**
 * 1. Generate digital signature for direct video upload to Cloudinary.
 * Includes custom folder/URL style and timestamp.
 * Admin only.
 */
const getUploadSignature = async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "leetcode/videos";

    // Custom URL/public_id style: leetcode_video_<problemId>_<timestamp>
    const problemId = req.body?.problemId || req.query?.problemId;
    const customPublicId = problemId && isValidObjectId(problemId)
      ? `problem_${problemId}_${timestamp}`
      : `video_${timestamp}`;

    const paramsToSign = {
      folder,
      public_id: customPublicId,
      timestamp,
    };

    // Generate Cloudinary digital signature using API Secret
    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );

    // Provide client with own upload URL style and credentials
    const uploadUrl = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload`;

    res.status(200).json({
      message: "Upload signature generated successfully.",
      signature,
      timestamp,
      folder,
      publicId: customPublicId,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      uploadUrl,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

/**
 * 2. Save video metadata in the database after successful Cloudinary upload.
 * Verifies problem existence, ensures only one video per problem,
 * and creates a video thumbnail on the go.
 * Admin only.
 */
const saveVideometadata = async (req, res) => {
  try {
    const { problemId, videoUrl, publicId, duration, format, bytes } = req.body;

    // Validate problemId
    if (!problemId || !isValidObjectId(problemId)) {
      return res.status(400).json({ message: "A valid problemId is required." });
    }

    // Validate videoUrl and publicId
    if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.trim()) {
      return res.status(400).json({ message: "videoUrl is required." });
    }
    if (!publicId || typeof publicId !== "string" || !publicId.trim()) {
      return res.status(400).json({ message: "Cloudinary publicId is required." });
    }

    // Verify problem exists
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: "Problem not found." });
    }

    // Check if a video is already present for this problem (One problem, one solution video)
    const existingVideo = await Video.findOne({ problemId });
    if (existingVideo) {
      return res.status(400).json({
        message:
          "A solution video already exists for this problem. Please delete the existing video first.",
        existingVideoId: existingVideo._id,
      });
    }

    // Create thumbnail on the go using Cloudinary's dynamic URL transformation
    const generatedThumbnailUrl = cloudinary.url(publicId, {
      resource_type: "video",
      format: "jpg",
      transformation: [
        { width: 800, height: 450, crop: "fill" },
        { start_offset: "auto" },
      ],
      secure: true,
    });

    const thumbnailUrl = req.body.thumbnailUrl || generatedThumbnailUrl;

    const newVideo = new Video({
      problemId,
      userId: req.user._id,
      videoUrl: videoUrl.trim(),
      publicId: publicId.trim(),
      thumbnailUrl,
      duration: duration || 0,
      format: format || "mp4",
      bytes: bytes || 0,
    });

    await newVideo.save();

    res.status(201).json({
      message: "Solution video metadata saved successfully.",
      video: newVideo,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

/**
 * 3. Delete video by ID (Video ID or Problem ID).
 * Calls Cloudinary destroy command to delete the video asset, then removes from database.
 * Admin only.
 */
const deleteVideo = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid video or problem ID format." });
    }

    // Find video by video _id or problemId
    const video = await Video.findOne({
      $or: [{ _id: id }, { problemId: id }],
    });

    if (!video) {
      return res.status(404).json({ message: "Video not found." });
    }

    // Cloudinary destroy command for video asset
    let cloudinaryResult = null;
    try {
      cloudinaryResult = await cloudinary.uploader.destroy(video.publicId, {
        resource_type: "video",
      });
    } catch (cErr) {
      console.error("Cloudinary destroy error:", cErr.message);
    }

    // Delete video record from MongoDB
    await Video.findByIdAndDelete(video._id);

    res.status(200).json({
      message: "Video deleted successfully from Cloudinary and database.",
      deletedVideoId: video._id,
      problemId: video.problemId,
      cloudinaryResult,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

/**
 * 4. Fetch solution video by Problem ID.
 * One problem, one solution video.
 * Accessible by authenticated users to watch the video solution.
 */
const getVideoByProblemId = async (req, res) => {
  try {
    const { problemId } = req.params;

    if (!problemId || !isValidObjectId(problemId)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    // Verify problem exists
    const problem = await Problem.findById(problemId).select("_id title difficulty");
    if (!problem) {
      return res.status(404).json({ message: "Problem not found." });
    }

    // Fetch the single solution video for this problem
    const video = await Video.findOne({ problemId }).populate(
      "userId",
      "firstName lastName emailId"
    );

    if (!video) {
      return res.status(404).json({
        message: "No solution video found for this problem.",
      });
    }

    res.status(200).json({
      message: "Video fetched successfully.",
      problem: {
        id: problem._id,
        title: problem.title,
        difficulty: problem.difficulty,
      },
      video,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

module.exports = {
  getUploadSignature,
  saveVideometadata,
  deleteVideo,
  getVideoByProblemId,
};

