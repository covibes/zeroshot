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

function failureFromProviderObject(value: unknown, providerName: string): CliFailure | null {
  if (!isObjectRecord(value)) return null;
  if (providerName === 'claude') return claudeFailureFromObject(value);
  if (providerName === 'codex') return codexFailureFromObject(value);
  if (providerName === 'gemini') return geminiFailureFromObject(value);
  if (providerName === 'opencode') return opencodeFailureFromObject(value);
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
