const { Queue, QueueEvents } = require("bullmq");
const EventEmitter = require("events");

// Event bus for Server-Sent Events (SSE) and worker communication
class SubmissionEventBus extends EventEmitter {}
const submissionEvents = new SubmissionEventBus();
submissionEvents.setMaxListeners(100); // Allow multiple SSE client subscribers

// BullMQ / ioredis connection options
const redisConnection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASS || undefined,
  username: "default",
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// 1. Submission Evaluation Queue (BullMQ)
const submissionQueue = new Queue("submissionQueue", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

submissionQueue.on("error", (err) => {
  console.error("BullMQ submissionQueue error:", err.message);
});

// 2. Problem Reference Solution Verification Queue (BullMQ)
const problemVerificationQueue = new Queue("problemVerificationQueue", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

problemVerificationQueue.on("error", (err) => {
  console.error("BullMQ problemVerificationQueue error:", err.message);
});

// QueueEvents to listen for Redis stream job events across processes
const submissionQueueEvents = new QueueEvents("submissionQueue", {
  connection: redisConnection,
});

submissionQueueEvents.on("error", (err) => {
  console.error("BullMQ submissionQueueEvents error:", err.message);
});

submissionQueueEvents.on("completed", ({ jobId, returnvalue }) => {
  if (returnvalue && returnvalue.submissionId) {
    submissionEvents.emit(`submission:${returnvalue.submissionId}`, {
      status: returnvalue.status,
      submission: returnvalue,
    });
  }
});

submissionQueueEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`BullMQ job ${jobId} failed:`, failedReason);
});

module.exports = {
  redisConnection,
  submissionQueue,
  problemVerificationQueue,
  submissionEvents,
  submissionQueueEvents,
};
