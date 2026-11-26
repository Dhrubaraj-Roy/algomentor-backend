const mongoose = require("mongoose");

const problemSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    difficulty: {
      type: String,
      required: true,
      enum: ["easy", "medium", "hard"],
      lowercase: true,
      trim: true,
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    visibleTestCases: [
      {
        input: {
          type: String,
          required: true,
        },
        output: {
          type: String,
          required: true,
        },
        explanation: {
          type: String,
          trim: true,
        },
      },
    ],
    hiddenTestCases: [
      {
        input: {
          type: String,
          required: true,
        },
        output: {
          type: String,
          required: true,
        },
      },
    ],
    startCode: [
      {
        language: {
          type: String,
          required: true,
          trim: true,
        },
        initialCode: {
          type: String,
          required: true,
        },
      },
    ],
    referenceSolution: [
      {
        language: {
          type: String,
          required: true,
          trim: true,
        },
        completeCode: {
          type: String,
          required: true,
        },
      },
    ],
    problemCreator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    verificationStatus: {
      type: String,
      enum: ["Pending", "Accepted", "Failed"],
      default: "Pending",
    },
    verificationError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for filtering by difficulty alone or difficulty + tag
problemSchema.index({ difficulty: 1, tags: 1 });
// Multikey index for filtering by tag alone (without difficulty)
problemSchema.index({ tags: 1 });
// Text index for keyword search on problem titles
problemSchema.index({ title: "text" });

const Problem = mongoose.model("Problem", problemSchema);

module.exports = Problem;
