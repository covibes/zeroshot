const STRUCTURED_OUTPUT_INVALID_CODE = 'STRUCTURED_OUTPUT_INVALID';

function createStructuredOutputInvalidError(message, kind, validation = null, recovery = null) {
  const error = new Error(message);
  error.code = STRUCTURED_OUTPUT_INVALID_CODE;
  error.details = {
    kind,
    validationError: validation?.error ?? null,
    recoveryAttempts: recovery?.status === 'exhausted' ? recovery.attempts : 0,
    recoveryError: recovery?.status === 'exhausted' ? recovery.lastError : null,
  };
  return error;
}

function isStructuredOutputInvalidError(error) {
  return error?.code === STRUCTURED_OUTPUT_INVALID_CODE;
}

function buildStructuredOutputClusterFailure(agent, error) {
  return {
    topic: 'CLUSTER_FAILED',
    receiver: 'broadcast',
    content: {
      text: `Cluster failed: structured output is invalid for ${agent.id} - ${error.message}`,
      data: {
        reason: 'structured_output_invalid',
        agentId: agent.id,
        role: agent.role,
        code: error.code,
        details: error.details ?? null,
        error: error.message,
      },
    },
  };
}

module.exports = {
  STRUCTURED_OUTPUT_INVALID_CODE,
  createStructuredOutputInvalidError,
  isStructuredOutputInvalidError,
  buildStructuredOutputClusterFailure,
};
