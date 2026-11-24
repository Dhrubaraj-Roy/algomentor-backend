const { createSubmissionWorker } = require("./submission.worker");
const { createProblemWorker } = require("./problem.worker");

let submissionWorker = null;
let problemWorker = null;

const initWorkers = () => {
  if (!submissionWorker) {
    submissionWorker = createSubmissionWorker();
  }
  if (!problemWorker) {
    problemWorker = createProblemWorker();
  }
  return {
    submissionWorker,
    problemWorker,
  };
};

const closeWorkers = async () => {
  const promises = [];
  if (submissionWorker) {
    promises.push(submissionWorker.close());
    submissionWorker = null;
  }
  if (problemWorker) {
    promises.push(problemWorker.close());
    problemWorker = null;
  }
  await Promise.all(promises);
};

module.exports = {
  initWorkers,
  closeWorkers,
};
