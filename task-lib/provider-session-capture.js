import { extractProviderSessionId } from './provider-helper-runtime.js';

/**
 * Capture a provider-owned session ID from one complete output line.
 *
 * The caller owns persistence so watcher variants can share parsing without
 * importing each other's process lifecycle. Returning the prior ID for
 * duplicate events avoids redundant task-store writes.
 */
export function captureProviderSessionLine({
  providerName,
  line,
  currentSessionId = null,
  onCapture,
}) {
  const sessionId = extractProviderSessionId(providerName, line);
  if (!sessionId || sessionId === currentSessionId) {
    return currentSessionId;
  }
  onCapture(sessionId);
  return sessionId;
}

export function createProviderSessionCapture({ providerName, taskId, updateTask, log }) {
  let currentSessionId = null;
  return (line) => {
    try {
      currentSessionId = captureProviderSessionLine({
        providerName,
        line,
        currentSessionId,
        onCapture: (sessionId) => updateTask(taskId, { sessionId }),
      });
    } catch (error) {
      log(`[${Date.now()}][SESSION] Failed to persist provider session: ${error.message}\n`);
    }
  };
}
