const jwt = require("jsonwebtoken");
const Problem = require("../models/problem.model");
const { isValidObjectId } = require("../utils/validator");
const { getLanguageById } = require("../utils/problem.service");
const { problemVerificationQueue } = require("../config/queue");

// Allowlist of safe fields exposed to public / non-admin viewers (Default Deny / Principle of Least Privilege)
const PUBLIC_PROBLEM_FIELDS =
  "title description difficulty tags visibleTestCases startCode problemCreator";

// 1. Create a new problem (Admin only)
const createProblem = async (req, res) => {
  try {
    const {
      title,
      description,
      difficulty,
      tags,
      visibleTestCases,
      hiddenTestCases,
      startCode,
      referenceSolution,
    } = req.body;

    // Validate required fields
    if (!title || !description || !difficulty) {
      return res.status(400).json({
        message: "Title, description, and difficulty are required.",
      });
    }

    const normalizedDifficulty = difficulty.toLowerCase().trim();
    if (!["easy", "medium", "hard"].includes(normalizedDifficulty)) {
      return res.status(400).json({
        message: "Difficulty must be 'easy', 'medium', or 'hard'.",
      });
    }

    const refSolutions = Array.isArray(referenceSolution)
      ? referenceSolution
      : referenceSolution
      ? [referenceSolution]
      : [];

    // Combine test cases for Judge0 submission array
    const allTestCases = [
      ...(visibleTestCases || []),
      ...(hiddenTestCases || []),
    ];

    // Build the submissions array:
    // - source_code: complete code
    // - language_id: language's ID
    // - stdin: input
    // - expected_output: output
    const submissions = [];

    for (const refSol of refSolutions) {
      const languageId = getLanguageById(refSol.language);
      if (!languageId) {
        return res.status(400).json({
          message: `Unsupported language: "${refSol.language}". Only C++ and Python are supported.`,
        });
      }

      for (const tc of allTestCases) {
        submissions.push({
          source_code: refSol.completeCode,
          language_id: languageId,
          stdin: tc.input,
          expected_output: tc.output,
        });
      }
    }

    if (submissions.length === 0) {
      return res.status(400).json({
        message: "At least one reference solution and test case are required.",
      });
    }

    // Save problem to database immediately with pending verification status
    const problem = new Problem({
      title,
      description,
      difficulty: normalizedDifficulty,
      tags: tags || [],
      visibleTestCases: visibleTestCases || [],
      hiddenTestCases: hiddenTestCases || [],
      startCode: startCode || [],
      referenceSolution: refSolutions,
      problemCreator: req.user._id,
      isVerified: false,
      verificationStatus: "Pending",
    });

    await problem.save();

    // Enqueue verification job to BullMQ background queue
    // Decouples verification from HTTP request to prevent 15s synchronous socket hangs
    await problemVerificationQueue.add("verify-problem", {
      problemId: problem._id.toString(),
    });

    // Respond immediately in ~20ms
    res.status(201).json({
      message: "Problem created successfully and queued for background verification",
      problem,
      verification: {
        totalTestCases: submissions.length,
        status: "Queued",
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.response?.data || err.message });
  }
};

// 2. Update an existing problem (Admin only)
const updateProblem = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    const allowedUpdates = [
      "title",
      "description",
      "difficulty",
      "tags",
      "visibleTestCases",
      "hiddenTestCases",
      "startCode",
      "referenceSolution",
    ];

    const updates = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        if (key === "difficulty") {
          const normalized = req.body[key].toLowerCase().trim();
          if (!["easy", "medium", "hard"].includes(normalized)) {
            return res.status(400).json({
              message: "Difficulty must be 'easy', 'medium', or 'hard'.",
            });
          }
          updates[key] = normalized;
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    if (updates.referenceSolution) {
      const refSolutions = Array.isArray(updates.referenceSolution)
        ? updates.referenceSolution
        : [updates.referenceSolution];
      for (const refSol of refSolutions) {
        if (!getLanguageById(refSol.language)) {
          return res.status(400).json({
            message: `Unsupported language: "${refSol.language}". Only C++ and Python are supported.`,
          });
        }
      }
    }

    const updatedProblem = await Problem.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updatedProblem) {
      return res.status(404).json({ message: "Problem not found" });
    }

    res.status(200).json({
      message: "Problem updated successfully",
      problem: updatedProblem,
    });
  } catch (err) {
    res.status(400).json({ "here is the error": err.message });
  }
};

// 3. Delete a problem (Admin only)
const deleteProblem = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    const deletedProblem = await Problem.findByIdAndDelete(id);
    if (!deletedProblem) {
      return res.status(404).json({ message: "Problem not found" });
    }

    res.status(200).json({
      message: "Problem deleted successfully",
      id: deletedProblem._id,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// 4. Get all problems (Public / Normal User)
// Hidden test cases and reference solutions are excluded for regular users
const getAllProblems = async (req, res) => {
  try {
    const { difficulty, tag, page, limit } = req.query;

    const filter = {};
    if (difficulty) {
      filter.difficulty = difficulty.toLowerCase().trim();
    }
    if (tag) {
      filter.tags = tag.toLowerCase().trim();
    }

    // Pagination parameters (default page: 1, default limit: 10)
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (pageNum - 1) * limitNum;

    // Total problems matching filter
    const totalProblems = await Problem.countDocuments(filter);

    // Field Allowlisting: Exclude hidden test cases and reference solution by default
    const problems = await Problem.find(filter)
      .select(PUBLIC_PROBLEM_FIELDS)
      .populate("problemCreator", "firstName lastName emailId")
      .skip(skip)
      .limit(limitNum);

    res.status(200).json({
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalProblems / limitNum),
      totalProblems,
      count: problems.length,
      problems,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// 5. Get one problem by ID (Public / Normal User)
// Uses field allowlisting so secret fields (hidden test cases, reference solutions) are never leaked to non-admins
const getProblemById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    // Determine if requester is an admin (from middleware req.user or optional token check)
    let isAdmin = req.user?.role === "admin";
    if (!isAdmin && (req.cookies?.token || req.headers?.authorization)) {
      try {
        const token =
          req.cookies?.token ||
          req.headers?.authorization?.replace("Bearer ", "");
        if (token) {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          if (decoded?.role === "admin") {
            isAdmin = true;
          }
        }
      } catch (_) {
        isAdmin = false;
      }
    }

    const query = Problem.findById(id).populate(
      "problemCreator",
      "firstName lastName emailId"
    );

    // Field Allowlisting: Non-admins strictly receive only the allowlisted public fields
    if (!isAdmin) {
      query.select(PUBLIC_PROBLEM_FIELDS);
    }

    const problem = await query;
    if (!problem) {
      return res.status(404).json({ message: "Problem not found" });
    }

    res.status(200).json({ problem });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// 6. Solve / Submit a problem (Normal User - requires login)
const solveProblem = async (req, res) => {
  try {
    const { id } = req.params;
    const { language, code } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    if (!language || !code) {
      return res.status(400).json({
        message: "Language and code are required to submit a solution.",
      });
    }

    const problem = await Problem.findById(id);
    if (!problem) {
      return res.status(404).json({ message: "Problem not found" });
    }

    // Acknowledge submission (code execution engine will evaluate this against hidden test cases)
    res.status(200).json({
      message: "Solution submitted successfully for evaluation",
      problemId: problem._id,
      title: problem.title,
      submittedBy: {
        id: req.user._id,
        emailId: req.user.emailId,
      },
      language,
      code,
      status: "Pending Evaluation",
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

module.exports = {
  createProblem,
  updateProblem,
  deleteProblem,
  getAllProblems,
  getProblemById,
  solveProblem,
};
