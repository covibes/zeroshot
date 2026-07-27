const COMMAND_CLEANUP_OWNER = Object.freeze({
  CALLER: 'caller',
  TASK_LIFECYCLE: 'task-lifecycle',
});

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Mark a wrapper failure as occurring after the wrapper process started. At
 * that point task persistence may already have happened, even if human stdout
 * is malformed or the wrapper later exits non-zero.
 */
function transferCommandCleanupOwnership(error) {
  const normalized = normalizeError(error);
  normalized.commandCleanupOwner = COMMAND_CLEANUP_OWNER.TASK_LIFECYCLE;
  return normalized;
}

function callerOwnsCommandCleanup(error) {
  return error?.commandCleanupOwner !== COMMAND_CLEANUP_OWNER.TASK_LIFECYCLE;
}

function cleanupCallerOwnedCommand(error, cleanup) {
  if (callerOwnsCommandCleanup(error)) cleanup();
}

function requireTaskIdFromWrapperResult({ code, stdout, stderr, parseTaskId }) {
  if (code !== 0) {
    throw new Error(`zeroshot task run failed with code ${code}: ${stderr}`);
  }
  const taskId = parseTaskId(stdout);
  if (!taskId) {
    throw new Error(`Could not parse task ID from output: ${stdout}`);
  }
  return taskId;
}

function trackTaskWrapperCleanupOwnership(wrapperProcess) {
  let wrapperStarted = false;
  wrapperProcess.once('spawn', () => {
    wrapperStarted = true;
  });
  return (error) => (wrapperStarted ? transferCommandCleanupOwnership(error) : error);
}

module.exports = {
  COMMAND_CLEANUP_OWNER,
  cleanupCallerOwnedCommand,
  requireTaskIdFromWrapperResult,
  trackTaskWrapperCleanupOwnership,
};
