import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import Ajv from 'ajv';

import { contractError } from './contract-errors';
import {
  normalizeOmpSdkSettings,
  OMP_SDK_REASONING_EFFORTS,
  OMP_SDK_SETTINGS_DEFAULTS,
  OMP_SDK_TOOL_IDS,
  parseExactOmpModelSelector,
} from './omp-sdk-settings';
import type {
  OmpModelsConfig,
  OmpSdkAuth,
  OmpSdkToolId as SettingsOmpSdkToolId,
} from './omp-sdk-settings';
import type {
  OmpSdkRequestedIdentity,
  OmpSdkStrictOutputEvidence,
  OmpSdkTerminalEvidence,
  OmpSdkUsageEvidence,
  ReasoningEffort,
  ResultEvent,
} from './types';

export const OMP_SDK_PROTOCOL_VERSION = 1 as const;
export const OMP_SDK_BACKEND_VERSION = '17.2.1' as const;
export const OMP_SDK_BUN_VERSION = '1.3.14' as const;
export const OMP_SDK_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const OMP_SDK_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_SDK_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const OMP_SDK_MAX_CREDENTIAL_BYTES = 64 * 1024;

const MAX_RUN_ID_BYTES = 128;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 1024 * 1024;
const MAX_SELECTOR_BYTES = 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_SCHEMA_STRING_BYTES = 16 * 1024;
const MAX_SCHEMA_ARRAY_ITEMS = 4_096;
const MAX_SCHEMA_OBJECT_KEYS = 4_096;
const MAX_SCHEMA_KEY_BYTES = 1_024;
const OMP_SDK_EXECUTION_CONTEXTS = ['host', 'detached', 'docker', 'benchmark'] as const;
const UNSAFE_REGEX_SCHEMA_KEYWORDS: Readonly<Record<string, true>> = {
  pattern: true,
  patternProperties: true,
};

export { OMP_SDK_TOOL_IDS };
export type OmpSdkToolId = SettingsOmpSdkToolId;
export type OmpSdkRequestAuth = OmpSdkAuth;
export type OmpSdkModelsConfig = OmpModelsConfig;
export type OmpSdkOutputMode = 'json' | 'text';
export type OmpSdkExecutionContext = (typeof OMP_SDK_EXECUTION_CONTEXTS)[number];

interface OmpSdkRequestBase {
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly cwd: string;
  readonly executionContext: OmpSdkExecutionContext;
  readonly prompt: string;
  readonly modelSelector: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly modelsConfig: OmpSdkModelsConfig;
  readonly auth: OmpSdkRequestAuth;
  readonly tools: readonly OmpSdkToolId[];
  readonly context: string;
}

export interface OmpSdkJsonSidecarRequest extends OmpSdkRequestBase {
  readonly outputMode: 'json';
  readonly outputSchema: boolean | Readonly<Record<string, unknown>>;
}
export interface OmpSdkTextSidecarRequest extends OmpSdkRequestBase {
  readonly outputMode: 'text';
  readonly outputSchema?: never;
}
export type OmpSdkSidecarRequest = OmpSdkJsonSidecarRequest | OmpSdkTextSidecarRequest;

export const OMP_SDK_TEXT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({ result: Object.freeze({ type: 'string' }) }),
  required: Object.freeze(['result']),
  additionalProperties: false,
}) as Readonly<Record<string, unknown>>;

export const OMP_SDK_PROGRESS_STAGES = [
  'starting',
  'resolving-model',
  'running',
  'tearing-down',
] as const;
export type OmpSdkProgressStage = (typeof OMP_SDK_PROGRESS_STAGES)[number];

export interface OmpSdkProtocolProgressFrame {
  readonly protocolVersion: 1;
  readonly type: 'progress';
  readonly runId: string;
  readonly sequence: number;
  readonly stage: OmpSdkProgressStage;
}
export interface OmpSdkProtocolResultFrame extends OmpSdkTerminalEvidence {
  readonly protocolVersion: 1;
  readonly type: 'result';
  readonly runId: string;
  readonly value: unknown;
}

export const OMP_SDK_ERROR_CODES = [
  'invalid-request',
  'model-resolution',
  'model-fallback',
  'provider-auth',
  'provider-rate-limit',
  'provider-timeout',
  'provider-error',
  'schema-violation',
  'cancelled',
  'sdk-error',
  'cleanup-error',
  'internal-error',
] as const;
export type OmpSdkErrorCode = (typeof OMP_SDK_ERROR_CODES)[number];
export type OmpSdkErrorCategory =
  | 'request'
  | 'model'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'provider'
  | 'schema'
  | 'cancelled'
  | 'sdk'
  | 'cleanup'
  | 'internal';
export interface OmpSdkSafeError {
  readonly code: OmpSdkErrorCode;
  readonly category: OmpSdkErrorCategory;
  readonly retryable: boolean;
  readonly redacted: true;
}
export interface OmpSdkProtocolErrorFrame {
  readonly protocolVersion: 1;
  readonly type: 'error';
  readonly runId: string;
  readonly backend: OmpSdkTerminalEvidence['backend'];
  readonly runtime: OmpSdkTerminalEvidence['runtime'];
  readonly error: OmpSdkSafeError;
}
export type OmpSdkProtocolFrame =
  | OmpSdkProtocolProgressFrame
  | OmpSdkProtocolResultFrame
  | OmpSdkProtocolErrorFrame;
export type OmpSdkProtocolTerminalFrame =
  | OmpSdkProtocolResultFrame
  | OmpSdkProtocolErrorFrame;
export type OmpSdkCollectedTerminal =
  | { readonly type: 'result'; readonly frame: OmpSdkProtocolResultFrame; readonly event: ResultEvent }
  | { readonly type: 'error'; readonly frame: OmpSdkProtocolErrorFrame };

export interface OmpSdkProtocolCollectorOptions {
  readonly request: OmpSdkSidecarRequest;
  readonly maxFrameBytes?: number;
  readonly maxStdoutBytes?: number;
}
export interface OmpSdkProtocolCollector {
  readonly progress: readonly OmpSdkProtocolProgressFrame[];
  write(chunk: string | Uint8Array): readonly OmpSdkProtocolFrame[];
  finish(exitCode: number): OmpSdkCollectedTerminal;
}

type Fail = (message: string, field?: string) => never;
function includesLiteral<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
const CATEGORY: Readonly<Record<OmpSdkErrorCode, OmpSdkErrorCategory>> = {
  'invalid-request': 'request',
  'model-resolution': 'model',
  'model-fallback': 'model',
  'provider-auth': 'auth',
  'provider-rate-limit': 'rate-limit',
  'provider-timeout': 'timeout',
  'provider-error': 'provider',
  'schema-violation': 'schema',
  cancelled: 'cancelled',
  'sdk-error': 'sdk',
  'cleanup-error': 'cleanup',
  'internal-error': 'internal',
};

function failure(code: string, message: string, field?: string): never {
  throw contractError({ code, message, exitCode: 2, ...(field === undefined ? {} : { field }) });
}
function protocolFailure(message: string, field?: string): never {
  return failure('omp-sdk-protocol', message, field);
}
function requestFailure(message: string, field?: string): never {
  return failure('invalid-omp-sdk-request', message, field);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  subject: string,
  fail: Fail
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(`${subject}.${key} is required.`, `${subject}.${key}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${subject}.${key} is not allowed.`, `${subject}.${key}`);
  }
}
function string(
  value: unknown,
  field: string,
  maxBytes: number,
  empty: boolean,
  fail: Fail
): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) {
    return fail(`${field} must be ${empty ? 'a string' : 'a non-empty string'}.`, field);
  }
  if (Buffer.byteLength(value) > maxBytes) return fail(`${field} exceeds ${maxBytes} bytes.`, field);
  return value;
}
function parseRunId(value: unknown, field: string, fail: Fail): string {
  const parsed = string(value, field, MAX_RUN_ID_BYTES, false, fail);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed)) {
    fail(`${field} contains unsupported characters.`, field);
  }
  return parsed;
}
function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  field: string,
  fail: Fail
): T {
  if (value !== expected) return fail(`${field} must be ${JSON.stringify(expected)}.`, field);
  return expected;
}
function number(value: unknown, field: string, integer: boolean): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    protocolFailure(`${field} must be a finite nonnegative${integer ? ' integer' : ''}.`, field);
  }
  return value;
}
function json(value: unknown, field: string, fail: Fail): void {
  const stack: Array<{ value: unknown; depth: number; field: string }> = [{ value, depth: 0, field }];
  const seen = new Set<object>();
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (++count > MAX_JSON_NODES) fail(`${field} exceeds ${MAX_JSON_NODES} JSON nodes.`, field);
    if (item.depth > MAX_JSON_DEPTH) fail(`${field} exceeds JSON depth ${MAX_JSON_DEPTH}.`, field);
    const current = item.value;
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== 'object') fail(`${item.field} must contain only JSON values.`, item.field);
    if (seen.has(current)) fail(`${item.field} must not contain shared or cyclic objects.`, item.field);
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((child, index) => stack.push({ value: child, depth: item.depth + 1, field: `${item.field}[${index}]` }));
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail(`${item.field} must contain plain JSON objects.`, item.field);
      }
      Object.entries(current).forEach(([key, child]) =>
        stack.push({ value: child, depth: item.depth + 1, field: `${item.field}.${key}` })
      );
    }
  }
}
function serializedLimit(value: unknown, max: number, subject: string, fail: Fail): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${subject} is not JSON serializable.`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > max) fail(`${subject} exceeds ${max} bytes.`);
}
function selector(value: unknown, field: string, fail: Fail): string {
  const parsed = string(value, field, MAX_SELECTOR_BYTES, false, fail);
  try {
    parseExactOmpModelSelector(parsed);
  } catch {
    fail(`${field} must be an exact full provider/model selector.`, field);
  }
  return parsed;
}
function validateSchemaSafety(schema: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly field: string }> = [
    { value: schema, field: 'request.outputSchema' },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item.value === 'string') {
      if (Buffer.byteLength(item.value) > MAX_SCHEMA_STRING_BYTES) {
        requestFailure(
          `${item.field} exceeds ${MAX_SCHEMA_STRING_BYTES} bytes.`,
          item.field
        );
      }
      continue;
    }
    if (Array.isArray(item.value)) {
      if (item.value.length > MAX_SCHEMA_ARRAY_ITEMS) {
        requestFailure(
          `${item.field} exceeds ${MAX_SCHEMA_ARRAY_ITEMS} items.`,
          item.field
        );
      }
      item.value.forEach((value, index) =>
        stack.push({ value, field: `${item.field}[${index}]` })
      );
      continue;
    }
    if (!isRecord(item.value)) continue;
    const entries = Object.entries(item.value);
    if (entries.length > MAX_SCHEMA_OBJECT_KEYS) {
      requestFailure(
        `${item.field} exceeds ${MAX_SCHEMA_OBJECT_KEYS} properties.`,
        item.field
      );
    }
    for (const [key, value] of entries) {
      if (Buffer.byteLength(key) > MAX_SCHEMA_KEY_BYTES) {
        requestFailure(
          `${item.field} has an oversized keyword or property name.`,
          item.field
        );
      }
      const field = `${item.field}.${key}`;
      if (UNSAFE_REGEX_SCHEMA_KEYWORDS[key] === true) {
        requestFailure(
          `${field} is forbidden because regular-expression schemas are not accepted.`,
          field
        );
      }
      stack.push({ value, field });
    }
  }
}
function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value as Record<string, unknown>).forEach((child) => deepFreezeJson(child));
  return Object.freeze(value) as T;
}
function immutableJsonSnapshot<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) requestFailure('request.outputSchema is not JSON serializable.');
  return deepFreezeJson(JSON.parse(encoded) as T);
}
function schemaValidator(schema: boolean | Readonly<Record<string, unknown>>): (value: unknown) => boolean {
  try {
    const validate = new Ajv({
      allErrors: true,
      coerceTypes: false,
      strict: false,
      validateFormats: false,
    }).compile(schema);
    return (value: unknown): boolean => validate(value) === true;
  } catch {
    return requestFailure('request.outputSchema must be a valid JSON Schema.', 'request.outputSchema');
  }
}


export function parseOmpSdkSidecarRequest(value: unknown): OmpSdkSidecarRequest {
  if (!isRecord(value)) requestFailure('request must be an object.', 'request');
  serializedLimit(value, OMP_SDK_MAX_REQUEST_BYTES, 'request', requestFailure);
  exact(
    value,
    [
      'protocolVersion',
      'runId',
      'cwd',
      'prompt',
      'executionContext',
      'modelSelector',
      'reasoningEffort',
      'outputMode',
      'modelsConfig',
      'auth',
      'tools',
      'context',
    ],
    ['outputSchema'],
    'request',
    requestFailure
  );
  literal(value.protocolVersion, 1, 'request.protocolVersion', requestFailure);
  const runId = parseRunId(value.runId, 'request.runId', requestFailure);
  const cwd = string(value.cwd, 'request.cwd', MAX_PATH_BYTES, false, requestFailure);
  if (!includesLiteral(OMP_SDK_EXECUTION_CONTEXTS, value.executionContext)) {
    requestFailure(
      'request.executionContext must be "host", "detached", "docker", or "benchmark".',
      'request.executionContext'
    );
  }
  const executionContext: OmpSdkExecutionContext = value.executionContext;
  if (!path.isAbsolute(cwd)) requestFailure('request.cwd must be absolute.', 'request.cwd');
  const prompt = string(value.prompt, 'request.prompt', MAX_PROMPT_BYTES, false, requestFailure);
  const modelSelector = selector(value.modelSelector, 'request.modelSelector', requestFailure);
  if (!includesLiteral(OMP_SDK_REASONING_EFFORTS, value.reasoningEffort)) {
    requestFailure('request.reasoningEffort is unsupported.');
  }
  const reasoningEffort: ReasoningEffort = value.reasoningEffort;
  json(value.modelsConfig, 'request.modelsConfig', requestFailure);
  json(value.auth, 'request.auth', requestFailure);
  json(value.tools, 'request.tools', requestFailure);
  const context = string(value.context, 'request.context', MAX_CONTEXT_BYTES, true, requestFailure);
  const normalizedSettings = (() => {
    try {
      return normalizeOmpSdkSettings(
        {
          ...OMP_SDK_SETTINGS_DEFAULTS,
          levelOverrides: {
            level1: { model: modelSelector, reasoningEffort },
            level2: { model: modelSelector, reasoningEffort },
            level3: { model: modelSelector, reasoningEffort },
          },
          modelsConfig: value.modelsConfig,
          auth: value.auth,
          tools: value.tools,
        },
        {
          executionContext: executionContext === 'benchmark' ? 'docker' : executionContext,
          requireModelConfiguration: true,
        }
      );
    } catch {
      return requestFailure('request provider settings failed closed validation.');
    }
  })();
  const selectedProvider = modelSelector.slice(0, modelSelector.indexOf('/'));
  if (
    normalizedSettings.auth.mode === 'broker' &&
    normalizedSettings.modelsConfig.providers[selectedProvider] !== undefined
  ) {
    requestFailure(
      'request.modelsConfig cannot override the selected provider when broker auth is used.',
      `request.modelsConfig.providers.${selectedProvider}`
    );
  }
  const base = {
    protocolVersion: 1 as const,
    runId,
    cwd,
    executionContext,
    prompt,
    modelSelector,
    reasoningEffort,
    modelsConfig: normalizedSettings.modelsConfig,
    auth: normalizedSettings.auth,
    tools: normalizedSettings.tools,
    context,
  };
  if (value.outputMode === 'json') {
    if (value.outputSchema !== true && value.outputSchema !== false && !isRecord(value.outputSchema)) {
      requestFailure('request.outputSchema must be a JSON Schema object or boolean.');
    }
    json(value.outputSchema, 'request.outputSchema', requestFailure);
    validateSchemaSafety(value.outputSchema);
    const outputSchema = immutableJsonSnapshot(value.outputSchema);
    schemaValidator(outputSchema);
    return Object.freeze({ ...base, outputMode: 'json' as const, outputSchema });
  }
  if (value.outputMode !== 'text') requestFailure('request.outputMode must be "json" or "text".');
  if (value.outputSchema !== undefined) requestFailure('request.outputSchema is forbidden in text mode.');
  return Object.freeze({ ...base, outputMode: 'text' as const });
}

function decode(input: string | Uint8Array, max: number, subject: string, fail: Fail): unknown {
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (bytes.byteLength === 0 || bytes.byteLength > max) fail(`${subject} has an invalid byte length.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(`${subject} is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${subject} is not valid JSON.`);
  }
}
export function decodeOmpSdkSidecarRequest(input: string | Uint8Array): OmpSdkSidecarRequest {
  return parseOmpSdkSidecarRequest(decode(input, OMP_SDK_MAX_REQUEST_BYTES, 'request', requestFailure));
}
export function ompSdkOutputSchemaForRequest(
  request: OmpSdkSidecarRequest
): boolean | Readonly<Record<string, unknown>> {
  return request.outputMode === 'text' ? OMP_SDK_TEXT_OUTPUT_SCHEMA : request.outputSchema;
}

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
  exact(value, ['modelSelector', 'reasoningEffort', 'outputMode'], [], 'frame.requested', protocolFailure);
  const modelSelector = selector(value.modelSelector, 'frame.requested.modelSelector', protocolFailure);
  if (!includesLiteral(OMP_SDK_REASONING_EFFORTS, value.reasoningEffort)) protocolFailure('invalid requested effort.');
  if (value.outputMode !== 'json' && value.outputMode !== 'text') protocolFailure('invalid requested mode.');
  return { modelSelector, reasoningEffort: value.reasoningEffort as ReasoningEffort, outputMode: value.outputMode };
}
function strictOutput(value: unknown): OmpSdkStrictOutputEvidence {
  if (!isRecord(value)) protocolFailure('frame.strictOutput must be an object.');
  exact(value, ['source', 'mode', 'status', 'yield'], [], 'frame.strictOutput', protocolFailure);
  literal(value.source, 'caller', 'frame.strictOutput.source', protocolFailure);
  literal(value.mode, 'strict', 'frame.strictOutput.mode', protocolFailure);
  literal(value.status, 'valid', 'frame.strictOutput.status', protocolFailure);
  if (!isRecord(value.yield)) protocolFailure('frame.strictOutput.yield must be an object.');
  exact(value.yield, ['successful', 'incremental', 'count'], [], 'frame.strictOutput.yield', protocolFailure);
  literal(value.yield.successful, true, 'frame.strictOutput.yield.successful', protocolFailure);
  literal(value.yield.incremental, false, 'frame.strictOutput.yield.incremental', protocolFailure);
  literal(value.yield.count, 1, 'frame.strictOutput.yield.count', protocolFailure);
  return { source: 'caller', mode: 'strict', status: 'valid', yield: { successful: true, incremental: false, count: 1 } };
}
function usage(value: unknown): OmpSdkUsageEvidence {
  if (!isRecord(value)) protocolFailure('frame.usage must be an object.');
  exact(
    value,
    ['source', 'completeness', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'totalTokens', 'requests', 'durationMs', 'cost'],
    [],
    'frame.usage',
    protocolFailure
  );
  literal(value.source, 'omp-aggregate', 'frame.usage.source', protocolFailure);
  literal(value.completeness, 'unknown', 'frame.usage.completeness', protocolFailure);
  if (!isRecord(value.cost)) protocolFailure('frame.usage.cost must be an object.');
  exact(value.cost, ['input', 'output', 'cacheRead', 'cacheWrite', 'total'], [], 'frame.usage.cost', protocolFailure);
  return {
    source: 'omp-aggregate',
    completeness: 'unknown',
    inputTokens: number(value.inputTokens, 'frame.usage.inputTokens', true),
    outputTokens: number(value.outputTokens, 'frame.usage.outputTokens', true),
    cacheReadInputTokens: number(value.cacheReadInputTokens, 'frame.usage.cacheReadInputTokens', true),
    cacheCreationInputTokens: number(value.cacheCreationInputTokens, 'frame.usage.cacheCreationInputTokens', true),
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
    ['protocolVersion', 'type', 'runId', 'backend', 'runtime', 'requested', 'resolved', 'strictOutput', 'fallback', 'execution', 'value', 'usage'],
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
  const resolved = { modelSelector: selector(value.resolved.modelSelector, 'frame.resolved.modelSelector', protocolFailure) };
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
  exact(value, ['protocolVersion', 'type', 'runId', 'backend', 'runtime', 'error'], [], 'frame', protocolFailure);
  literal(value.protocolVersion, 1, 'frame.protocolVersion', protocolFailure);
  literal(value.type, 'error', 'frame.type', protocolFailure);
  const runId = parseRunId(value.runId, 'frame.runId', protocolFailure);
  if (!isRecord(value.error)) protocolFailure('frame.error must be an object.');
  exact(value.error, ['code', 'category', 'retryable', 'redacted'], [], 'frame.error', protocolFailure);
  if (!includesLiteral(OMP_SDK_ERROR_CODES, value.error.code)) protocolFailure('frame.error.code is unsupported.');
  const code = value.error.code as OmpSdkErrorCode;
  const category = CATEGORY[code];
  literal(value.error.category, category, 'frame.error.category', protocolFailure);
  if (typeof value.error.retryable !== 'boolean') protocolFailure('frame.error.retryable must be boolean.');
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
  exact(value, ['protocolVersion', 'type', 'runId', 'sequence', 'stage'], [], 'frame', protocolFailure);
  literal(value.protocolVersion, 1, 'frame.protocolVersion', protocolFailure);
  literal(value.type, 'progress', 'frame.type', protocolFailure);
  const runId = parseRunId(value.runId, 'frame.runId', protocolFailure);
  const sequence = number(value.sequence, 'frame.sequence', true);
  if (!includesLiteral(OMP_SDK_PROGRESS_STAGES, value.stage)) protocolFailure('frame.stage is unsupported.');
  return { protocolVersion: 1, type: 'progress', runId, sequence, stage: value.stage as OmpSdkProgressStage };
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

function checkedValue(frame: OmpSdkProtocolResultFrame, request: OmpSdkSidecarRequest): unknown {
  if (frame.runId !== request.runId) protocolFailure('frame.runId does not match request.');
  if (
    frame.requested.modelSelector !== request.modelSelector ||
    frame.requested.reasoningEffort !== request.reasoningEffort ||
    frame.requested.outputMode !== request.outputMode
  ) {
    protocolFailure('frame.requested does not match request.');
  }
  if (frame.resolved.modelSelector !== request.modelSelector) protocolFailure('resolved model is not exact.');
  if (request.outputMode === 'text') {
    if (typeof frame.value !== 'string') protocolFailure('invalid text result.');
    if (!schemaValidator(OMP_SDK_TEXT_OUTPUT_SCHEMA)({ result: frame.value })) {
      protocolFailure('frame.value failed host schema validation.');
    }
    return frame.value;
  }
  if (!schemaValidator(request.outputSchema)(frame.value)) {
    protocolFailure('frame.value failed host schema validation.');
  }
  return frame.value;
}
export function validateOmpSdkProtocolResultFrame(
  value: unknown,
  request: OmpSdkSidecarRequest
): OmpSdkProtocolResultFrame {
  const frame = parseOmpSdkProtocolFrame(value);
  if (frame.type !== 'result') protocolFailure('a result frame is required.');
  checkedValue(frame, request);
  return frame;
}
export function normalizeOmpSdkResultFrame(value: unknown, request: OmpSdkSidecarRequest): ResultEvent {
  const parsed = parseOmpSdkProtocolFrame(value);
  if (parsed.type !== 'result') protocolFailure('a result frame is required.');
  const frame = parsed;
  const result = checkedValue(frame, request);
  const usage = frame.usage;
  return {
    type: 'result',
    success: true,
    result,
    cost: usage.cost.total,
    duration: usage.durationMs,
    inputTokens: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    modelUsage: usage,
    requests: usage.requests,
    usageSource: 'omp-aggregate',
    usageCompleteness: 'unknown',
    invocation: { lane: 'spawn', pty: false, protocol: 'omp-sdk-v1' },
    ompSdk: {
      backend: frame.backend,
      runtime: frame.runtime,
      requested: frame.requested,
      resolved: frame.resolved,
      strictOutput: frame.strictOutput,
      fallback: false,
      execution: frame.execution,
      usage,
    },
  };
}

class Collector implements OmpSdkProtocolCollector {
  readonly #request: OmpSdkSidecarRequest;
  readonly #maxFrame: number;
  readonly #maxStdout: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #progress: OmpSdkProtocolProgressFrame[] = [];
  #pending = '';
  #bytes = 0;
  #terminal: OmpSdkCollectedTerminal | undefined;
  #closed = false;
  #failed = false;

  constructor(options: OmpSdkProtocolCollectorOptions) {
    this.#request = parseOmpSdkSidecarRequest(options.request);
    this.#maxFrame = limit(options.maxFrameBytes, OMP_SDK_MAX_FRAME_BYTES, 'maxFrameBytes');
    this.#maxStdout = limit(options.maxStdoutBytes, OMP_SDK_MAX_STDOUT_BYTES, 'maxStdoutBytes');
  }
  get progress(): readonly OmpSdkProtocolProgressFrame[] {
    return this.#progress;
  }
  write(chunk: string | Uint8Array): readonly OmpSdkProtocolFrame[] {
    this.#writable();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    if (this.#terminal !== undefined && bytes.byteLength > 0) {
      return this.#fail('data follows terminal frame.');
    }
    this.#bytes += bytes.byteLength;
    if (this.#bytes > this.#maxStdout) return this.#fail('stdout is oversized.');
    try {
      this.#pending += this.#decoder.decode(bytes, { stream: true });
    } catch {
      return this.#fail('stdout is not valid UTF-8.');
    }
    try {
      return this.#drain(false);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }
  finish(exitCode: number): OmpSdkCollectedTerminal {
    this.#writable();
    if (!Number.isInteger(exitCode) || exitCode < 0) return this.#fail('invalid sidecar exit code.');
    try {
      this.#pending += this.#decoder.decode();
    } catch {
      return this.#fail('stdout is not valid UTF-8.');
    }
    try {
      this.#drain(true);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    if (this.#terminal === undefined) return this.#fail('missing terminal frame.');
    if (this.#terminal.type === 'result' && exitCode !== 0) return this.#fail('result requires exit zero.');
    if (this.#terminal.type === 'error' && exitCode === 0) return this.#fail('error requires nonzero exit.');
    this.#closed = true;
    return this.#terminal;
  }
  #writable(): void {
    if (this.#failed) protocolFailure('collector is failed.');
    if (this.#closed) protocolFailure('collector is finished.');
  }
  #drain(final: boolean): readonly OmpSdkProtocolFrame[] {
    const frames: OmpSdkProtocolFrame[] = [];
    let newline = this.#pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      frames.push(this.#accept(line));
      newline = this.#pending.indexOf('\n');
    }
    if (final && this.#pending.length > 0) {
      const line = this.#pending;
      this.#pending = '';
      frames.push(this.#accept(line));
    } else if (Buffer.byteLength(this.#pending) > this.#maxFrame) {
      return this.#fail('frame is oversized.');
    }
    return frames;
  }
  #accept(line: string): OmpSdkProtocolFrame {
    if (this.#terminal !== undefined) return this.#fail('data follows terminal frame.');
    const bytes = Buffer.byteLength(line);
    if (bytes === 0 || bytes > this.#maxFrame) return this.#fail('frame has invalid byte length.');
    const frame = decodeOmpSdkProtocolFrame(line);
    if (frame.runId !== this.#request.runId) return this.#fail('frame.runId does not match request.');
    if (frame.type === 'progress') {
      if (frame.sequence !== this.#progress.length) return this.#fail('invalid progress sequence.');
      this.#progress.push(frame);
    } else if (frame.type === 'result') {
      this.#terminal = { type: 'result', frame, event: normalizeOmpSdkResultFrame(frame, this.#request) };
    } else {
      this.#terminal = { type: 'error', frame };
    }
    return frame;
  }
  #fail(message: string): never {
    this.#failed = true;
    return protocolFailure(message);
  }
}
function limit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    protocolFailure(`${field} must be a positive integer no greater than ${fallback}.`);
  }
  return value;
}
export function createOmpSdkProtocolCollector(
  options: OmpSdkProtocolCollectorOptions
): OmpSdkProtocolCollector {
  return new Collector(options);
}
