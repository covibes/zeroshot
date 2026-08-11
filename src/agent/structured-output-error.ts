const STRUCTURED_OUTPUT_INVALID_CODE = 'STRUCTURED_OUTPUT_INVALID';

interface ValidationFailure {
  readonly error?: unknown;
}

interface RecoveryResult {
  readonly status?: string;
  readonly attempts?: number;
  readonly lastError?: unknown;
}

interface StructuredOutputAgent {
  readonly id: string;
  readonly role: string;
}

interface StructuredOutputFailure {
  readonly message: string;
  readonly code: unknown;
  readonly details?: unknown;
}

function createStructuredOutputInvalidError(
  message: string,
  kind: unknown,
  validation: ValidationFailure | null = null,
  recovery: RecoveryResult | null = null
): Error & {
  code: typeof STRUCTURED_OUTPUT_INVALID_CODE;
  details: {
    kind: unknown;
    validationError: unknown;
    recoveryAttempts: number | undefined;
    recoveryError: unknown;
  };
} {
  const properties: {
    code: typeof STRUCTURED_OUTPUT_INVALID_CODE;
    details: {
      kind: unknown;
      validationError: unknown;
      recoveryAttempts: number | undefined;
      recoveryError: unknown;
    };
  } = {
    code: STRUCTURED_OUTPUT_INVALID_CODE,
    details: {
      kind,
      validationError: validation?.error ?? null,
      recoveryAttempts: recovery?.status === 'exhausted' ? recovery.attempts : 0,
      recoveryError: recovery?.status === 'exhausted' ? recovery.lastError : null,
    },
  };
  return Object.assign(new Error(message), properties);
}

function isStructuredOutputInvalidError(error: unknown): boolean {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
    return false;
  }
  return 'code' in error && error.code === STRUCTURED_OUTPUT_INVALID_CODE;
}

function buildStructuredOutputClusterFailure(
  agent: StructuredOutputAgent,
  error: StructuredOutputFailure
): {
  topic: 'CLUSTER_FAILED';
  receiver: 'broadcast';
  content: {
    text: string;
    data: {
      reason: 'structured_output_invalid';
      agentId: string;
      role: string;
      code: unknown;
      details: unknown;
      error: string;
    };
  };
} {
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

export = {
  STRUCTURED_OUTPUT_INVALID_CODE,
  createStructuredOutputInvalidError,
  isStructuredOutputInvalidError,
  buildStructuredOutputClusterFailure,
};
