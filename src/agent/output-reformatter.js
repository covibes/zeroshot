/**
 * Output Reformatter - Convert non-JSON output to valid JSON
 *
 * When an LLM outputs markdown/text instead of JSON despite schema instructions,
 * this module attempts to extract/reformat the content into valid JSON.
 *
 * Opencode output can be reformatted through its CLI when direct JSON extraction fails.
 * Other providers remain on their own extraction paths and never depend on the opencode binary.
 */

const DEFAULT_MAX_ATTEMPTS = 3;


function createCancellationError() {
  const error = new Error('Output reformatting cancelled');
  error.code = 'REFORMAT_CANCELLED';
  return error;
}


/**
 * Build the reformatting prompt
 *
 * @param {string} rawOutput - The non-JSON output to reformat
 * @param {Object} schema - Target JSON schema
 * @param {string|null} previousError - Error from previous attempt (for feedback)
 * @returns {string} The prompt for the reformatting model
 */
function buildReformatPrompt(rawOutput, schema, previousError = null) {
  const schemaStr = JSON.stringify(schema, null, 2);
  // Truncate long outputs to avoid context limits
  const truncatedOutput = rawOutput.length > 4000 ? rawOutput.slice(-4000) : rawOutput;

  let prompt = `CRITICAL: Do NOT use any tools. Do NOT read, write, or edit any files. Do NOT explore the codebase. This is a pure text-to-JSON transformation — respond with JSON only.

Convert this text into a JSON object matching the schema.

## SCHEMA
\`\`\`json
${schemaStr}
\`\`\`

## TEXT TO CONVERT
\`\`\`
${truncatedOutput}
\`\`\`

## RULES
- Output ONLY the JSON object
- NO markdown code blocks
- NO explanations
- Start with { end with }
- Match ALL required fields from schema`;

  if (previousError) {
    prompt += `

## PREVIOUS ATTEMPT FAILED
Error: ${previousError}
Fix this issue in your response.`;
  }

  return prompt;
}

/**
 * This fallback is intentionally scoped to opencode agents. It participates in agent
 * cancellation so retries cannot outlive cluster shutdown.
 *
 * @param {Object} options
 * @param {string} options.rawOutput - The non-JSON output to reformat
 * @param {Object} options.schema - Target JSON schema
 * @param {string} options.providerName - Active provider name
 * @param {number} [options.maxAttempts=3] - Maximum reformatting attempts
 * @param {Function} [options.onAttempt] - Callback for each attempt (attempt, error)
 * @param {Function} [options.isCancelled] - Returns true after agent cancellation
 * @param {Function} options.runReformat - Runs the prompt in the active agent execution context
 * @returns {Promise<Object>} The reformatted JSON object
 * @throws {Error} If the provider is unsupported, cancellation occurs, or attempts fail
 */
async function reformatOutput({
  rawOutput,
  schema,
  providerName,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  onAttempt,
  isCancelled = () => false,
  runReformat,
}) {
  if (providerName !== 'opencode') {
    throw new Error(
      `Output reformatting not available for provider "${providerName}". ` +
        `Agent output must be valid JSON. Raw output (last 200 chars): ${(rawOutput || '').slice(-200)}`
    );
  }
  if (typeof runReformat !== 'function') {
    throw new Error('Output reformatting requires the active agent execution context');
  }


  const { extractJsonFromOutput } = require('./output-extraction');
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled()) throw createCancellationError();
    if (onAttempt) {
      onAttempt(attempt, lastError);
    }

    const prompt = buildReformatPrompt(rawOutput, schema, lastError);

    try {
      const result = await runReformat(prompt);
      if (isCancelled()) throw createCancellationError();
      if (!result?.success) {
        lastError = result?.error || 'reformat task failed';
        continue;
      }
      const output = result.output;
      if (!output) {
        lastError = 'reformat task returned no output';
        continue;
      }

      const parsed = extractJsonFromOutput(output, 'opencode');
      if (!parsed) {
        lastError = 'Could not extract JSON from reformatted output';
        continue;
      }

      const validationError = validateAgainstSchema(parsed, schema);
      if (validationError) {
        lastError = validationError;
        continue;
      }

      return parsed;
    } catch (err) {
      if (
        err.code === 'REFORMAT_CANCELLED' ||
        err.code === 'AGENT_TASK_TIMEOUT' ||
        err.nestedExecutionLifecycle === true ||
        err.retainTaskHandle === true ||
        err.permanent === true ||
        err.terminationExhausted === true
      ) {
        throw err;
      }
      lastError = err.message;
    }
  }

  throw new Error(
    `Failed to reformat output after ${maxAttempts} attempts (provider "${providerName}"). ` +
      `Last error: ${lastError}. Raw output (last 200 chars): ${(rawOutput || '').slice(-200)}`
  );
}

/**
 * Validate parsed output against JSON schema
 *
 * @param {Object} parsed - Parsed JSON object
 * @param {Object} schema - JSON schema to validate against
 * @returns {string|null} Error message if validation failed, null if valid
 */
function validateAgainstSchema(parsed, schema) {
  const Ajv = require('ajv');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(parsed);

  if (!valid) {
    const errors = (validate.errors || [])
      .slice(0, 3)
      .map((e) => `${e.instancePath || '#'} ${e.message}`)
      .join('; ');
    return errors || 'Schema validation failed';
  }

  return null;
}

module.exports = {
  reformatOutput,
  buildReformatPrompt,
  validateAgainstSchema,
  DEFAULT_MAX_ATTEMPTS,
};
