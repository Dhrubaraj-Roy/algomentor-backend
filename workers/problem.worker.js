const { Worker } = require("bullmq");
const Problem = require("../models/problem.model");
const { redisConnection } = require("../config/queue");
const {
  getLanguageById,
  submitBatch,
  getBatchResults,
  wait,
} = require("../utils/problem.service");

let problemWorkerInstance = null;

const createProblemWorker = () => {
  if (problemWorkerInstance) return problemWorkerInstance;

  problemWorkerInstance = new Worker(
    "problemVerificationQueue",
    async (job) => {
      const { problemId } = job.data;

      const problem = await Problem.findById(problemId);
      if (!problem) {
        throw new Error(`Problem ${problemId} not found`);
      }

      const allTestCases = [
        ...(problem.visibleTestCases || []),
        ...(problem.hiddenTestCases || []),
      ];

      const refSolutions = problem.referenceSolution || [];
      const submissions = [];

      for (const refSol of refSolutions) {
        const languageId = getLanguageById(refSol.language);
        if (!languageId) continue;

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
        problem.isVerified = true;
        problem.verificationStatus = "Accepted";
        problem.verificationError = null;
        await problem.save();
        return { isVerified: true, status: "Accepted" };
      }

      let submitResult;
      try {
        submitResult = await submitBatch(submissions);
      } catch (judgeErr) {
        const errMsg =
          judgeErr.response?.data?.error ||
          judgeErr.response?.data ||
          judgeErr.message;
        problem.isVerified = false;
        problem.verificationStatus = "Failed";
        problem.verificationError = errMsg;
        await problem.save();
        return { isVerified: false, status: "Failed", error: errMsg };
      }

      const tokens = submitResult.map((item) => item.token);
      let testResult = await getBatchResults(tokens);
      let attempts = 0;
      const maxAttempts = 30;

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

      let allPassed = true;
      let failureReason = null;

      if (testResult && Array.isArray(testResult.submissions)) {
        for (let i = 0; i < testResult.submissions.length; i++) {
          const sub = testResult.submissions[i];
          if (sub.status.id !== 3) {
            allPassed = false;
            failureReason =
              sub.status.description ||
              sub.compile_output ||
              sub.stderr ||
              sub.message ||
              "Test case failed";
            break;
          }
        }
      } else {
        allPassed = false;
        failureReason = "Invalid response from compiler service";
      }

      problem.isVerified = allPassed;
      problem.verificationStatus = allPassed ? "Accepted" : "Failed";
      problem.verificationError = allPassed ? null : failureReason;
      await problem.save();

      return {
        isVerified: allPassed,
        status: allPassed ? "Accepted" : "Failed",
        error: problem.verificationError,
      };
    },
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  problemWorkerInstance.on("error", (err) => {
    console.error("BullMQ Problem Worker error:", err.message);
  });

  problemWorkerInstance.on("completed", (job, result) => {
    console.log(
      `[BullMQ] Problem ${job.data.problemId} verification finished: ${result.status}`
    );
  });

  problemWorkerInstance.on("failed", (job, err) => {
    console.error(
      `[BullMQ] Problem ${job?.data?.problemId} verification job failed:`,
      err.message
    );
  });

  return problemWorkerInstance;
};

module.exports = {
  createProblemWorker,
};
