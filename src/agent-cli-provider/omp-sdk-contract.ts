import { isRecord } from './json';
import type { OmpSdkErrorCategory } from './omp-sdk-protocol';
import type { ProcessResult } from './process-runner';
import type { ErrorClassification } from './types';

export type ContractOmpSdkTerminal =
  | {
      readonly type: 'result';
      readonly frame: Readonly<Record<string, unknown>>;
      readonly event: Readonly<Record<string, unknown>> & {
        readonly type: 'result';
        readonly success: boolean;
      };
    }
  | {
      readonly type: 'error';
      readonly frame: Readonly<Record<string, unknown>> & {
        readonly error: {
          readonly category: OmpSdkErrorCategory;
          readonly retryable: boolean;
        };
      };
    };

export interface ContractOmpSdkProcessResult extends ProcessResult {
  readonly terminal: ContractOmpSdkTerminal;
  readonly progress: readonly unknown[];
  readonly diagnosticStderr: string;
  readonly cleanupAttestation: Readonly<Record<string, unknown>>;
}

export function isOmpSdkErrorCategory(value: unknown): value is OmpSdkErrorCategory {
  switch (value) {
    case 'request':
    case 'model':
    case 'auth':
    case 'rate-limit':
    case 'timeout':
    case 'provider':
    case 'schema':
    case 'cancelled':
    case 'sdk':
    case 'cleanup':
    case 'internal':
      return true;
    default:
      return false;
  }
}

export function isContractOmpSdkTerminal(value: unknown): value is ContractOmpSdkTerminal {
  if (!isRecord(value) || !isRecord(value.frame) || value.frame.type !== value.type) {
    return false;
  }
  if (value.type === 'result') {
    return (
      isRecord(value.event) &&
      value.event.type === 'result' &&
      typeof value.event.success === 'boolean'
    );
  }
  if (value.type !== 'error' || !isRecord(value.frame.error)) return false;
  return (
    isOmpSdkErrorCategory(value.frame.error.category) &&
    typeof value.frame.error.retryable === 'boolean'
  );
}

export function isContractOmpSdkProcessResult(
  result: ProcessResult
): result is ContractOmpSdkProcessResult {
  return (
    'terminal' in result &&
    isContractOmpSdkTerminal(result.terminal) &&
    'progress' in result &&
    Array.isArray(result.progress) &&
    'diagnosticStderr' in result &&
    typeof result.diagnosticStderr === 'string' &&
    'cleanupAttestation' in result &&
    isRecord(result.cleanupAttestation)
  );
}

export type OmpSdkErrorClassification = ErrorClassification & {
  readonly category: OmpSdkErrorCategory;
};

export function ompSdkFailureClassification(
  result: ContractOmpSdkProcessResult
): OmpSdkErrorClassification | null {
  if (result.terminal.type !== 'error') return null;
  const { category, retryable } = result.terminal.frame.error;
  return {
    category,
    retryable,
    kind:
      category === 'cancelled'
        ? 'cancelled'
        : retryable
          ? 'unknown-retryable'
          : 'permanent-pattern',
  };
}

export function invokeEvidence(
  result: ProcessResult,
  timeoutMs: number | undefined
): Record<string, unknown> {
  const sdkResult = isContractOmpSdkProcessResult(result) ? result : null;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut ?? false,
    timeoutMs: result.timeoutMs ?? timeoutMs ?? null,
    ...(sdkResult === null
      ? {}
      : {
          terminal: sdkResult.terminal.frame,
          cleanupAttestation: sdkResult.cleanupAttestation,
        }),
  };
}
