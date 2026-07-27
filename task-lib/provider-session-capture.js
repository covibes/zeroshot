import { extractProviderSessionId } from './provider-helper-runtime.js';

/**
 * Capture a provider-owned session ID from one complete output line.
 *
 * The caller owns persistence so watcher variants can share parsing without
 * importing each other's process lifecycle. Repeated IDs are idempotent; any
 * differing ID makes the capture permanently ambiguous.
 */
export function captureProviderSessionLine({
  providerName,
  line,
  currentSessionId = null,
  observedSessionIds = new Set(currentSessionId ? [currentSessionId] : []),
  sessionIdConflict = false,
  onCapture,
  onConflict = () => {},
}) {
  const sessionId = extractProviderSessionId(providerName, line);
  if (!sessionId) {
    return { currentSessionId, sessionIdConflict };
  }

  observedSessionIds.add(sessionId);
  if (sessionIdConflict || observedSessionIds.size > 1) {
    if (!sessionIdConflict) {
      onConflict([...observedSessionIds]);
    }
    return { currentSessionId: null, sessionIdConflict: true };
  }

  if (sessionId === currentSessionId) {
    return { currentSessionId, sessionIdConflict: false };
  }
  onCapture(sessionId);
  return { currentSessionId: sessionId, sessionIdConflict: false };
}

export function createProviderSessionCapture({
  providerName,
  taskId,
  updateTask,
  log,
  initialSessionId = null,
  initialSessionIdConflict = false,
}) {
  let currentSessionId = initialSessionId;
  let sessionIdConflict = initialSessionIdConflict;
  const observedSessionIds = new Set(initialSessionId ? [initialSessionId] : []);
  return (line) => {
    try {
      ({ currentSessionId, sessionIdConflict } = captureProviderSessionLine({
        providerName,
        line,
        currentSessionId,
        observedSessionIds,
        sessionIdConflict,
        onCapture: (sessionId) => updateTask(taskId, { sessionId }),
        onConflict: () => updateTask(taskId, { sessionId: null, sessionIdConflict: true }),
      }));
    } catch (error) {
      log(`[${Date.now()}][SESSION] Failed to persist provider session: ${error.message}\n`);
    }
  };
}
