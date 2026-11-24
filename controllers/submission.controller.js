const Problem = require("../models/problem.model");
const Submission = require("../models/submission.model");
const User = require("../models/user");
const { isValidObjectId } = require("../utils/validator");
const { submissionQueue, submissionEvents } = require("../config/queue");
const {
  getLanguageById,
  submitBatch,
  getBatchResults,
  wait,
} = require("../utils/problem.service");

/**
 * Maps Judge0 status IDs to our Submission schema enum values.
 */
const mapJudge0Status = (statusId, statusDesc) => {
  if (statusId === 3) return "Accepted";
  if (statusId === 4) return "Wrong Answer";
  if (statusId === 5) return "Time Limit Exceeded";
  if (statusId === 6) return "Compilation Error";
  if (statusId >= 7 && statusId <= 12) return "Runtime Error";
  if (statusDesc && statusDesc.toLowerCase().includes("memory")) {
    return "Memory Limit Exceeded";
  }
  if (statusDesc && statusDesc.startsWith("Runtime Error")) {
    return "Runtime Error";
  }
  return statusDesc || "Wrong Answer";
};

/**
 * Controller to handle user code submissions.
 * 1. Validates problem ID, language, and non-empty code.
 * 2. Fetches the problem and its test cases (visible + hidden).
 * 3. Saves the initial submission to MongoDB with status "Pending".
 * 4. Submits the code batch to OnlineCompiler/Judge0.
 * 5. Polls for evaluation results.
 * 6. Updates the submission in MongoDB with runtime metrics, passed test cases, and verdict.
 */
const submitCode = async (req, res) => {
  try {
    const { problemId } = req.params;
    const { language, code } = req.body;

    // 1. Validate Problem ID
    if (!problemId || !isValidObjectId(problemId)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    // 2. Validate Code & Language
    if (!code || typeof code !== "string" || code.trim() === "") {
      return res.status(400).json({ message: "Code is required and cannot be empty." });
    }

    if (!language) {
      return res.status(400).json({ message: "Language is required." });
    }

    const languageId = getLanguageById(language);
    if (!languageId) {
      return res.status(400).json({
        message: `Unsupported language: "${language}". Only C++ and Python are supported.`,
      });
    }

    // Normalize language string for schema enum ("cpp" or "python")
    const normalizedLang =
      language.toLowerCase().trim() === "c++" ? "cpp" : language.toLowerCase().trim();

    // 3. Find problem in MongoDB
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: "Problem not found." });
    }

    // Combine visible and hidden test cases
    const allTestCases = [
      ...(problem.visibleTestCases || []),
      ...(problem.hiddenTestCases || []),
    ];

    if (allTestCases.length === 0) {
      return res.status(400).json({
        message: "Problem has no test cases configured for evaluation.",
      });
    }

    // 4. Save submission into MongoDB FIRST with status "Pending"
    const submission = new Submission({
      userId: req.user._id,
      problemId: problem._id,
      code,
      language: normalizedLang,
      status: "Pending",
      totalTestCases: allTestCases.length,
    });

    await submission.save();

    // 5. Enqueue evaluation job to BullMQ background queue
    // Decouples evaluation from HTTP request to prevent synchronous socket hangs and 504 Gateway Timeouts
    await submissionQueue.add("evaluate-submission", {
      submissionId: submission._id.toString(),
      problemId: problem._id.toString(),
      userId: req.user._id.toString(),
      code,
      language: normalizedLang,
      languageId,
    });

    // 6. Return immediate 202 Accepted response in ~20ms
    return res.status(202).json({
      message: "Code submission queued for background evaluation",
      submissionId: submission._id,
      status: "Queued",
      submission: {
        id: submission._id,
        problemId: submission.problemId,
        status: "Pending",
        time: "0s",
        memory: "0 KB",
        testCasesPassed: 0,
        totalTestCases: submission.totalTestCases,
        errorMessage: null,
        compileOutput: null,
        createdAt: submission.createdAt,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Retrieves all unique problems solved by the logged-in user.
 * Displays problem ID, difficulty, title, and tags.
 */
const getSolvedProblems = async (req, res) => {
  try {
    let user = await User.findById(req.user._id).populate({
      path: "problemsSolved",
      select: "_id title difficulty tags",
    });

    // Auto-sync with Submission history in case of any prior Accepted submissions
    const distinctProblemIds = await Submission.find({
      userId: req.user._id,
      status: "Accepted",
    }).distinct("problemId");

    if (
      distinctProblemIds.length > 0 &&
      (!user.problemsSolved || user.problemsSolved.length < distinctProblemIds.length)
    ) {
      user = await User.findByIdAndUpdate(
        req.user._id,
        { $addToSet: { problemsSolved: { $each: distinctProblemIds } } },
        { new: true }
      ).populate({
        path: "problemsSolved",
        select: "_id title difficulty tags",
      });
    }

    res.status(200).json({
      count: user.problemsSolved?.length || 0,
      solvedProblems: user.problemsSolved || [],
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

/**
 * Controller to "Run Code" against visible example test cases only.
 * 1. Does NOT save to database (no Submission or User records created/modified).
 * 2. Runs solely against visibleTestCases.
 * 3. Returns per-testcase input, expected output, and actual stdout so users can test before submitting.
 */
const runCode = async (req, res) => {
  try {
    const { problemId } = req.params;
    const { language, code } = req.body;

    // 1. Validate Problem ID
    if (!problemId || !isValidObjectId(problemId)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    // 2. Validate Code & Language
    if (!code || typeof code !== "string" || code.trim() === "") {
      return res.status(400).json({ message: "Code is required and cannot be empty." });
    }

    if (!language) {
      return res.status(400).json({ message: "Language is required." });
    }

    const languageId = getLanguageById(language);
    if (!languageId) {
      return res.status(400).json({
        message: `Unsupported language: "${language}". Only C++ and Python are supported.`,
      });
    }

    // 3. Find problem in MongoDB
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: "Problem not found." });
    }

    // Run Code evaluates ONLY against visible test cases
    const testCases = problem.visibleTestCases;
    if (!testCases || testCases.length === 0) {
      return res.status(400).json({
        message: "Problem has no visible test cases configured to run against.",
      });
    }

    // 4. Construct batch submissions (NO DATABASE WRITE)
    const submissions = testCases.map((tc) => ({
      source_code: code,
      language_id: languageId,
      stdin: tc.input,
      expected_output: tc.output,
    }));

    // 5. Submit batch to OnlineCompiler
    let submitResult;
    try {
      submitResult = await submitBatch(submissions);
    } catch (judgeErr) {
      return res.status(502).json({
        message: "Compiler service error while running code.",
        error:
          judgeErr.response?.data?.error ||
          judgeErr.response?.data ||
          judgeErr.message,
      });
    }

    const tokens = submitResult.map((item) => item.token);

    // 6. Poll until compilation and execution complete
    let testResult = await getBatchResults(tokens);
    let attempts = 0;
    const maxAttempts = 15;

    while (
      testResult?.submissions?.some(
        (s) => s.status.id === 1 || s.status.id === 2
      ) &&
      attempts < maxAttempts
    ) {
      attempts++;
      await wait(1000);
      testResult = await getBatchResults(tokens);
    }

    // 7. Analyze execution results across visible test cases
    let testCasesPassed = 0;
    let finalStatus = "Accepted";
    let maxTime = 0;
    let maxMemory = 0;
    const testCaseResults = [];

    for (let i = 0; i < testResult.submissions.length; i++) {
      const sub = testResult.submissions[i];
      const tc = testCases[i];
      const statusId = sub.status.id;
      const statusDesc = sub.status.description;

      if (sub.time && parseFloat(sub.time) > maxTime) {
        maxTime = parseFloat(sub.time);
      }
      if (sub.memory && parseInt(sub.memory, 10) > maxMemory) {
        maxMemory = parseInt(sub.memory, 10);
      }

      const isPassed = statusId === 3;
      if (isPassed) {
        testCasesPassed++;
      } else if (finalStatus === "Accepted") {
        finalStatus = mapJudge0Status(statusId, statusDesc);
      }

      testCaseResults.push({
        testCase: i + 1,
        input: tc.input,
        expectedOutput: tc.output,
        actualOutput: sub.stdout || "",
        status: statusDesc || "Wrong Answer",
        passed: isPassed,
        time: sub.time ? `${sub.time}s` : null,
        memory: sub.memory ? `${sub.memory} KB` : null,
        error: sub.stderr || sub.compile_output || sub.message || null,
      });
    }

    // 8. Return response directly (NO DATABASE STORAGE)
    res.status(200).json({
      message: "Code run finished",
      status: finalStatus,
      testCasesPassed,
      totalTestCases: testCases.length,
      runtime: `${maxTime}s`,
      memory: `${maxMemory} KB`,
      results: testCaseResults,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Retrieves all submissions for a given problem submitted by the logged-in user.
 * Leverages the compound index on { userId: 1, problemId: 1, createdAt: -1 }.
 */
const getUserProblemSubmissions = async (req, res) => {
  try {
    const { problemId } = req.params;
    const userId = req.user._id;

    // 1. Validate Problem ID
    if (!isValidObjectId(problemId)) {
      return res.status(400).json({ message: "Invalid problem ID format." });
    }

    // 2. Verify problem exists
    const problem = await Problem.findById(problemId).select("_id title");
    if (!problem) {
      return res.status(404).json({ message: "Problem not found." });
    }

    // 3. Query submissions using compound index (userId + problemId + createdAt)
    const submissions = await Submission.find({
      userId,
      problemId,
    })
      .sort({ createdAt: -1 })
      .select(
        "_id userId problemId language status time memory testCasesPassed totalTestCases errorMessage compileOutput code createdAt"
      );

    res.status(200).json({
      message: "Submissions retrieved successfully",
      problemId: problem._id,
      problemTitle: problem.title,
      count: submissions.length,
      submissions,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Server-Sent Events (SSE) endpoint to push real-time evaluation updates to the client.
 * GET /submit/events/:submissionId
 */
const getSubmissionStream = async (req, res) => {
  try {
    const { submissionId } = req.params;

    if (!submissionId || !isValidObjectId(submissionId)) {
      return res.status(400).json({ message: "Invalid submission ID format." });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ message: "Submission not found." });
    }

    // Ensure the requesting user owns the submission
    if (submission.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized access to submission events." });
    }

    // Configure headers for Server-Sent Events
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    // If the submission is already finalized, stream result and close connection
    if (submission.status !== "Pending") {
      res.write(
        `data: ${JSON.stringify({
          status: submission.status,
          submission: {
            id: submission._id,
            problemId: submission.problemId,
            status: submission.status,
            time: `${submission.time}s`,
            memory: `${submission.memory} KB`,
            testCasesPassed: submission.testCasesPassed,
            totalTestCases: submission.totalTestCases,
            errorMessage: submission.errorMessage,
            compileOutput: submission.compileOutput,
            createdAt: submission.createdAt,
          },
        })}\n\n`
      );
      return res.end();
    }

    // Send initial pending event
    res.write(
      `data: ${JSON.stringify({
        status: "Pending",
        submissionId: submission._id,
        message: "Submission is being evaluated by background worker...",
      })}\n\n`
    );

    // Keep-alive heartbeat comment every 15s to keep proxy connections alive
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 15000);

    const eventName = `submission:${submissionId}`;
    const onResult = (data) => {
      clearInterval(keepAlive);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.end();
    };

    submissionEvents.once(eventName, onResult);

    // Clean up when client disconnects or aborts
    req.on("close", () => {
      clearInterval(keepAlive);
      submissionEvents.removeListener(eventName, onResult);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Polling fallback endpoint to fetch current status of a submission.
 * GET /submit/status/:submissionId
 */
const getSubmissionStatus = async (req, res) => {
  try {
    const { submissionId } = req.params;

    if (!submissionId || !isValidObjectId(submissionId)) {
      return res.status(400).json({ message: "Invalid submission ID format." });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ message: "Submission not found." });
    }

    if (submission.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized access to submission." });
    }

    res.status(200).json({
      status: submission.status,
      submission: {
        id: submission._id,
        problemId: submission.problemId,
        status: submission.status,
        time: `${submission.time}s`,
        memory: `${submission.memory} KB`,
        testCasesPassed: submission.testCasesPassed,
        totalTestCases: submission.totalTestCases,
        errorMessage: submission.errorMessage,
        compileOutput: submission.compileOutput,
        createdAt: submission.createdAt,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  submitCode,
  runCode,
  getSolvedProblems,
  getUserProblemSubmissions,
  getSubmissionStream,
  getSubmissionStatus,
};

