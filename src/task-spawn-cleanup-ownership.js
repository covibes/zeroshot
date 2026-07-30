const { randomUUID } = require('node:crypto');
const { parseTaskStartupError } = require('./task-startup-error');

const TASK_SPAWN_OWNERSHIP_TOKEN_ENV = 'ZEROSHOT_TASK_SPAWN_OWNERSHIP_TOKEN';

const COMMAND_CLEANUP_OWNER = Object.freeze({
  CALLER: 'caller',
  TASK_LIFECYCLE: 'task-lifecycle',
});

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Mark a wrapper failure after the detached task record durably accepted the
 * launch ownership token. Human stdout and process spawn events are not
 * ownership receipts.
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

function requireTaskIdFromWrapperResult({
  code,
  stdout,
  stderr,
  parseTaskId,
  persistedTaskId = null,
}) {
  if (code !== 0) {
    const startupError = parseTaskStartupError(stderr);
    if (startupError) throw startupError;
    throw new Error(`zeroshot task run failed with code ${code}: ${stderr}`);
  }
  if (!persistedTaskId) {
    const printedTaskId = parseTaskId(stdout);
    throw new Error(
      `Detached task ownership receipt was not persisted${
        printedTaskId ? ` for wrapper output ${printedTaskId}` : ''
      }.`
    );
  }
  const printedTaskId = parseTaskId(stdout);
  if (printedTaskId && printedTaskId !== persistedTaskId) {
    throw new Error(
      `Task ownership receipt ${persistedTaskId} did not match wrapper output ${printedTaskId}.`
    );
  }
  return persistedTaskId;
}

function createTaskSpawnOwnershipToken() {
  return randomUUID();
}

function trackTaskWrapperCleanupOwnership(findPersistedTaskId) {
  return (error) => {
    try {
      return findPersistedTaskId() ? transferCommandCleanupOwnership(error) : error;
    } catch {
      return transferCommandCleanupOwnership(error);
    }
  };
}

module.exports = {
  COMMAND_CLEANUP_OWNER,
  TASK_SPAWN_OWNERSHIP_TOKEN_ENV,
  cleanupCallerOwnedCommand,
  callerOwnsCommandCleanup,
  createTaskSpawnOwnershipToken,
  requireTaskIdFromWrapperResult,
  trackTaskWrapperCleanupOwnership,
};
