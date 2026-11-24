const { Worker } = require("bullmq");
const Submission = require("../models/submission.model");
const Problem = require("../models/problem.model");
const User = require("../models/user");
const { redisConnection, submissionEvents } = require("../config/queue");
const {
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

let submissionWorkerInstance = null;

const createSubmissionWorker = () => {
  if (submissionWorkerInstance) return submissionWorkerInstance;

  submissionWorkerInstance = new Worker(
    "submissionQueue",
    async (job) => {
      const {
        submissionId,
        problemId,
        userId,
        code,
        language,
        languageId,
      } = job.data;

      // 1. Fetch submission from database
      const submission = await Submission.findById(submissionId);
      if (!submission) {
        throw new Error(`Submission ${submissionId} not found`);
      }

      // 2. Fetch problem and test cases
      const problem = await Problem.findById(problemId);
      if (!problem) {
        submission.status = "Internal Error";
        submission.errorMessage = "Problem record could not be found for evaluation.";
        await submission.save();

        const payload = {
          submissionId: submission._id.toString(),
          id: submission._id.toString(),
          problemId,
          status: submission.status,
          time: "0s",
          memory: "0 KB",
          testCasesPassed: 0,
          totalTestCases: submission.totalTestCases || 0,
          errorMessage: submission.errorMessage,
          compileOutput: null,
          createdAt: submission.createdAt,
        };
        submissionEvents.emit(`submission:${submissionId}`, {
          status: submission.status,
          submission: payload,
        });
        return payload;
      }

      const allTestCases = [
        ...(problem.visibleTestCases || []),
        ...(problem.hiddenTestCases || []),
      ];

      if (allTestCases.length === 0) {
        submission.status = "Internal Error";
        submission.errorMessage = "Problem has no test cases configured for evaluation.";
        await submission.save();

        const payload = {
          submissionId: submission._id.toString(),
          id: submission._id.toString(),
          problemId,
          status: submission.status,
          time: "0s",
          memory: "0 KB",
          testCasesPassed: 0,
          totalTestCases: 0,
          errorMessage: submission.errorMessage,
          compileOutput: null,
          createdAt: submission.createdAt,
        };
        submissionEvents.emit(`submission:${submissionId}`, {
          status: submission.status,
          submission: payload,
        });
        return payload;
      }

      // 3. Construct batch submissions for OnlineCompiler / Judge0
      const submissions = allTestCases.map((tc) => ({
        source_code: code,
        language_id: languageId,
        stdin: tc.input,
        expected_output: tc.output,
      }));

      // 4. Submit batch to compiler service
      let submitResult;
      try {
        submitResult = await submitBatch(submissions);
      } catch (judgeErr) {
        submission.status = "Internal Error";
        submission.errorMessage =
          judgeErr.response?.data?.error ||
          judgeErr.response?.data ||
          judgeErr.message;
        await submission.save();

        const payload = {
          submissionId: submission._id.toString(),
          id: submission._id.toString(),
          problemId: submission.problemId,
          status: submission.status,
          time: "0s",
          memory: "0 KB",
          testCasesPassed: 0,
          totalTestCases: allTestCases.length,
          errorMessage: submission.errorMessage,
          compileOutput: null,
          createdAt: submission.createdAt,
        };
        submissionEvents.emit(`submission:${submissionId}`, {
          status: submission.status,
          submission: payload,
        });
        return payload;
      }

      const tokens = submitResult.map((item) => item.token);

      // 5. Poll compiler service in background worker (Non-blocking to Express HTTP sockets)
      let testResult = await getBatchResults(tokens);
      let attempts = 0;
      const maxAttempts = 30; // Max 30 seconds inside background worker

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

      // 6. Analyze execution results across all test cases
      let testCasesPassed = 0;
      let finalStatus = "Accepted";
      let maxTime = 0;
      let maxMemory = 0;
      let errorMessage = null;
      let compileOutput = null;

      if (testResult && Array.isArray(testResult.submissions)) {
        for (let i = 0; i < testResult.submissions.length; i++) {
          const sub = testResult.submissions[i];
          const statusId = sub.status.id;
          const statusDesc = sub.status.description;

          if (sub.time && parseFloat(sub.time) > maxTime) {
            maxTime = parseFloat(sub.time);
          }
          if (sub.memory && parseInt(sub.memory, 10) > maxMemory) {
            maxMemory = parseInt(sub.memory, 10);
          }

          if (statusId === 3) {
            testCasesPassed++;
          } else if (finalStatus === "Accepted") {
            finalStatus = mapJudge0Status(statusId, statusDesc);
            errorMessage = sub.stderr || sub.message || null;
            compileOutput = sub.compile_output || null;
          }
        }
      } else {
        finalStatus = "Internal Error";
        errorMessage = "Did not receive valid results from evaluation provider.";
      }

      // 7. Update the submission document in MongoDB
      submission.status = finalStatus;
      submission.time = maxTime;
      submission.memory = maxMemory;
      submission.testCasesPassed = testCasesPassed;
      submission.totalTestCases = allTestCases.length;
      submission.errorMessage = errorMessage;
      submission.compileOutput = compileOutput;

      await submission.save();

      // 8. If submission is Accepted, atomically record problemId in user's problemsSolved
      if (finalStatus === "Accepted" && userId) {
        await User.findByIdAndUpdate(userId, {
          $addToSet: { problemsSolved: problem._id },
        });
      }

      const payload = {
        submissionId: submission._id.toString(),
        id: submission._id.toString(),
        problemId: submission.problemId,
        status: submission.status,
        time: `${submission.time}s`,
        memory: `${submission.memory} KB`,
        testCasesPassed: submission.testCasesPassed,
        totalTestCases: submission.totalTestCases,
        errorMessage: submission.errorMessage,
        compileOutput: submission.compileOutput,
        createdAt: submission.createdAt,
      };

      // 9. Push evaluation results to active SSE subscribers
      submissionEvents.emit(`submission:${submissionId}`, {
        status: submission.status,
        submission: payload,
      });

      return payload;
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  submissionWorkerInstance.on("error", (err) => {
    console.error("BullMQ Submission Worker error:", err.message);
  });

  submissionWorkerInstance.on("completed", (job, returnvalue) => {
    console.log(`[BullMQ] Submission ${job.data.submissionId} evaluated: ${returnvalue.status}`);
  });

  submissionWorkerInstance.on("failed", (job, err) => {
    console.error(`[BullMQ] Submission ${job?.data?.submissionId} failed:`, err.message);
  });

  return submissionWorkerInstance;
};

module.exports = {
  createSubmissionWorker,
  mapJudge0Status,
};
