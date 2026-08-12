import Ajv from 'ajv';
import outputReformatterErrors = require('./output-reformatter-errors');
import type { ErrorObject, Schema } from 'ajv';
import type {
  OutputExtractionBoundary,
  RecoveryAttemptArguments,
  RecoveryAttemptOutcome,
  RecoveryError,
  ReformatOutputArguments,
  ReformatOutcome,
  SchemaUtilsBoundary,
  StructuredOutputValidator,
} from './output-reformatter-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchemaUtilsBoundary(value: unknown): value is SchemaUtilsBoundary {
  return isRecord(value) && typeof value.normalizeEnumValues === 'function';
}

function isOutputExtractionBoundary(value: unknown): value is OutputExtractionBoundary {
  return (
    isRecord(value) &&
    typeof value.extractCliError === 'function' &&
    typeof value.extractJsonFromOutput === 'function'
  );
}

const { invocationError, markImmediateRecoveryFailure, recoveryErrorMessage } =
  outputReformatterErrors;

const rawSchemaUtils: unknown = require('./schema-utils');
if (!isSchemaUtilsBoundary(rawSchemaUtils)) {
  throw new TypeError('schema-utils module must expose normalizeEnumValues');
}
const { normalizeEnumValues } = rawSchemaUtils;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_REFORMAT_INPUT_BYTES = 65_536;
const MAX_CONFIGURED_ATTEMPTS = 10;

function createCancellationError(): RecoveryError {
  const error: RecoveryError = new Error('Output reformatting cancelled');
  error.code = 'REFORMAT_CANCELLED';
  error.recoveryAbort = true;
  return error;
}

function buildReformatPrompt(
  rawOutput: string,
  schema: Schema,
  previousError: string | null = null
): string {
  let prompt =
    'CRITICAL: Do NOT use any tools. Do NOT read, write, or edit any files. ' +
    `Do NOT explore the codebase. This is a pure text-to-JSON transformation — respond with JSON only.

Convert the JSON-encoded source text into a JSON object matching the schema.

## SCHEMA
\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

## JSON-ENCODED SOURCE TEXT
${JSON.stringify(rawOutput)}

## RULES
- Output ONLY the JSON object
- NO markdown code blocks
- NO explanations
- Start with { end with }
- Match ALL required fields from schema`;

  if (previousError) {
    prompt += `

## PREVIOUS CANDIDATE FAILED
${previousError}
Fix this issue in your response.`;
  }

  return prompt;
}

function formatValidationErrors(errors: readonly ErrorObject[], limit = 5): string {
  return errors
    .slice(0, limit)
    .map((error) => `${error.instancePath || error.schemaPath || '#'} ${error.message}`)
    .join('; ');
}

function createStructuredOutputValidator(schema: Schema): StructuredOutputValidator {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    useDefaults: true,
    removeAdditional: true,
  });
  const validate = ajv.compile<unknown>(schema);

  return (candidate: unknown) => {
    normalizeEnumValues(candidate, schema);
    const valid = validate(candidate);
    const errors = (validate.errors ?? []).map((error) => ({ ...error }));
    return {
      valid,
      value: candidate,
      errors,
      error: valid ? null : formatValidationErrors(errors) || 'Schema validation failed',
    };
  };
}

function validateAgainstSchema(parsed: unknown, schema: Schema): string | null {
  return createStructuredOutputValidator(schema)(parsed).error;
}

function assertReformatRequest(rawOutput: string, maxAttempts: number): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CONFIGURED_ATTEMPTS) {
    const error: RecoveryError = new RangeError(
      `Output reformatting maxAttempts must be an integer from 1 through ${MAX_CONFIGURED_ATTEMPTS}`
    );
    error.code = 'REFORMAT_INVALID_ATTEMPT_LIMIT';
    error.permanent = true;
    throw error;
  }
  if (Buffer.byteLength(rawOutput || '', 'utf8') > MAX_REFORMAT_INPUT_BYTES) {
    const error: RecoveryError = new Error(
      `Output reformatting input exceeds ${MAX_REFORMAT_INPUT_BYTES} UTF-8 bytes`
    );
    error.code = 'REFORMAT_INPUT_TOO_LARGE';
    error.permanent = true;
    throw error;
  }
}

function loadOutputExtraction(): OutputExtractionBoundary {
  const rawOutputExtraction: unknown = require('./output-extraction');
  if (!isOutputExtractionBoundary(rawOutputExtraction)) {
    throw new TypeError('output-extraction module must expose structured-output extractors');
  }
  return rawOutputExtraction;
}

async function recoverCandidate({
  prompt,
  providerName,
  validateCandidate,
  isCancelled,
  runReformat,
}: RecoveryAttemptArguments): Promise<RecoveryAttemptOutcome> {
  const result = await runReformat(prompt);
  if (isCancelled()) throw createCancellationError();
  if (!result?.success) {
    const error = invocationError(result);
    if (markImmediateRecoveryFailure(error, providerName)) throw error;
    return { status: 'retry', error: error.message };
  }
  if (!result.output) return { status: 'retry', error: 'Recovery task returned no output' };

  const { extractCliError, extractJsonFromOutput } = loadOutputExtraction();
  const terminalError = extractCliError(result.output, providerName);
  if (terminalError) {
    const error: RecoveryError = new Error(terminalError.error);
    error.provider = terminalError.provider;
    if (markImmediateRecoveryFailure(error, providerName)) throw error;
    return { status: 'retry', error: error.message };
  }

  const parsed = extractJsonFromOutput(result.output, providerName);
  if (!parsed) return { status: 'retry', error: 'Could not extract JSON from recovery output' };

  const validation = validateCandidate(parsed);
  return validation.valid
    ? { status: 'recovered', value: validation.value }
    : { status: 'retry', error: validation.error };
}

async function reformatOutput({
  rawOutput,
  schema,
  providerName,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  initialError = null,
  validateCandidate = createStructuredOutputValidator(schema),
  onAttempt,
  isCancelled = (): boolean => false,
  runReformat,
}: ReformatOutputArguments): Promise<ReformatOutcome> {
  assertReformatRequest(rawOutput, maxAttempts);
  if (typeof runReformat !== 'function') {
    throw new Error('Output reformatting requires the active agent execution context');
  }

  let lastError = initialError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled()) throw createCancellationError();
    onAttempt?.(attempt, lastError);
    const prompt = buildReformatPrompt(rawOutput, schema, lastError);

    try {
      const outcome = await recoverCandidate({
        prompt,
        providerName,
        validateCandidate,
        isCancelled,
        runReformat,
      });
      if (outcome.status === 'recovered') {
        return { status: 'recovered', value: outcome.value, attempts: attempt };
      }
      lastError = outcome.error;
    } catch (caught) {
      if (isCancelled()) throw createCancellationError();
      lastError = recoveryErrorMessage(caught, providerName);
    }
  }

  return {
    status: 'exhausted',
    attempts: maxAttempts,
    lastError: lastError || 'Recovery attempts produced no schema-valid JSON object',
  };
}

export = {
  reformatOutput,
  buildReformatPrompt,
  createStructuredOutputValidator,
  validateAgainstSchema,
  DEFAULT_MAX_ATTEMPTS,
  MAX_REFORMAT_INPUT_BYTES,
  MAX_CONFIGURED_ATTEMPTS,
};
