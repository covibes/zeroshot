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
  onCapture = () => {},
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

function providerSessionCompletionError({
  requestedSessionId,
  currentSessionId,
  sessionIdConflict,
  persistenceError,
}) {
  if (persistenceError) {
    return `Provider session identity could not be persisted: ${persistenceError.message}`;
  }

  const requested = requestedSessionId?.trim() || null;
  if (!requested) {
    return null;
  }
  if (sessionIdConflict) {
    return 'Provider continuation emitted conflicting session identities';
  }

  const captured = currentSessionId?.trim() || null;
  if (captured === requested) {
    return null;
  }
  return captured
    ? 'Provider continuation returned a different session identity'
    : 'Provider continuation did not confirm the requested session identity';
}

export function createProviderSessionCapture({
  providerName,
  taskId,
  updateTask,
  log,
  requestedSessionId = null,
  initialSessionId = null,
  initialSessionIdConflict = false,
}) {
  let currentSessionId = initialSessionId;
  let sessionIdConflict = initialSessionIdConflict;
  let persistenceError = null;
  const observedSessionIds = new Set(initialSessionId ? [initialSessionId] : []);

  function persist(update) {
    try {
      updateTask(taskId, update);
    } catch (error) {
      persistenceError ||= error;
      throw error;
    }
  }

  function captureLine(line) {
    try {
      ({ currentSessionId, sessionIdConflict } = captureProviderSessionLine({
        providerName,
        line,
        currentSessionId,
        observedSessionIds,
        sessionIdConflict,
        onCapture: (sessionId) => {
          // Advance memory before persistence so a failed write can never leave
          // this watcher believing the earlier identity is still trustworthy.
          currentSessionId = sessionId;
          persist({ sessionId });
        },
        onConflict: () => {
          currentSessionId = null;
          sessionIdConflict = true;
          persist({ sessionId: null, sessionIdConflict: true });
        },
      }));
    } catch (error) {
      log(`[${Date.now()}][SESSION] Failed to persist provider session: ${error.message}\n`);
    }
  }

  return {
    captureLine,
    getCompletionError: () =>
      providerSessionCompletionError({
        requestedSessionId,
        currentSessionId,
        sessionIdConflict,
        persistenceError,
      }),
  };
}
