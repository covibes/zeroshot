import { OMP_SDK_REASONING_EFFORTS } from './sdk-settings';
import type {
  OmpSdkRequestedIdentity,
  OmpSdkStrictOutputEvidence,
  OmpSdkTerminalEvidence,
  OmpSdkUsageEvidence,
} from '../types';
import {
  CATEGORY,
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  OMP_SDK_ERROR_CODES,
  OMP_SDK_MAX_FRAME_BYTES,
  OMP_SDK_PROGRESS_STAGES,
  type OmpSdkProtocolErrorFrame,
  type OmpSdkProtocolFrame,
  type OmpSdkProtocolProgressFrame,
  type OmpSdkProtocolResultFrame,
} from './sdk-protocol-types';
import { decode } from './sdk-protocol-request';
import {
  exact,
  includesLiteral,
  isRecord,
  json,
  literal,
  number,
  parseRunId,
  protocolFailure,
  selector,
  serializedLimit,
} from './sdk-protocol-value';

function backend(value: unknown): OmpSdkTerminalEvidence['backend'] {
  if (!isRecord(value)) protocolFailure('frame.backend must be an object.');
  exact(value, ['id', 'version'], [], 'frame.backend', protocolFailure);
  literal(value.id, 'omp-sdk', 'frame.backend.id', protocolFailure);
  literal(value.version, OMP_SDK_BACKEND_VERSION, 'frame.backend.version', protocolFailure);
  return { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION };
}
function runtime(value: unknown): OmpSdkTerminalEvidence['runtime'] {
  if (!isRecord(value)) protocolFailure('frame.runtime must be an object.');
  exact(value, ['name', 'version'], [], 'frame.runtime', protocolFailure);
  literal(value.name, 'bun', 'frame.runtime.name', protocolFailure);
  literal(value.version, OMP_SDK_BUN_VERSION, 'frame.runtime.version', protocolFailure);
  return { name: 'bun', version: OMP_SDK_BUN_VERSION };
}
function requested(value: unknown): OmpSdkRequestedIdentity {
  if (!isRecord(value)) protocolFailure('frame.requested must be an object.');
  exact(
    value,
    ['modelSelector', 'reasoningEffort', 'outputMode'],
    [],
    'frame.requested',
    protocolFailure
  );
  const modelSelector = selector(
    value.modelSelector,
    'frame.requested.modelSelector',
    protocolFailure
  );
  if (!includesLiteral(OMP_SDK_REASONING_EFFORTS, value.reasoningEffort))
    protocolFailure('invalid requested effort.');
  if (value.outputMode !== 'json' && value.outputMode !== 'text')
    protocolFailure('invalid requested mode.');
  return { modelSelector, reasoningEffort: value.reasoningEffort, outputMode: value.outputMode };
}
function strictOutput(value: unknown): OmpSdkStrictOutputEvidence {
  if (!isRecord(value)) protocolFailure('frame.strictOutput must be an object.');
  exact(
    value,
    ['source', 'mode', 'status', 'yieldCount'],
    [],
    'frame.strictOutput',
    protocolFailure
  );
  literal(value.source, 'caller', 'frame.strictOutput.source', protocolFailure);
  literal(value.mode, 'strict', 'frame.strictOutput.mode', protocolFailure);
  literal(value.status, 'valid', 'frame.strictOutput.status', protocolFailure);
  literal(value.yieldCount, 1, 'frame.strictOutput.yieldCount', protocolFailure);
  return { source: 'caller', mode: 'strict', status: 'valid', yieldCount: 1 };
}
function usage(value: unknown): OmpSdkUsageEvidence {
  if (!isRecord(value)) protocolFailure('frame.usage must be an object.');
  exact(
    value,
    [
      'source',
      'completeness',
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'totalTokens',
      'requests',
      'durationMs',
      'cost',
    ],
    [],
    'frame.usage',
    protocolFailure
  );
  literal(value.source, 'omp-aggregate', 'frame.usage.source', protocolFailure);
  literal(value.completeness, 'unknown', 'frame.usage.completeness', protocolFailure);
  if (!isRecord(value.cost)) protocolFailure('frame.usage.cost must be an object.');
  exact(
    value.cost,
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'],
    [],
    'frame.usage.cost',
    protocolFailure
  );
  return {
    source: 'omp-aggregate',
    completeness: 'unknown',
    inputTokens: number(value.inputTokens, 'frame.usage.inputTokens', true),
    outputTokens: number(value.outputTokens, 'frame.usage.outputTokens', true),
    cacheReadInputTokens: number(
      value.cacheReadInputTokens,
      'frame.usage.cacheReadInputTokens',
      true
    ),
    cacheCreationInputTokens: number(
      value.cacheCreationInputTokens,
      'frame.usage.cacheCreationInputTokens',
      true
    ),
    totalTokens: number(value.totalTokens, 'frame.usage.totalTokens', true),
    requests: number(value.requests, 'frame.usage.requests', true),
    durationMs: number(value.durationMs, 'frame.usage.durationMs', false),
    cost: {
      input: number(value.cost.input, 'frame.usage.cost.input', false),
      output: number(value.cost.output, 'frame.usage.cost.output', false),
      cacheRead: number(value.cost.cacheRead, 'frame.usage.cost.cacheRead', false),
      cacheWrite: number(value.cost.cacheWrite, 'frame.usage.cost.cacheWrite', false),
      total: number(value.cost.total, 'frame.usage.cost.total', false),
    },
  };
}

function resultFrame(value: Record<string, unknown>): OmpSdkProtocolResultFrame {
  exact(
    value,
    [
      'protocolVersion',
      'type',
      'runId',
      'backend',
      'runtime',
      'requested',
      'resolved',
      'strictOutput',
      'fallback',
      'execution',
      'value',
      'usage',
    ],
    [],
    'frame',
    protocolFailure
  );
  literal(value.protocolVersion, 1, 'frame.protocolVersion', protocolFailure);
  literal(value.type, 'result', 'frame.type', protocolFailure);
  const runId = parseRunId(value.runId, 'frame.runId', protocolFailure);
  const parsedRequested = requested(value.requested);
  if (!isRecord(value.resolved)) protocolFailure('frame.resolved must be an object.');
  exact(value.resolved, ['modelSelector'], [], 'frame.resolved', protocolFailure);
  const resolved = {
    modelSelector: selector(
      value.resolved.modelSelector,
      'frame.resolved.modelSelector',
      protocolFailure
    ),
  };
  const parsedStrict = strictOutput(value.strictOutput);
  literal(value.fallback, false, 'frame.fallback', protocolFailure);
  if (!isRecord(value.execution)) protocolFailure('frame.execution must be an object.');
  exact(value.execution, ['exitCode', 'aborted'], [], 'frame.execution', protocolFailure);
  literal(value.execution.exitCode, 0, 'frame.execution.exitCode', protocolFailure);
  literal(value.execution.aborted, false, 'frame.execution.aborted', protocolFailure);
  json(value.value, 'frame.value', protocolFailure);
  return {
    protocolVersion: 1,
    type: 'result',
    runId,
    backend: backend(value.backend),
    runtime: runtime(value.runtime),
    requested: parsedRequested,
    resolved,
    strictOutput: parsedStrict,
    fallback: false,
    execution: { exitCode: 0, aborted: false },
    value: value.value,
    usage: usage(value.usage),
  };
}
function errorFrame(value: Record<string, unknown>): OmpSdkProtocolErrorFrame {
  exact(
    value,
    ['protocolVersion', 'type', 'runId', 'backend', 'runtime', 'error'],
    [],
    'frame',
    protocolFailure
  );
  literal(value.protocolVersion, 1, 'frame.protocolVersion', protocolFailure);
  literal(value.type, 'error', 'frame.type', protocolFailure);
  const runId = parseRunId(value.runId, 'frame.runId', protocolFailure);
  if (!isRecord(value.error)) protocolFailure('frame.error must be an object.');
  exact(
    value.error,
    ['code', 'category', 'retryable', 'redacted'],
    [],
    'frame.error',
    protocolFailure
  );
  if (!includesLiteral(OMP_SDK_ERROR_CODES, value.error.code))
    protocolFailure('frame.error.code is unsupported.');
  const code = value.error.code;
  const category = CATEGORY[code];
  literal(value.error.category, category, 'frame.error.category', protocolFailure);
  if (typeof value.error.retryable !== 'boolean')
    protocolFailure('frame.error.retryable must be boolean.');
  literal(value.error.redacted, true, 'frame.error.redacted', protocolFailure);
  return {
    protocolVersion: 1,
    type: 'error',
    runId,
    backend: backend(value.backend),
    runtime: runtime(value.runtime),
    error: { code, category, retryable: value.error.retryable, redacted: true },
  };
}
function progressFrame(value: Record<string, unknown>): OmpSdkProtocolProgressFrame {
  exact(
    value,
    ['protocolVersion', 'type', 'runId', 'sequence', 'stage'],
    [],
    'frame',
    protocolFailure
  );
  literal(value.protocolVersion, 1, 'frame.protocolVersion', protocolFailure);
  literal(value.type, 'progress', 'frame.type', protocolFailure);
  const runId = parseRunId(value.runId, 'frame.runId', protocolFailure);
  const sequence = number(value.sequence, 'frame.sequence', true);
  if (!includesLiteral(OMP_SDK_PROGRESS_STAGES, value.stage))
    protocolFailure('frame.stage is unsupported.');
  return { protocolVersion: 1, type: 'progress', runId, sequence, stage: value.stage };
}

export function parseOmpSdkProtocolFrame(value: unknown): OmpSdkProtocolFrame {
  if (!isRecord(value)) protocolFailure('frame must be an object.');
  serializedLimit(value, OMP_SDK_MAX_FRAME_BYTES, 'frame', protocolFailure);
  if (value.type === 'progress') return progressFrame(value);
  if (value.type === 'result') return resultFrame(value);
  if (value.type === 'error') return errorFrame(value);
  return protocolFailure('frame.type is unsupported.', 'frame.type');
}
export function decodeOmpSdkProtocolFrame(line: string | Uint8Array): OmpSdkProtocolFrame {
  return parseOmpSdkProtocolFrame(decode(line, OMP_SDK_MAX_FRAME_BYTES, 'frame', protocolFailure));
}
