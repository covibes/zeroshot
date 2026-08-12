import type {
  ProvidersBoundary,
  RecoveryError,
  ReformatInvocationResult,
} from './output-reformatter-types';

const INVOCATION_METADATA_FIELDS: readonly (
  | 'code'
  | 'permanent'
  | 'provider'
  | 'capability'
  | 'nestedExecutionCancellation'
  | 'nestedExecutionLifecycle'
  | 'retainTaskHandle'
  | 'terminationExhausted'
  | 'taskId'
)[] = [
  'code',
  'permanent',
  'provider',
  'capability',
  'nestedExecutionCancellation',
  'nestedExecutionLifecycle',
  'retainTaskHandle',
  'terminationExhausted',
  'taskId',
];

function isProvidersBoundary(value: unknown): value is ProvidersBoundary {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'getProvider' in value &&
    typeof value.getProvider === 'function'
  );
}

const rawProviders: unknown = require('../providers');
if (!isProvidersBoundary(rawProviders)) {
  throw new TypeError('providers module must expose getProvider');
}
const { getProvider } = rawProviders;

function isRecoveryError(value: unknown): value is RecoveryError {
  return value instanceof Error;
}

function invocationError(result: ReformatInvocationResult | null | undefined): RecoveryError {
  let error: RecoveryError;
  if (isRecoveryError(result?.error)) {
    error = result.error;
  } else {
    const message = result?.error ? String(result.error) : 'Structured-output recovery task failed';
    error = new Error(message);
  }
  if (!result) return error;

  for (const field of INVOCATION_METADATA_FIELDS) {
    if (result[field] !== undefined && error[field] === undefined) {
      error[field] = result[field];
    }
  }
  return error;
}

function isImmediateRecoveryFailure(error: RecoveryError, providerName: string): boolean {
  if (
    error.code === 'REFORMAT_CANCELLED' ||
    error.code === 'AGENT_TASK_TIMEOUT' ||
    error.nestedExecutionCancellation === true ||
    error.nestedExecutionLifecycle === true ||
    error.retainTaskHandle === true ||
    error.permanent === true ||
    error.terminationExhausted === true
  ) {
    return true;
  }
  return !getProvider(providerName).isRetryableError(error);
}

function markImmediateRecoveryFailure(error: RecoveryError, providerName: string): boolean {
  if (!isImmediateRecoveryFailure(error, providerName)) return false;
  error.recoveryAbort = true;
  const operationalControl =
    error.code === 'REFORMAT_CANCELLED' ||
    error.code === 'AGENT_TASK_TIMEOUT' ||
    error.nestedExecutionCancellation === true ||
    error.nestedExecutionLifecycle === true ||
    error.retainTaskHandle === true ||
    error.terminationExhausted === true;
  if (!operationalControl && error.permanent !== true) error.permanent = true;
  return true;
}

function recoveryErrorMessage(error: unknown, providerName: string): string | null {
  if (!isRecoveryError(error)) return null;
  if (markImmediateRecoveryFailure(error, providerName)) throw error;
  return error.message;
}

export = {
  invocationError,
  markImmediateRecoveryFailure,
  recoveryErrorMessage,
};
