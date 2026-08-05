import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  normalizeOmpSdkSettings,
  OMP_SDK_REASONING_EFFORTS,
  OMP_SDK_SETTINGS_DEFAULTS,
} from './sdk-settings';
import type { ConfiguredOmpSdkSettings } from './sdk-settings';
import type { ReasoningEffort } from '../types';
const MAX_PATH_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 1024 * 1024;
import {
  OMP_SDK_EXECUTION_CONTEXTS,
  OMP_SDK_MAX_REQUEST_BYTES,
  OMP_SDK_TEXT_OUTPUT_SCHEMA,
  type OmpSdkExecutionContext,
  type OmpSdkSidecarRequest,
} from './sdk-protocol-types';
import {
  exact,
  immutableJsonSnapshot,
  includesLiteral,
  isRecord,
  json,
  literal,
  parseRunId,
  requestFailure,
  schemaValidator,
  selector,
  serializedLimit,
  string,
  validateSchemaSafety,
  type Fail,
} from './sdk-protocol-value';

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
  const normalizedSettings = ((): Readonly<ConfiguredOmpSdkSettings> => {
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
    if (
      value.outputSchema !== true &&
      value.outputSchema !== false &&
      !isRecord(value.outputSchema)
    ) {
      requestFailure('request.outputSchema must be a JSON Schema object or boolean.');
    }
    json(value.outputSchema, 'request.outputSchema', requestFailure);
    validateSchemaSafety(value.outputSchema);
    const outputSchema = immutableJsonSnapshot(value.outputSchema);
    schemaValidator(outputSchema);
    return Object.freeze({ ...base, outputMode: 'json' as const, outputSchema });
  }
  if (value.outputMode !== 'text') requestFailure('request.outputMode must be "json" or "text".');
  if (value.outputSchema !== undefined)
    requestFailure('request.outputSchema is forbidden in text mode.');
  return Object.freeze({ ...base, outputMode: 'text' as const });
}

export function decode(
  input: string | Uint8Array,
  max: number,
  subject: string,
  fail: Fail
): unknown {
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (bytes.byteLength === 0 || bytes.byteLength > max)
    fail(`${subject} has an invalid byte length.`);
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
  return parseOmpSdkSidecarRequest(
    decode(input, OMP_SDK_MAX_REQUEST_BYTES, 'request', requestFailure)
  );
}
/** @returns The built-in text schema or the request's validated JSON Schema. */
export function ompSdkOutputSchemaForRequest(
  request: OmpSdkSidecarRequest
): boolean | Readonly<Record<string, unknown>> {
  let outputSchema: boolean | Readonly<Record<string, unknown>> = OMP_SDK_TEXT_OUTPUT_SCHEMA;
  if (request.outputMode === 'json') outputSchema = request.outputSchema;
  return outputSchema;
}
