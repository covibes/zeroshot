const Ajv = require('ajv');
const { getProvider } = require('../providers');
const { normalizeEnumValues } = require('./schema-utils');

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_REFORMAT_INPUT_BYTES = 65_536;
const MAX_CONFIGURED_ATTEMPTS = 10;

function createCancellationError() {
  const error = new Error('Output reformatting cancelled');
  error.code = 'REFORMAT_CANCELLED';
  error.recoveryAbort = true;
  return error;
}

function buildReformatPrompt(rawOutput, schema, previousError = null) {
  let prompt = `CRITICAL: Do NOT use any tools. Do NOT read, write, or edit any files. Do NOT explore the codebase. This is a pure text-to-JSON transformation — respond with JSON only.

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

function formatValidationErrors(errors, limit = 5) {
  return errors
    .slice(0, limit)
    .map((error) => `${error.instancePath || error.schemaPath || '#'} ${error.message}`)
    .join('; ');
}

function createStructuredOutputValidator(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    useDefaults: true,
    removeAdditional: true,
  });
  const validate = ajv.compile(schema);

  return (candidate) => {
    normalizeEnumValues(candidate, schema);
    const valid = validate(candidate);
    const errors = (validate.errors || []).map((error) => ({ ...error }));
    return {
      valid,
      value: candidate,
      errors,
      error: valid ? null : formatValidationErrors(errors) || 'Schema validation failed',
    };
  };
}

function validateAgainstSchema(parsed, schema) {
  return createStructuredOutputValidator(schema)(parsed).error;
}

function assertReformatRequest(rawOutput, maxAttempts) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CONFIGURED_ATTEMPTS) {
    const error = new RangeError(
      `Output reformatting maxAttempts must be an integer from 1 through ${MAX_CONFIGURED_ATTEMPTS}`
    );
    error.code = 'REFORMAT_INVALID_ATTEMPT_LIMIT';
    error.permanent = true;
    throw error;
  }
  if (Buffer.byteLength(rawOutput || '', 'utf8') > MAX_REFORMAT_INPUT_BYTES) {
    const error = new Error(
      `Output reformatting input exceeds ${MAX_REFORMAT_INPUT_BYTES} UTF-8 bytes`
    );
    error.code = 'REFORMAT_INPUT_TOO_LARGE';
    error.permanent = true;
    throw error;
  }
}

function invocationError(result) {
  const error =
    result?.error instanceof Error
      ? result.error
      : new Error(result?.error || 'Structured-output recovery task failed');
  for (const field of [
    'code',
    'permanent',
    'provider',
    'capability',
    'nestedExecutionCancellation',
    'nestedExecutionLifecycle',
    'retainTaskHandle',
    'terminationExhausted',
    'taskId',
  ]) {
    if (result?.[field] !== undefined && error[field] === undefined) {
      error[field] = result[field];
    }
  }
  return error;
}

function isImmediateRecoveryFailure(error, providerName) {
  if (
    error?.code === 'REFORMAT_CANCELLED' ||
    error?.code === 'AGENT_TASK_TIMEOUT' ||
    error?.nestedExecutionCancellation === true ||
    error?.nestedExecutionLifecycle === true ||
    error?.retainTaskHandle === true ||
    error?.permanent === true ||
    error?.terminationExhausted === true
  ) {
    return true;
  }
  return !getProvider(providerName).isRetryableError(error);
}

function markImmediateRecoveryFailure(error, providerName) {
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

async function reformatOutput({
  rawOutput,
  schema,
  providerName,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  initialError = null,
  validateCandidate = createStructuredOutputValidator(schema),
  onAttempt,
  isCancelled = () => false,
  runReformat,
}) {
  assertReformatRequest(rawOutput, maxAttempts);
  if (typeof runReformat !== 'function') {
    throw new Error('Output reformatting requires the active agent execution context');
  }

  const { extractCliError, extractJsonFromOutput } = require('./output-extraction');
  let lastError = initialError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled()) throw createCancellationError();
    onAttempt?.(attempt, lastError);
    const prompt = buildReformatPrompt(rawOutput, schema, lastError);

    try {
      const result = await runReformat(prompt);
      if (isCancelled()) throw createCancellationError();
      if (!result?.success) {
        const error = invocationError(result);
        if (markImmediateRecoveryFailure(error, providerName)) throw error;
        lastError = error.message;
        continue;
      }
      if (!result.output) {
        lastError = 'Recovery task returned no output';
        continue;
      }
      const terminalError = extractCliError(result.output, providerName);
      if (terminalError) {
        const error = new Error(terminalError.error);
        error.provider = terminalError.provider;
        if (markImmediateRecoveryFailure(error, providerName)) throw error;
        lastError = error.message;
        continue;
      }

      const parsed = extractJsonFromOutput(result.output, providerName);
      if (!parsed) {
        lastError = 'Could not extract JSON from recovery output';
        continue;
      }
      const validation = validateCandidate(parsed);
      if (!validation.valid) {
        lastError = validation.error;
        continue;
      }
      return { status: 'recovered', value: validation.value, attempts: attempt };
    } catch (error) {
      if (isCancelled()) throw createCancellationError();
      if (markImmediateRecoveryFailure(error, providerName)) throw error;
      lastError = error.message;
    }
  }

  return {
    status: 'exhausted',
    attempts: maxAttempts,
    lastError: lastError || 'Recovery attempts produced no schema-valid JSON object',
  };
}

module.exports = {
  reformatOutput,
  buildReformatPrompt,
  createStructuredOutputValidator,
  validateAgainstSchema,
  DEFAULT_MAX_ATTEMPTS,
  MAX_REFORMAT_INPUT_BYTES,
  MAX_CONFIGURED_ATTEMPTS,
};
