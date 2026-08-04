import { isDeepStrictEqual } from 'node:util';

import Ajv from 'ajv';

import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  validateOmpSdkProtocolResultFrame,
  type OmpSdkProtocolFrame,
  type OmpSdkSidecarRequest,
} from './sdk-protocol';
import {
  ALLOWED_YIELD_FIELDS,
  SidecarFailure,
  isRecord,
  natural,
  nonnegative,
  type OmpSingleResult,
  type YieldItem,
} from './sdk-sidecar-types';
import { classify } from './sdk-sidecar-runtime';

function yieldItem(value: unknown): YieldItem {
  if (!isRecord(value)) throw new SidecarFailure('sdk-error', 'sdk', false);
  const type = value.type;
  if (
    Object.keys(value).some((key) => ALLOWED_YIELD_FIELDS[key] !== true) ||
    (value.status !== 'success' && value.status !== 'aborted') ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.schemaOverridden !== undefined && typeof value.schemaOverridden !== 'boolean') ||
    (value.useLastTurn !== undefined && typeof value.useLastTurn !== 'boolean') ||
    (type !== undefined &&
      !(typeof type === 'string' && type.length > 0) &&
      !(
        Array.isArray(type) &&
        type.length > 0 &&
        type.every((item) => typeof item === 'string' && item.length > 0)
      ))
  ) {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
  return value as YieldItem;
}
function terminalYield(result: OmpSingleResult): YieldItem {
  const raw = result.extractedToolData?.yield;
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  const terminal = yieldItem(raw[0]);
  if (
    Array.isArray(terminal.type) ||
    terminal.status !== 'success' ||
    terminal.error !== undefined ||
    terminal.useLastTurn === true ||
    terminal.schemaOverridden === true ||
    !Object.hasOwn(terminal, 'data')
  ) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  return terminal;
}
function immutableYieldData(value: unknown): unknown {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== 'object' || seen.has(current)) {
      throw new SidecarFailure('schema-violation', 'schema', false);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((child) => pending.push(child));
      continue;
    }
    const prototype = Reflect.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SidecarFailure('schema-violation', 'schema', false);
    }
    Object.values(current).forEach((child) => pending.push(child));
  }
  let encoded: unknown;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  if (typeof encoded !== 'string') {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  const snapshot: unknown = JSON.parse(encoded);
  const stack = [snapshot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue;
    Object.values(current).forEach((child) => stack.push(child));
    Object.freeze(current);
  }
  return snapshot;
}
function validateSchema(schema: unknown, value: unknown): void {
  try {
    if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object')) {
      throw new SidecarFailure('invalid-request', 'request', false);
    }
    const validate = new Ajv({
      allErrors: true,
      coerceTypes: false,
      strict: false,
      validateFormats: false,
    }).compile(schema);
    if (!validate(value)) throw new SidecarFailure('schema-violation', 'schema', false);
  } catch (error) {
    if (error instanceof SidecarFailure) throw error;
    throw new SidecarFailure('invalid-request', 'request', false);
  }
}
export function successfulValue(
  result: OmpSingleResult,
  request: OmpSdkSidecarRequest,
  schema: unknown,
  signal?: AbortSignal
): unknown {
  if (signal?.aborted) throw new SidecarFailure('cancelled', 'cancelled', false);
  if (result.aborted === true) {
    if (/timeout|timed out|deadline/i.test(result.abortReason ?? '')) {
      throw new SidecarFailure('provider-timeout', 'timeout', true);
    }
    throw new SidecarFailure('cancelled', 'cancelled', false);
  }
  if (!Number.isInteger(result.exitCode)) throw new SidecarFailure('sdk-error', 'sdk', false);
  if (result.exitCode !== 0) throw classify(result.retryFailure ?? result.error ?? result.stderr);
  if (result.resolvedModel !== request.modelSelector) {
    throw new SidecarFailure('model-resolution', 'model', false);
  }
  if (result.resolvedModelIsFallback === true) {
    throw new SidecarFailure('model-fallback', 'model', false);
  }
  const structured = result.structuredOutput;
  if (
    structured?.source !== 'caller' ||
    structured.mode !== 'strict' ||
    structured.status !== 'valid' ||
    !Object.hasOwn(structured, 'data')
  ) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  const terminal = terminalYield(result);
  const terminalData = immutableYieldData(terminal.data);
  const structuredData = immutableYieldData(structured.data);
  if (!isDeepStrictEqual(terminalData, structuredData)) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  validateSchema(schema, structuredData);
  return structuredData;
}
function usage(result: OmpSingleResult): Record<string, unknown> {
  const item = result.usage;
  if (item === undefined) throw new SidecarFailure('sdk-error', 'sdk', false);
  const tokenValues = [item.input, item.output, item.cacheRead, item.cacheWrite, item.totalTokens];
  const costValues = [
    item.cost.input,
    item.cost.output,
    item.cost.cacheRead,
    item.cost.cacheWrite,
    item.cost.total,
  ];
  if (
    !tokenValues.every(natural) ||
    !costValues.every(nonnegative) ||
    !natural(result.requests) ||
    !nonnegative(result.durationMs)
  ) {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
  return {
    source: 'omp-aggregate',
    completeness: 'unknown',
    inputTokens: item.input,
    outputTokens: item.output,
    cacheReadInputTokens: item.cacheRead,
    cacheCreationInputTokens: item.cacheWrite,
    totalTokens: item.totalTokens,
    requests: result.requests,
    durationMs: result.durationMs,
    cost: item.cost,
  };
}
function textResult(value: unknown): string {
  if (!isRecord(value) || typeof value.result !== 'string') {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  return value.result;
}
export function resultFrame(
  request: OmpSdkSidecarRequest,
  result: OmpSingleResult,
  rawValue: unknown
): OmpSdkProtocolFrame {
  const frame = {
    protocolVersion: 1,
    type: 'result',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION },
    runtime: { name: 'bun', version: OMP_SDK_BUN_VERSION },
    requested: {
      modelSelector: request.modelSelector,
      reasoningEffort: request.reasoningEffort,
      outputMode: request.outputMode,
    },
    resolved: { modelSelector: result.resolvedModel },
    strictOutput: {
      source: 'caller',
      mode: 'strict',
      status: 'valid',
      yieldCount: 1,
    },
    fallback: false,
    execution: { exitCode: 0, aborted: false },
    value: request.outputMode === 'text' ? textResult(rawValue) : rawValue,
    usage: usage(result),
  };
  try {
    return validateOmpSdkProtocolResultFrame(frame, request);
  } catch {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
}
