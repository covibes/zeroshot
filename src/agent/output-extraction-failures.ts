import errorDetail = require('./output-extraction-error-detail');
import jsonExtraction = require('./output-extraction-json');
import piExtraction = require('./output-extraction-pi');
import type {
  CliError,
  CliFailure,
  JsonRecord,
  VertexModelFailure,
} from './output-extraction-types';

const { MAX_CLI_ERROR_BYTES, cliErrorDetail } = errorDetail;
const { isObjectRecord, parseJsonRecordLine } = jsonExtraction;
const { extractSettledPiFailure } = piExtraction;

const OMP_SDK_ERROR_CODES = new Map([
  ['invalid-request', 'request'],
  ['model-resolution', 'model'],
  ['model-fallback', 'model'],
  ['provider-auth', 'auth'],
  ['provider-rate-limit', 'rate-limit'],
  ['provider-timeout', 'timeout'],
  ['provider-error', 'provider'],
  ['schema-violation', 'schema'],
  ['cancelled', 'cancelled'],
  ['sdk-error', 'sdk'],
  ['cleanup-error', 'cleanup'],
  ['internal-error', 'internal'],
]);

function firstTruthyValue(...values: readonly unknown[]): unknown {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}

function recordField(value: unknown, field: string): unknown {
  return isObjectRecord(value) ? value[field] : undefined;
}

function nestedRecordField(value: unknown, parent: string, field: string): unknown {
  return recordField(recordField(value, parent), field);
}

function claudeFailureFromObject(value: JsonRecord): CliFailure | null {
  if (value.type !== 'result') return null;
  if (value.is_error === true) {
    const errors = value.errors;
    const source = Array.isArray(errors) ? errors : firstTruthyValue(value.error, value.result);
    return { ...cliErrorDetail(source, 'Unknown CLI error'), provider: 'claude' };
  }
  if (value.subtype !== 'error') return null;
  return {
    ...cliErrorDetail(firstTruthyValue(value.error, value.result), 'CLI returned error'),
    provider: 'claude',
  };
}

function codexFailureFromObject(value: JsonRecord): CliFailure | null {
  if (value.type !== 'turn.failed') return null;
  const source = firstTruthyValue(
    nestedRecordField(value, 'error', 'message'),
    nestedRecordField(value, 'error', 'code'),
    value.error
  );
  return { ...cliErrorDetail(source, 'Turn failed'), provider: 'codex' };
}

function geminiFailureFromObject(value: JsonRecord): CliFailure | null {
  const failure =
    (value.type === 'result' && value.status === 'error') ||
    (value.type === 'error' && value.severity === 'error');
  if (!failure) return null;
  const source = firstTruthyValue(nestedRecordField(value, 'error', 'message'), value.message);
  return { ...cliErrorDetail(source, 'Gemini CLI error'), provider: 'gemini' };
}

function opencodeFailureFromObject(value: JsonRecord): CliFailure | null {
  if (value.type !== 'session.error' && value.type !== 'error') return null;
  const error = value.error;
  const source = firstTruthyValue(
    recordField(recordField(error, 'data'), 'message'),
    recordField(error, 'message'),
    recordField(error, 'name')
  );
  return { ...cliErrorDetail(source, 'Session error'), provider: 'opencode' };
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isOmpSdkIdentity(
  value: unknown,
  nameField: 'id' | 'name',
  expectedName: string,
  expectedVersion: string
): boolean {
  return (
    isObjectRecord(value) &&
    value[nameField] === expectedName &&
    value.version === expectedVersion &&
    hasExactKeys(value, [nameField, 'version'])
  );
}

interface OmpSdkErrorMetadata {
  readonly category: string;
  readonly code: string;
  readonly retryable: boolean;
}

function ompSdkErrorMetadata(value: unknown): OmpSdkErrorMetadata | null {
  if (!isObjectRecord(value)) return null;
  const { category, code, redacted, retryable } = value;
  if (
    typeof code !== 'string' ||
    typeof category !== 'string' ||
    OMP_SDK_ERROR_CODES.get(code) !== category ||
    typeof retryable !== 'boolean' ||
    redacted !== true ||
    !hasExactKeys(value, ['category', 'code', 'redacted', 'retryable'])
  ) {
    return null;
  }
  return { category, code, retryable };
}

function ompProviderCategory(
  error: OmpSdkErrorMetadata
): NonNullable<CliFailure['providerCategory']> {
  if (error.category === 'auth') return 'authentication';
  return error.retryable ? 'transient' : 'permanent';
}

function isOmpSdkRunId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function isOmpSdkErrorEnvelope(value: JsonRecord): boolean {
  return (
    value.protocolVersion === 1 &&
    value.type === 'error' &&
    isOmpSdkRunId(value.runId) &&
    hasExactKeys(value, ['backend', 'error', 'protocolVersion', 'runId', 'runtime', 'type']) &&
    isOmpSdkIdentity(value.backend, 'id', 'omp-sdk', '17.2.1') &&
    isOmpSdkIdentity(value.runtime, 'name', 'bun', '1.3.14')
  );
}

function ompSdkFailureFromObject(value: JsonRecord): CliFailure | null {
  const error = ompSdkErrorMetadata(value.error);
  if (error === null || !isOmpSdkErrorEnvelope(value)) return null;
  const detail = `OMP SDK ${error.code} (${error.category})`;
  return {
    ...cliErrorDetail(detail, 'OMP SDK turn failed'),
    provider: 'omp',
    providerCategory: ompProviderCategory(error),
    providerClassification: {
      retryable: error.retryable,
      kind: error.retryable ? 'unknown-retryable' : 'permanent-pattern',
    },
  };
}

function failureFromProviderObject(value: unknown, providerName: string): CliFailure | null {
  if (!isObjectRecord(value)) return null;
  if (providerName === 'claude') return claudeFailureFromObject(value);
  if (providerName === 'codex') return codexFailureFromObject(value);
  if (providerName === 'gemini') return geminiFailureFromObject(value);
  if (providerName === 'opencode') return opencodeFailureFromObject(value);
  if (providerName === 'omp') return ompSdkFailureFromObject(value);
  return null;
}

interface VertexOptions {
  useVertex?: boolean;
}

function vertexModelFromResult(parsed: JsonRecord, useVertex: boolean): VertexModelFailure | null {
  if (
    parsed.type !== 'result' ||
    parsed.is_error !== true ||
    parsed.api_error_status !== 404 ||
    typeof parsed.result !== 'string'
  ) {
    return null;
  }

  const model = /model\s+\(([^)]+)\)/.exec(parsed.result)?.[1];
  const explicitVertexSignal = parsed.result.includes('vertex deployment');
  const configuredVertexFallback =
    useVertex && parsed.result.includes('may not exist or you may not have access');
  return model && (explicitVertexSignal || configuredVertexFallback) ? { model } : null;
}

function extractClaudeVertexModelError(
  output: unknown,
  { useVertex = false }: VertexOptions = {}
): VertexModelFailure | null {
  if (!output || typeof output !== 'string') return null;
  for (const line of output.split('\n')) {
    const parsed = parseJsonRecordLine(line);
    if (parsed === null) continue;
    const failure = vertexModelFromResult(parsed, useVertex);
    if (failure) return failure;
  }
  return null;
}

function extractCliFailure(output: unknown, providerName = 'claude'): CliFailure | null {
  if (providerName === 'pi') {
    const lines = typeof output === 'string' ? output.split('\n') : [];
    return extractSettledPiFailure(lines);
  }
  if (!output || typeof output !== 'string') return null;

  const lines = output.split('\n');
  if (providerName === 'codex') lines.reverse();

  for (const line of lines) {
    const parsed = parseJsonRecordLine(line);
    if (parsed === null) continue;
    const failure = failureFromProviderObject(parsed, providerName);
    if (failure) return failure;
  }

  return null;
}

function extractCliError(output: unknown, providerName = 'claude'): CliError | null {
  const failure = extractCliFailure(output, providerName);
  return failure ? { error: failure.error, provider: failure.provider } : null;
}

export = {
  MAX_CLI_ERROR_BYTES,
  cliErrorDetail,
  extractClaudeVertexModelError,
  extractCliError,
  extractCliFailure,
};
