/**
 * Output Extraction Module - Multi-Provider JSON Extraction
 *
 * Clean extraction pipeline for structured JSON from AI provider outputs.
 * Each provider has different output formats - this module normalizes them.
 *
 * Provider formats:
 * - Claude: {"type":"result","result":{...}} or {"type":"result","structured_output":{...}}
 * - Codex: Raw text in item.created events, turn.completed has NO result field
 * - Gemini: Raw text in message events, result event may have NO result field
 *
 * Extraction priority (most specific → least specific):
 * 1. Result wrapper with content (type:result + result/structured_output field)
 * 2. Accumulated text from provider parser events
 * 3. Markdown code block extraction
 * 4. Direct JSON parse of entire output
 */

const { createHash } = require('node:crypto');
const { parseProviderChunk } = require('../providers');

const MAX_CLI_ERROR_BYTES = 4096;
const CLI_ERROR_TRUNCATION_SUFFIX = '… [truncated]';

function truncateUtf8(text, maxBytes = MAX_CLI_ERROR_BYTES) {
  if (Buffer.byteLength(text) <= maxBytes) return text;

  const suffixBytes = Buffer.byteLength(CLI_ERROR_TRUNCATION_SUFFIX);
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let truncated = '';
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    truncated += character;
    bytes += characterBytes;
  }
  return `${truncated}${CLI_ERROR_TRUNCATION_SUFFIX}`;
}

function primitiveErrorText(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function cliErrorDetail(value, fallback) {
  const candidate = Array.isArray(value)
    ? value
        .map(primitiveErrorText)
        .filter((message) => message.trim())
        .join('; ')
    : primitiveErrorText(value);
  const raw = candidate.trim() ? candidate : fallback;
  return {
    error: truncateUtf8(raw.trim()),
    diagnostic: {
      byteLength: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  };
}

/**
 * Strip timestamp prefix from log lines.
 * Format: [epochMs]content or [epochMs]{json...}
 *
 * @param {string} line - Raw log line
 * @returns {string} Content without timestamp prefix
 */
function stripTimestamp(line) {
  if (!line || typeof line !== 'string') return '';
  let trimmed = line.trim().replace(/\r$/, '');
  if (!trimmed) return '';

  const tsMatch = trimmed.match(/^\[(\d{13})\](.*)$/);
  if (tsMatch) trimmed = (tsMatch[2] || '').trimStart();

  // In cluster logs, lines are often prefixed like:
  // "validator       | {json...}"
  // Strip the "<agent> | " prefix so we can JSON.parse the event line.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const pipeMatch = trimmed.match(/^[^|]{1,40}\|\s*(.*)$/);
    if (pipeMatch) {
      const afterPipe = (pipeMatch[1] || '').trimStart();
      if (afterPipe.startsWith('{') || afterPipe.startsWith('[')) return afterPipe;
    }
  }

  return trimmed;
}

/**
 * Strategy 1: Extract from result wrapper
 * Handles Claude CLI format: {"type":"result","result":{...}}
 *
 * @param {string} output - Raw output
 * @returns {object|null} Extracted JSON or null
 */
function extractFromResultWrapper(output) {
  const lines = output.split('\n');

  for (const line of lines) {
    const content = stripTimestamp(line);
    if (!content.startsWith('{')) continue;

    try {
      const obj = JSON.parse(content);
      const extracted = extractResultContent(obj);
      if (extracted) return extracted;
    } catch {
      // Not valid JSON, continue to next line
    }
  }

  return null;
}

function extractResultContent(obj) {
  // Must be type:result WITH actual content
  if (obj?.type !== 'result') return null;

  // Check structured_output first (standard CLI format)
  if (obj.structured_output && typeof obj.structured_output === 'object') {
    return obj.structured_output;
  }

  // Check result field - can be object or string
  if (!obj.result) return null;

  if (typeof obj.result === 'object') {
    return obj.result;
  }

  if (typeof obj.result !== 'string') return null;

  // Result is string - might contain markdown-wrapped JSON
  return extractFromMarkdown(obj.result) || extractDirectJson(obj.result);
}

/**
 * Strategy 2: Extract from accumulated text events
 * Handles non-Claude providers where JSON is in text content
 *
 * @param {string} output - Raw output
 * @param {string} providerName - Provider name for parser selection
 * @returns {object|null} Extracted JSON or null
 */
function extractFromTextEvents(output, providerName) {
  const normalized = output
    .split('\n')
    .map((line) => stripTimestamp(line))
    .filter(Boolean)
    .join('\n');
  const events = parseProviderChunk(providerName, normalized);

  // Fast-path: many providers eventually emit the full JSON as a single text event.
  // Scan from the end to find the last parseable JSON snippet without requiring
  // the entire concatenated stream to be valid JSON.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'text' || typeof e.text !== 'string') continue;
    const direct = extractDirectJson(e.text) || extractFromMarkdown(e.text);
    if (direct) return direct;
  }

  // Accumulate all text events
  const textEvents = events.filter((e) => e.type === 'text').map((e) => e.text);
  const textContent = textEvents.join('');

  if (!textContent.trim()) return null;

  // Try parsing accumulated text as JSON
  const combined = extractDirectJson(textContent) || extractFromMarkdown(textContent);
  if (combined) return combined;

  for (let i = textEvents.length - 1; i >= 0; i--) {
    const candidate = textEvents[i];
    const parsed = extractDirectJson(candidate) || extractFromMarkdown(candidate);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Assemble assistant text through the active provider parser. Recovery prompts
 * use this instead of exposing raw event envelopes when model text exists.
 *
 * @param {string} output
 * @param {string} providerName
 * @returns {string|null}
 */
function extractModelTextFromOutput(output, providerName) {
  if (!output || typeof output !== 'string') return null;
  const normalized = output
    .split('\n')
    .map((line) => stripTimestamp(line))
    .filter(Boolean)
    .join('\n');
  const text = parseProviderChunk(providerName, normalized)
    .filter((event) => event.type === 'text' && typeof event.text === 'string')
    .map((event) => event.text)
    .join('');
  return text.trim() ? text : null;
}

/**
 * Strategy 3: Extract JSON from markdown code block
 * Handles: ```json\n{...}\n```
 *
 * @param {string} text - Text that may contain markdown
 * @returns {object|null} Extracted JSON or null
 */
function extractFromMarkdown(text) {
  if (!text) return null;

  // Match ```json ... ``` with any whitespace
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  } catch {
    // Invalid JSON in markdown block
  }

  return null;
}

/**
 * CLI metadata fields that indicate raw provider output (not agent content).
 * These objects should be rejected - they're wrapper metadata, not actual output.
 */
const CLI_METADATA_FIELDS = new Set([
  'duration_ms',
  'duration_api_ms',
  'total_cost_usd',
  'session_id',
  'num_turns',
  'permission_denials',
  'modelUsage',
]);

/**
 * Check if an object looks like CLI metadata rather than agent output.
 * CLI metadata has specific fields like duration_ms, session_id, etc.
 *
 * @param {object} obj - Parsed JSON object
 * @returns {boolean} True if this looks like CLI metadata
 */
function isCliMetadata(obj) {
  if (!obj || typeof obj !== 'object') return false;

  // If it has type:result, it's definitely CLI wrapper (should have been handled by extractFromResultWrapper)
  if (obj.type === 'result') return true;

  // Check for CLI-specific metadata fields
  const keys = Object.keys(obj);
  const metadataFieldCount = keys.filter((k) => CLI_METADATA_FIELDS.has(k)).length;

  // If 2+ CLI metadata fields present, reject as CLI output
  return metadataFieldCount >= 2;
}

/**
 * Strategy 4: Direct JSON parse
 * Handles raw JSON output (single-line or multi-line)
 *
 * IMPORTANT: Rejects CLI metadata objects to prevent schema validation
 * against wrong data structure (e.g., validating {duration_ms, session_id}
 * against agent schema expecting {summary, completionStatus}).
 *
 * @param {string} text - Text to parse
 * @returns {object|null} Parsed JSON or null
 */
function extractDirectJson(text) {
  if (!text) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Reject CLI metadata - this is wrapper output, not agent content
      if (isCliMetadata(parsed)) {
        return null;
      }
      return parsed;
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

/**
 * Extract deterministic Claude Vertex model-unavailability metadata from the raw CLI envelope.
 *
 * @param {string} output - Raw Claude CLI output
 * @param {{useVertex?: boolean}} [options] - Whether the Claude task was configured for Vertex
 * @returns {{model: string}|null} Vertex model metadata or null
 */
function extractClaudeVertexModelError(output, { useVertex = false } = {}) {
  if (!output || typeof output !== 'string') return null;

  for (const line of output.split('\n')) {
    const content = stripTimestamp(line);
    if (!content.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(content);
      if (
        parsed.type !== 'result' ||
        parsed.is_error !== true ||
        parsed.api_error_status !== 404 ||
        typeof parsed.result !== 'string'
      ) {
        continue;
      }
      const modelMatch = parsed.result.match(/model\s+\(([^)]+)\)/);
      const hasExplicitVertexSignal = parsed.result.includes('vertex deployment');
      const isVertexFallback =
        useVertex && parsed.result.includes('may not exist or you may not have access');
      if (!modelMatch || (!hasExplicitVertexSignal && !isVertexFallback)) continue;

      return { model: modelMatch[1] };
    } catch {
      // Not a JSON result envelope.
    }
  }

  return null;
}

/**
 * Extract CLI error from provider output (all providers).
 * Returns the error message if the CLI reported an error, null otherwise.
 *
 * Provider error formats:
 * - Claude: {type:"result", is_error:true, errors:["msg"]} or {type:"result", subtype:"error"}
 * - Codex:  {type:"turn.failed", error:{message:"msg"}}
 * - Gemini: {type:"result", status:"error", error:{message:"msg"}} or {type:"error", severity:"error"}
 * - Opencode: {type:"session.error", error:{message:"msg"}}
 *
 * @param {string} providerName - Active provider whose terminal errors may be inspected
 * @returns {{error: string, provider: string}|null} Error info or null
 */
function claudeFailureFromObject(obj) {
  if (obj.type !== 'result') return null;
  if (obj.is_error === true) {
    const detail = cliErrorDetail(
      Array.isArray(obj.errors) ? obj.errors : obj.error || obj.result,
      'Unknown CLI error'
    );
    return { ...detail, provider: 'claude' };
  }
  if (obj.subtype !== 'error') return null;
  return {
    ...cliErrorDetail(obj.error || obj.result, 'CLI returned error'),
    provider: 'claude',
  };
}

function codexFailureFromObject(obj) {
  if (obj.type !== 'turn.failed') return null;
  return {
    ...cliErrorDetail(obj.error?.message || obj.error?.code || obj.error, 'Turn failed'),
    provider: 'codex',
  };
}

function geminiFailureFromObject(obj) {
  const geminiFailure =
    (obj.type === 'result' && obj.status === 'error') ||
    (obj.type === 'error' && obj.severity === 'error');
  if (!geminiFailure) return null;
  return {
    ...cliErrorDetail(obj.error?.message || obj.message, 'Gemini CLI error'),
    provider: 'gemini',
  };
}

function opencodeFailureFromObject(obj) {
  if (obj.type !== 'session.error' && obj.type !== 'error') return null;
  return {
    ...cliErrorDetail(
      obj.error?.data?.message || obj.error?.message || obj.error?.name,
      'Session error'
    ),
    provider: 'opencode',
  };
}

function failureFromProviderObject(obj, providerName) {
  if (providerName === 'claude') return claudeFailureFromObject(obj);
  if (providerName === 'codex') return codexFailureFromObject(obj);
  if (providerName === 'gemini') return geminiFailureFromObject(obj);
  if (providerName === 'opencode') return opencodeFailureFromObject(obj);
  return null;
}

function extractCliFailure(output, providerName = 'claude') {
  if (!output || typeof output !== 'string') return null;

  const lines = output.split('\n');
  // Codex terminal truth is a turn.failed record at the newest end of JSONL output.
  // Search it newest-first so a preserved terminal tail wins over older provider chatter.
  if (providerName === 'codex') lines.reverse();

  for (const line of lines) {
    const content = stripTimestamp(line);
    if (!content.startsWith('{')) continue;
    try {
      const failure = failureFromProviderObject(JSON.parse(content), providerName);
      if (failure) return failure;
    } catch {
      // Ignore non-JSON output lines.
    }
  }

  return null;
}

function extractCliError(output, providerName = 'claude') {
  const failure = extractCliFailure(output, providerName);
  return failure ? { error: failure.error, provider: failure.provider } : null;
}

/**
 * Detects fatal standalone output lines that indicate no task output was produced.
 * Only matches when the line itself is the fatal message (not when it appears inside JSON).
 *
 * @param {string} output - Raw output text
 * @returns {boolean} True if a standalone fatal line is present
 */
function hasFatalStandaloneOutput(output) {
  if (!output || typeof output !== 'string') return false;
  const lines = output.split('\n');
  for (const line of lines) {
    const stripped = stripTimestamp(line).trim();
    if (!stripped) continue;
    if (/^(task not found|process terminated)\b/i.test(stripped)) {
      return true;
    }
  }
  return false;
}

/**
 * Main extraction function - tries all strategies in priority order
 *
 * @param {string} output - Raw output from AI provider CLI
 * @param {string} providerName - Provider name ('claude', 'codex', 'gemini')
 * @returns {object|null} Extracted JSON object or null if extraction failed
 */
function extractJsonFromOutput(output, providerName = 'claude') {
  if (!output || typeof output !== 'string') return null;

  const trimmedOutput = output.trim();
  if (!trimmedOutput) return null;

  // Strategy 1: Result wrapper (Claude format)
  const fromWrapper = extractFromResultWrapper(trimmedOutput);
  if (fromWrapper) return fromWrapper;

  // Strategy 2: Text events (non-Claude providers)
  const fromText = extractFromTextEvents(trimmedOutput, providerName);
  if (fromText) return fromText;

  // Strategy 3: Markdown extraction
  const fromMarkdown = extractFromMarkdown(trimmedOutput);
  if (fromMarkdown) return fromMarkdown;

  // Strategy 4: Direct JSON parse (raw output)
  const fromDirect = extractDirectJson(trimmedOutput);
  if (fromDirect) return fromDirect;

  if (hasFatalStandaloneOutput(trimmedOutput)) {
    return null;
  }

  return null;
}

module.exports = {
  MAX_CLI_ERROR_BYTES,
  extractJsonFromOutput,
  extractModelTextFromOutput,
  extractCliFailure,
  extractCliError,
  extractClaudeVertexModelError,
  extractFromResultWrapper,
  extractFromTextEvents,
  extractFromMarkdown,
  extractDirectJson,
  stripTimestamp,
  hasFatalStandaloneOutput,
};
