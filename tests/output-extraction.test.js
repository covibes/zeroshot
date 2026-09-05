/**
 * Output Extraction Unit Tests
 *
 * Tests the clean extraction pipeline for multi-provider JSON extraction.
 * Each strategy is tested in isolation, then integration tests verify
 * the full pipeline works correctly.
 */

const assert = require('assert');
const { createHash } = require('node:crypto');
const { ompSdkErrorFrame } = require('./helpers/omp-sdk-protocol');
const { piBasicSettledEvents, piUsage } = require('./helpers/pi-protocol');
const {
  extractJsonFromOutput,
  extractCliError,
  extractCliFailure,
  MAX_CLI_ERROR_BYTES,
  extractFromResultWrapper,
  extractFromTextEvents,
  extractFromMarkdown,
  extractDirectJson,
  stripTimestamp,
} = require('../src/agent/output-extraction');

describe('Output Extraction Module', function () {
  defineStripTimestampTests();
  defineResultWrapperExtractionTests();
  defineTextEventExtractionTests();
  defineMarkdownExtractionTests();
  defineDirectJsonExtractionTests();
  defineCliErrorExtractionTests();
  defineOmpSdkFailureExtractionTests();
  defineFullPipelineTests();
  defineRegressionTests();
});

function defineStripTimestampTests() {
  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================
  describe('stripTimestamp', function () {
    it('should strip epoch timestamp prefix', function () {
      const result = stripTimestamp('[1768207508291]{"type":"result"}');
      assert.strictEqual(result, '{"type":"result"}');
    });

    it('should handle lines without timestamp', function () {
      const result = stripTimestamp('{"type":"result"}');
      assert.strictEqual(result, '{"type":"result"}');
    });

    it('should handle empty input', function () {
      assert.strictEqual(stripTimestamp(''), '');
      assert.strictEqual(stripTimestamp(null), '');
      assert.strictEqual(stripTimestamp(undefined), '');
    });

    it('should strip CRLF line endings', function () {
      const result = stripTimestamp('[1768207508291]content\r');
      assert.strictEqual(result, 'content');
    });

    it('should trim whitespace', function () {
      const result = stripTimestamp('  [1768207508291]content  ');
      assert.strictEqual(result, 'content');
    });
  });
}

function defineResultWrapperExtractionTests() {
  // ============================================================================
  // STRATEGY 1: RESULT WRAPPER EXTRACTION
  // ============================================================================
  describe('extractFromResultWrapper', function () {
    it('should extract from result field (object)', function () {
      const output = '{"type":"result","result":{"foo":"bar"}}';
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should extract from structured_output field', function () {
      const output = '{"type":"result","structured_output":{"foo":"bar"}}';
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should prefer structured_output over result', function () {
      const output = '{"type":"result","structured_output":{"a":1},"result":{"b":2}}';
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { a: 1 });
    });

    it('should handle result as string containing JSON', function () {
      const output = '{"type":"result","result":"{\\"foo\\":\\"bar\\"}"}';
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should handle result as string containing markdown JSON', function () {
      const output = '{"type":"result","result":"```json\\n{\\"foo\\":\\"bar\\"}\\n```"}';
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should handle timestamp prefixed lines', function () {
      const output = '[1768207508291]{"type":"result","result":{"foo":"bar"}}';
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should find result line in NDJSON', function () {
      const output = `{"type":"system"}
{"type":"assistant"}
{"type":"result","result":{"foo":"bar"}}`;
      const result = extractFromResultWrapper(output);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should return null for type:result WITHOUT content', function () {
      // This is the critical case for non-Claude providers
      const output = '{"type":"result","success":true}';
      const result = extractFromResultWrapper(output);
      assert.strictEqual(result, null);
    });

    it('should return null for non-result types', function () {
      const output = '{"type":"assistant","content":"hello"}';
      const result = extractFromResultWrapper(output);
      assert.strictEqual(result, null);
    });

    it('should return null for empty input', function () {
      assert.strictEqual(extractFromResultWrapper(''), null);
      assert.strictEqual(extractFromResultWrapper('not json'), null);
    });
  });
}

function defineTextEventExtractionTests() {
  // ============================================================================
  // STRATEGY 2: TEXT EVENTS EXTRACTION
  // ============================================================================
  describe('extractFromTextEvents', function () {
    it('should extract from Claude text events', function () {
      // Claude stream_event format
      const output =
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"foo\\":\\"bar\\"}"}}}';
      const result = extractFromTextEvents(output, 'claude');
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should extract from Codex item.created events', function () {
      const output =
        '{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\\"foo\\":\\"bar\\"}"}]}}';
      const result = extractFromTextEvents(output, 'codex');
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should extract from Gemini message events', function () {
      const output = '{"type":"message","role":"assistant","content":"{\\"foo\\":\\"bar\\"}"}';
      const result = extractFromTextEvents(output, 'gemini');
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should concatenate multiple text events', function () {
      // Multiple text deltas that form a complete JSON
      const output = `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"foo\\":"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"\\"bar\\"}"}}}`;
      const result = extractFromTextEvents(output, 'claude');
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should return null when no text events', function () {
      const output = '{"type":"system","subtype":"init"}';
      const result = extractFromTextEvents(output, 'claude');
      assert.strictEqual(result, null);
    });

    it('should handle text containing markdown', function () {
      const output =
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"```json\\n{\\"foo\\":\\"bar\\"}\\n```"}}}';
      const result = extractFromTextEvents(output, 'claude');
      assert.deepStrictEqual(result, { foo: 'bar' });
    });
  });
}

function defineMarkdownExtractionTests() {
  // ============================================================================
  // STRATEGY 3: MARKDOWN EXTRACTION
  // ============================================================================
  describe('extractFromMarkdown', function () {
    it('should extract JSON from markdown code block', function () {
      const text = '```json\n{"foo":"bar"}\n```';
      const result = extractFromMarkdown(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should handle surrounding text', function () {
      const text = 'Here is the result:\n\n```json\n{"foo":"bar"}\n```\n\nDone.';
      const result = extractFromMarkdown(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should handle multi-line JSON in markdown', function () {
      const text = '```json\n{\n  "foo": "bar",\n  "baz": 123\n}\n```';
      const result = extractFromMarkdown(text);
      assert.deepStrictEqual(result, { foo: 'bar', baz: 123 });
    });

    it('should handle no whitespace after json tag', function () {
      const text = '```json{"foo":"bar"}```';
      const result = extractFromMarkdown(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should return null for non-markdown text', function () {
      const text = '{"foo":"bar"}';
      const result = extractFromMarkdown(text);
      assert.strictEqual(result, null);
    });

    it('should return null for invalid JSON in markdown', function () {
      const text = '```json\n{invalid json}\n```';
      const result = extractFromMarkdown(text);
      assert.strictEqual(result, null);
    });

    it('should return null for empty input', function () {
      assert.strictEqual(extractFromMarkdown(''), null);
      assert.strictEqual(extractFromMarkdown(null), null);
    });
  });
}

function defineDirectJsonExtractionTests() {
  // ============================================================================
  // STRATEGY 4: DIRECT JSON EXTRACTION
  // ============================================================================
  describe('extractDirectJson', function () {
    it('should parse single-line JSON', function () {
      const text = '{"foo":"bar"}';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should parse multi-line JSON', function () {
      const text = `{
  "foo": "bar",
  "baz": 123
}`;
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { foo: 'bar', baz: 123 });
    });

    it('should handle whitespace around JSON', function () {
      const text = '  \n  {"foo":"bar"}  \n  ';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should extract JSON embedded in conversational filler', function () {
      const text = 'Here is the JSON you requested:\n{"foo":"bar"}\nHope this helps!';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should extract JSON embedded in conversational filler containing additional braces', function () {
      const text = 'Note: {var_placeholder} was replaced. Result: {"foo":"bar"} and {extra_unrelated}.';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should extract JSON containing string with nested braces', function () {
      const text = 'Result: {"template":"Hello {name}, welcome {home}"} complete.';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { template: 'Hello {name}, welcome {home}' });
    });

    it('should return null for arrays', function () {
      const text = '[1, 2, 3]';
      const result = extractDirectJson(text);
      assert.strictEqual(result, null);
    });

    it('should return null for primitives', function () {
      assert.strictEqual(extractDirectJson('"string"'), null);
      assert.strictEqual(extractDirectJson('123'), null);
      assert.strictEqual(extractDirectJson('true'), null);
      assert.strictEqual(extractDirectJson('null'), null);
    });

    it('should return null for invalid JSON', function () {
      assert.strictEqual(extractDirectJson('{invalid}'), null);
      assert.strictEqual(extractDirectJson('not json'), null);
    });

    it('should return null for empty input', function () {
      assert.strictEqual(extractDirectJson(''), null);
      assert.strictEqual(extractDirectJson('   '), null);
      assert.strictEqual(extractDirectJson(null), null);
    });

    // CLI metadata rejection tests - prevent schema validation against wrong structure
    it('should reject type:result objects (CLI wrapper)', function () {
      const text = '{"type":"result","subtype":"success","duration_ms":1234}';
      const result = extractDirectJson(text);
      assert.strictEqual(result, null);
    });

    it('should reject CLI metadata with duration_ms and session_id', function () {
      const text =
        '{"duration_ms":5000,"session_id":"abc123","total_cost_usd":0.05,"usage":{"input_tokens":100}}';
      const result = extractDirectJson(text);
      assert.strictEqual(result, null);
    });

    it('should reject CLI metadata with multiple metadata fields', function () {
      const text =
        '{"type":"result","subtype":"error","is_error":true,"duration_ms":123,"num_turns":5,"total_cost_usd":0.1,"permission_denials":[],"errors":["some error"]}';
      const result = extractDirectJson(text);
      assert.strictEqual(result, null);
    });

    it('should accept normal agent output (not CLI metadata)', function () {
      const text = '{"summary":"Task completed","completionStatus":{"canValidate":true}}';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, {
        summary: 'Task completed',
        completionStatus: { canValidate: true },
      });
    });

    it('should accept agent output that has one CLI-like field by coincidence', function () {
      // If agent happens to output a field named "errors", that's fine (< 2 CLI fields)
      const text = '{"summary":"Fixed bugs","errors":[]}';
      const result = extractDirectJson(text);
      assert.deepStrictEqual(result, { summary: 'Fixed bugs', errors: [] });
    });

    it('should reject CLI metadata and not fall through to nested usage object', function () {
      const text = '{"duration_ms":100,"session_id":"test","usage":{"input_tokens":50}}';
      const result = extractDirectJson(text);
      assert.strictEqual(result, null);
    });

    it('should reject provider protocol event records', function () {
      const text = '{"type":"item.completed","index":0,"payload":"data"}';
      const result = extractDirectJson(text);
      assert.strictEqual(result, null);
    });
  });
}

function defineCliErrorExtractionTests() {
  // ============================================================================
  // CLI ERROR EXTRACTION (ALL PROVIDERS)
  // ============================================================================
  describe('extractCliError', function () {
    // Claude errors
    it('should extract Claude error with is_error:true', function () {
      const output = '{"type":"result","is_error":true,"errors":["Permission denied for tool X"]}';
      const result = extractCliError(output);
      assert.deepStrictEqual(result, {
        error: 'Permission denied for tool X',
        provider: 'claude',
      });
    });

    it('should extract Claude error with multiple errors', function () {
      const output = '{"type":"result","is_error":true,"errors":["Error 1","Error 2"]}';
      const result = extractCliError(output);
      assert.deepStrictEqual(result, {
        error: 'Error 1; Error 2',
        provider: 'claude',
      });
    });

    it('should extract Claude error with subtype:error', function () {
      const output = '{"type":"result","subtype":"error","error":"Token limit exceeded"}';
      const result = extractCliError(output);
      assert.deepStrictEqual(result, {
        error: 'Token limit exceeded',
        provider: 'claude',
      });
    });

    // Codex errors
    it('should extract Codex turn.failed error', function () {
      const output = '{"type":"turn.failed","error":{"message":"API rate limit exceeded"}}';
      const result = extractCliError(output, 'codex');
      assert.deepStrictEqual(result, {
        error: 'API rate limit exceeded',
        provider: 'codex',
      });
    });

    it('should extract Codex turn.failed with string error', function () {
      const output = '{"type":"turn.failed","error":"Something went wrong"}';
      const result = extractCliError(output, 'codex');
      assert.deepStrictEqual(result, {
        error: 'Something went wrong',
        provider: 'codex',
      });
    });

    it('uses the newest Codex terminal record and ignores benign source text', function () {
      const output = [
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            aggregated_output: 'const Authorization = benignSource;',
          },
        }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'older failure' } }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'terminal provider failure' } }),
      ].join('\n');

      assert.deepStrictEqual(extractCliError(output, 'codex'), {
        error: 'terminal provider failure',
        provider: 'codex',
      });
    });

    it('bounds Codex terminal messages by UTF-8 bytes and never returns object values', function () {
      const huge = '🌍'.repeat(MAX_CLI_ERROR_BYTES);
      const bounded = extractCliError(
        JSON.stringify({ type: 'turn.failed', error: { message: huge } }),
        'codex'
      );
      assert.ok(Buffer.byteLength(bounded.error) <= MAX_CLI_ERROR_BYTES);
      assert.match(bounded.error, /\[truncated\]$/);
      assert.deepStrictEqual(
        extractCliFailure(
          JSON.stringify({ type: 'turn.failed', error: { message: huge } }),
          'codex'
        ).diagnostic,
        {
          byteLength: Buffer.byteLength(huge),
          sha256: createHash('sha256').update(huge).digest('hex'),
        }
      );
      assert.deepStrictEqual(
        extractCliError(
          JSON.stringify({ type: 'turn.failed', error: { detail: { nested: true } } }),
          'codex'
        ),
        { error: 'Turn failed', provider: 'codex' }
      );
    });

    it('extracts Pi in-band failures only after agent settlement', function () {
      const output = [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            usage: piUsage(),
            stopReason: 'error',
            errorMessage: 'authentication required: run /login',
          },
        },
        {
          type: 'turn_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'authentication required: run /login',
          },
        },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_settled' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');

      assert.deepStrictEqual(extractCliError(output, 'pi'), {
        error: 'authentication required: run /login',
        provider: 'pi',
      });
    });

    it('uses the newest Pi message_end and ignores an earlier auto-retried failure', function () {
      const output = [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            usage: piUsage(),
            stopReason: 'error',
            errorMessage: 'temporary failure',
          },
        },
        { type: 'agent_end', messages: [], willRetry: true },
        { type: 'auto_retry_start', attempt: 1 },
        {
          type: 'message_end',
          message: { role: 'assistant', content: [], usage: piUsage(), stopReason: 'stop' },
        },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_settled' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');

      assert.strictEqual(extractCliError(output, 'pi'), null);
    });

    it('ignores normal Pi user and tool-result message_end records', function () {
      const output = piBasicSettledEvents({
        role: 'assistant',
        content: [],
        usage: piUsage(),
        stopReason: 'stop',
      })
        .map((event) => JSON.stringify(event))
        .join('\n');

      assert.strictEqual(extractCliError(output, 'pi'), null);
    });

    it('rejects a Pi stream that ends before settlement', function () {
      const output = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [], usage: piUsage(), stopReason: 'stop' },
      });

      assert.deepStrictEqual(extractCliError(output, 'pi'), {
        error: 'Pi JSON stream ended before agent_settled.',
        provider: 'pi',
      });
    });

    // Gemini errors
    it('should extract Gemini result errors with nested messages', function () {
      const output =
        '{"type":"result","status":"error","error":{"type":"FatalError","message":"Model unavailable"}}';
      const result = extractCliError(output, 'gemini');
      assert.deepStrictEqual(result, {
        error: 'Model unavailable',
        provider: 'gemini',
      });
    });

    it('should extract terminal Gemini error events but ignore warnings', function () {
      assert.deepStrictEqual(
        extractCliError(
          '{"type":"error","severity":"error","message":"Authentication required"}',
          'gemini'
        ),
        { error: 'Authentication required', provider: 'gemini' }
      );
      assert.strictEqual(
        extractCliError('{"type":"error","severity":"warning","message":"Slow"}', 'gemini'),
        null
      );
    });

    // Opencode errors
    it('should extract Opencode session.error', function () {
      const output = '{"type":"session.error","error":{"message":"Connection timeout"}}';
      const result = extractCliError(output, 'opencode');
      assert.deepStrictEqual(result, {
        error: 'Connection timeout',
        provider: 'opencode',
      });
    });

    it('should extract Opencode session.error with nested data', function () {
      const output =
        '{"type":"session.error","error":{"data":{"message":"Auth failed"},"name":"AuthError"}}';
      const result = extractCliError(output, 'opencode');
      assert.deepStrictEqual(result, {
        error: 'Auth failed',
        provider: 'opencode',
      });
    });

    it('does not classify another provider terminal event', function () {
      const output = '{"type":"turn.failed","error":{"message":"Codex failed"}}';
      assert.strictEqual(extractCliError(output, 'gemini'), null);
    });

    // No error cases
    it('should return null for successful Claude output', function () {
      const output = '{"type":"result","subtype":"success","result":{"foo":"bar"}}';
      const result = extractCliError(output);
      assert.strictEqual(result, null);
    });

    it('should return null for successful Codex output', function () {
      const output = '{"type":"turn.completed","usage":{"input_tokens":100}}';
      const result = extractCliError(output, 'codex');
      assert.strictEqual(result, null);
    });

    it('should return null for successful Gemini output', function () {
      const output = '{"type":"result","status":"success"}';
      const result = extractCliError(output, 'gemini');
      assert.strictEqual(result, null);
    });

    it('should return null for empty output', function () {
      assert.strictEqual(extractCliError(''), null);
      assert.strictEqual(extractCliError(null), null);
    });

    it('should return null for non-error JSON', function () {
      const output = '{"foo":"bar","baz":123}';
      const result = extractCliError(output);
      assert.strictEqual(result, null);
    });

    it('should find error in multi-line NDJSON output', function () {
      const output = `{"type":"system","subtype":"init"}
{"type":"assistant","message":{}}
{"type":"result","is_error":true,"errors":["Task failed"]}`;
      const result = extractCliError(output);
      assert.deepStrictEqual(result, {
        error: 'Task failed',
        provider: 'claude',
      });
    });
  });
}

function defineOmpSdkFailureExtractionTests() {
  describe('OMP SDK failure extraction', function () {
    it('extracts closed failures without exposing provider diagnostics', function () {
      const frame = ompSdkErrorFrame();

      assert.deepStrictEqual(extractCliFailure(JSON.stringify(frame), 'omp'), {
        error: 'OMP SDK provider-auth (auth)',
        diagnostic: {
          byteLength: Buffer.byteLength('OMP SDK provider-auth (auth)'),
          sha256: createHash('sha256').update('OMP SDK provider-auth (auth)').digest('hex'),
        },
        provider: 'omp',
        providerCategory: 'authentication',
        providerClassification: { retryable: false, kind: 'permanent-pattern' },
      });
      assert.strictEqual(
        extractCliFailure(JSON.stringify({ ...frame, unexpected: 'untrusted' }), 'omp'),
        null
      );
    });
  });
}

function defineFullPipelineTests() {
  // ============================================================================
  // FULL PIPELINE INTEGRATION
  // ============================================================================
  describe('extractJsonFromOutput (full pipeline)', function () {
    defineClaudePipelineTests();
    defineCodexPipelineTests();
    defineGeminiPipelineTests();
    defineEdgeCasePipelineTests();
    defineStrategyPriorityTests();
  });
}

function defineClaudePipelineTests() {
  describe('Claude Provider', function () {
    it('should extract from result wrapper', function () {
      const output = '{"type":"result","result":{"complexity":"SIMPLE","taskType":"INQUIRY"}}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });

    it('should extract from NDJSON with result line', function () {
      const output = `[1768207505878]{"type":"system","subtype":"init"}
[1768207506000]{"type":"assistant","message":{"content":[]}}
[1768207508291]{"type":"result","result":{"complexity":"STANDARD","taskType":"TASK"}}`;
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'STANDARD');
    });

    it('should extract from text events when no result wrapper', function () {
      const output =
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"complexity\\":\\"TRIVIAL\\"}"}}}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'TRIVIAL');
    });
  });
}

function defineCodexPipelineTests() {
  describe('Codex Provider', function () {
    it('should extract from text events (not turn.completed)', function () {
      const output = `{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\\"complexity\\":\\"SIMPLE\\",\\"taskType\\":\\"INQUIRY\\"}"}]}}
{"type":"turn.completed","usage":{"input_tokens":100}}`;
      const result = extractJsonFromOutput(output, 'codex');
      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });

    it('should extract raw JSON output', function () {
      const output = '{"complexity":"STANDARD","taskType":"TASK"}';
      const result = extractJsonFromOutput(output, 'codex');
      assert.strictEqual(result.complexity, 'STANDARD');
    });

    it('should extract multi-line JSON', function () {
      const output = `{
  "complexity": "CRITICAL",
  "taskType": "DEBUG"
}`;
      const result = extractJsonFromOutput(output, 'codex');
      assert.strictEqual(result.complexity, 'CRITICAL');
      assert.strictEqual(result.taskType, 'DEBUG');
    });
  });
}

function defineGeminiPipelineTests() {
  describe('Gemini Provider', function () {
    it('should extract from message events', function () {
      const output = `{"type":"message","role":"assistant","content":"{\\"complexity\\":\\"SIMPLE\\"}"}
{"type":"result","success":true}`;
      const result = extractJsonFromOutput(output, 'gemini');
      assert.strictEqual(result.complexity, 'SIMPLE');
    });

    it('should extract raw JSON output', function () {
      const output = '{"complexity":"STANDARD","taskType":"TASK"}';
      const result = extractJsonFromOutput(output, 'gemini');
      assert.strictEqual(result.complexity, 'STANDARD');
    });
  });
}

function defineEdgeCasePipelineTests() {
  describe('Edge Cases', function () {
    it('should return null for empty output', function () {
      assert.strictEqual(extractJsonFromOutput('', 'claude'), null);
      assert.strictEqual(extractJsonFromOutput(null, 'claude'), null);
    });

    it('should return null for Task not found', function () {
      assert.strictEqual(extractJsonFromOutput('Task not found', 'claude'), null);
    });

    it('should return null for Process terminated', function () {
      assert.strictEqual(extractJsonFromOutput('Process terminated by signal', 'claude'), null);
    });

    it('should return null for plain text', function () {
      assert.strictEqual(extractJsonFromOutput('Just some text', 'claude'), null);
    });

    it('should handle markdown in any provider', function () {
      const output = 'Here is the result:\n\n```json\n{"foo":"bar"}\n```\n\nDone.';
      assert.deepStrictEqual(extractJsonFromOutput(output, 'claude'), { foo: 'bar' });
      assert.deepStrictEqual(extractJsonFromOutput(output, 'codex'), { foo: 'bar' });
      assert.deepStrictEqual(extractJsonFromOutput(output, 'gemini'), { foo: 'bar' });
    });
  });
}

function defineStrategyPriorityTests() {
  describe('Strategy Priority', function () {
    it('should prefer result wrapper over text events', function () {
      // Both result wrapper and text events present - wrapper should win
      const output = `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"source\\":\\"text\\"}"}}}
{"type":"result","result":{"source":"wrapper"}}`;
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.source, 'wrapper');
    });

    it('should prefer text events over markdown', function () {
      // Text events should be extracted before trying markdown
      const output =
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"source\\":\\"text\\"}"}}}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.source, 'text');
    });
  });
}

function defineRegressionTests() {
  // ============================================================================
  // REGRESSION TESTS
  // ============================================================================
  describe('Regression Tests', function () {
    it('REGRESSION: Codex turn.completed without result field', function () {
      // The original bug: turn.completed has type:result but no result field
      const output = `{"type":"thread.started"}
{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\\"complexity\\":\\"SIMPLE\\",\\"taskType\\":\\"INQUIRY\\",\\"reasoning\\":\\"Quick question\\"}"}]}}
{"type":"turn.completed","usage":{"input_tokens":3194,"output_tokens":50}}`;
      const result = extractJsonFromOutput(output, 'codex');
      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
      assert.ok(result.reasoning);
    });

    it('REGRESSION: Gemini result event without result field', function () {
      const output = `{"type":"message","role":"assistant","content":"{\\"complexity\\":\\"CRITICAL\\",\\"taskType\\":\\"DEBUG\\"}"}
{"type":"result","success":true}`;
      const result = extractJsonFromOutput(output, 'gemini');
      assert.strictEqual(result.complexity, 'CRITICAL');
      assert.strictEqual(result.taskType, 'DEBUG');
    });

    it('REGRESSION: Multi-line pretty-printed JSON', function () {
      const output = `{
  "complexity": "STANDARD",
  "taskType": "TASK",
  "reasoning": "Multi-file implementation"
}`;
      const result = extractJsonFromOutput(output, 'codex');
      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('REGRESSION: Markdown code block extraction', function () {
      const output = `Here is my analysis:

\`\`\`json
{"complexity":"SIMPLE","taskType":"TASK","reasoning":"Add new feature"}
\`\`\`

Done.`;
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('REGRESSION: Result string containing markdown', function () {
      const output =
        '{"type":"result","result":"```json\\n{\\"complexity\\":\\"TRIVIAL\\"}\\n```"}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'TRIVIAL');
    });

    it('REGRESSION #52: Claude assistant message with text blocks (Haiku)', function () {
      // Issue #52: Haiku returns JSON in type:assistant message with type:text content blocks
      // The output parser was ignoring these blocks, only handling tool_use and thinking
      const output = `{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"complexity\\":\\"SIMPLE\\",\\"taskType\\":\\"INQUIRY\\",\\"reasoning\\":\\"Quick question\\"}"}]}}
{"type":"result","success":true}`;
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
      assert.ok(result.reasoning);
    });

    it('REGRESSION #52: Claude assistant message with multiple text blocks', function () {
      // Haiku may split output across multiple text blocks
      const output =
        '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"complexity\\":"},{"type":"text","text":"\\"STANDARD\\",\\"taskType\\":\\"DEBUG\\",\\"reasoning\\":\\"Fix bug\\"}"}]}}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.taskType, 'DEBUG');
    });

    it('REGRESSION #52: Claude assistant message text blocks alongside tool_use', function () {
      // Real-world scenario: text blocks mixed with tool_use
      const output =
        '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"complexity\\":\\"TRIVIAL\\",\\"taskType\\":\\"TASK\\",\\"reasoning\\":\\"Simple change\\"}"},{"type":"tool_use","id":"tool1","name":"Read","input":{}}]}}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result.complexity, 'TRIVIAL');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('REGRESSION: Claude CLI error result without actual output', function () {
      // When Claude has an error, it returns CLI metadata without result field.
      // This MUST return null (not the CLI metadata object), so schema validation
      // doesn't run against wrong structure ({duration_ms, session_id} vs {summary, completionStatus})
      const output =
        '{"type":"result","subtype":"error","is_error":true,"duration_ms":1234,"duration_api_ms":1200,"num_turns":0,"session_id":"abc123","total_cost_usd":0.0,"usage":{},"modelUsage":null,"permission_denials":[],"uuid":"xyz","errors":["Permission denied"]}';
      const result = extractJsonFromOutput(output, 'claude');
      assert.strictEqual(result, null);
    });
  });
}
