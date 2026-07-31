import {
  extractProviderSessionId,
  getProviderSessionCapturePolicy,
} from './provider-helper-runtime.js';

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
  sessionCapturePolicy = getProviderSessionCapturePolicy(providerName),
  onCapture = () => {},
  onConflict = () => {},
}) {
  const inspection = sessionCapturePolicy?.inspectLine(line);
  const sessionId = inspection
    ? inspection.sessionId
    : extractProviderSessionId(providerName, line);
  if (inspection?.malformed) {
    if (!sessionIdConflict) onConflict([...observedSessionIds]);
    return { currentSessionId: null, sessionIdConflict: true };
  }
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
  requireSessionIdOnSuccess,
  exactIdentityMatch,
}) {
  if (persistenceError) {
    return `Provider session identity could not be persisted: ${persistenceError.message}`;
  }

  const requested = exactIdentityMatch
    ? typeof requestedSessionId === 'string' && requestedSessionId.length > 0
      ? requestedSessionId
      : null
    : requestedSessionId?.trim() || null;
  const captured = exactIdentityMatch
    ? typeof currentSessionId === 'string' && currentSessionId.length > 0
      ? currentSessionId
      : null
    : currentSessionId?.trim() || null;
  if (sessionIdConflict && (requested || requireSessionIdOnSuccess)) {
    return exactIdentityMatch
      ? 'Provider continuation emitted conflicting or malformed session identities'
      : 'Provider continuation emitted conflicting session identities';
  }
  if (requested) {
    if (captured === requested) return null;
    return captured
      ? 'Provider continuation returned a different session identity'
      : 'Provider continuation did not confirm the requested session identity';
  }
  if (requireSessionIdOnSuccess && !captured) {
    return 'Provider completion did not durably capture a required session identity';
  }
  return null;
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
  const sessionCapturePolicy = getProviderSessionCapturePolicy(providerName);

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
        sessionCapturePolicy,
        onCapture: (sessionId) => {
          // Advance memory before persistence so a failed write can never leave
          // this watcher believing the earlier identity is still trustworthy.
          currentSessionId = sessionId;
          persist({ sessionId });
        },
        onConflict: () => {
          currentSessionId = null;
          sessionIdConflict = true;
          persist({
            sessionId: null,
            sessionIdConflict: true,
            resumeIdentityVerified: false,
          });
        },
      }));
    } catch (error) {
      log(`[${Date.now()}][SESSION] Failed to persist provider session: ${error.message}\n`);
    }
  }

  function getCompletionError() {
    return providerSessionCompletionError({
      requestedSessionId,
      currentSessionId,
      sessionIdConflict,
      persistenceError,
      requireSessionIdOnSuccess: sessionCapturePolicy?.requireSessionIdOnSuccess === true,
      exactIdentityMatch: sessionCapturePolicy?.exactIdentityMatch === true,
    });
  }

  return {
    captureLine,
    getCompletionError,
    getCompletionUpdate: (resolvedCode) => {
      const error = getCompletionError();
      return {
        resumeIdentityVerified: resolvedCode === 0 && !error,
        ...(error ? { sessionId: null, sessionIdConflict: true } : {}),
      };
    },
  };
}
