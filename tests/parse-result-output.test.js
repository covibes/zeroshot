/**
 * parseResultOutput Tests - Multi-Provider Output Parsing
 *
 * CRITICAL: This test file covers the output parsing logic that extracts
 * structured JSON from different AI provider CLI outputs.
 *
 * Provider output formats:
 * - Claude (Claude CLI): Wraps result in {"type":"result","result":{...}}
 * - Codex (Codex CLI): Raw text/JSON output, separate turn.completed event
 * - Gemini (Gemini CLI): Raw text/JSON output, separate result event
 *
 * Bug fixed: Non-Claude providers emit type:result for completion status
 * WITHOUT the actual result content. The JSON must be extracted from
 * accumulated text events instead.
 */

const assert = require('assert');

// Import the function under test and dependencies
const { parseResultOutput } = require('../src/agent/agent-task-executor');

// Helper to create a minimal agent mock for testing
function createMockAgent(options = {}) {
  const providerName = options.provider || 'claude';
  return {
    id: options.id || 'test-agent',
    role: options.role || 'conductor',
    config: {
      outputFormat: options.outputFormat || 'json',
      jsonSchema: options.jsonSchema || {
        type: 'object',
        properties: {
          complexity: { type: 'string' },
          taskType: { type: 'string' },
          reasoning: { type: 'string' },
        },
        required: ['complexity', 'taskType', 'reasoning'],
      },
    },
    _resolveProvider: () => providerName,
    _publish: () => {},
  };
}

describe('parseResultOutput', function () {
  defineClaudeProviderTests();
  defineCodexProviderTests();
  defineGeminiProviderTests();
  defineEdgeCaseTests();
  defineSchemaValidationTests();
  defineStructuredOutputFailureTests();
  defineRegressionTests();
});

function defineClaudeProviderTests() {
  // ============================================================================
  // CLAUDE (Claude CLI) OUTPUT FORMAT TESTS
  // ============================================================================
  describe('Claude Provider', function () {
    const agent = createMockAgent({ provider: 'claude' });

    it('should parse result wrapped in type:result with result field', async function () {
      const output =
        '{"type":"result","subtype":"success","result":{"complexity":"SIMPLE","taskType":"INQUIRY","reasoning":"Single question"},"is_error":false}';

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
      assert.strictEqual(result.reasoning, 'Single question');
    });

    it('should parse result with timestamp prefix', async function () {
      const output =
        '[1768207508291]{"type":"result","subtype":"success","result":{"complexity":"STANDARD","taskType":"TASK","reasoning":"Multi-file change"},"is_error":false}';

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('should parse NDJSON output with multiple lines', async function () {
      const output = `[1768207505878]{"type":"system","subtype":"init"}
[1768207506000]{"type":"assistant","message":{"content":[{"type":"text","text":"Processing..."}]}}
[1768207508291]{"type":"result","subtype":"success","result":{"complexity":"TRIVIAL","taskType":"INQUIRY","reasoning":"Simple lookup"},"is_error":false}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'TRIVIAL');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });

    it('should parse structured_output field', async function () {
      const output =
        '{"type":"result","structured_output":{"complexity":"CRITICAL","taskType":"DEBUG","reasoning":"Security issue"}}';

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'CRITICAL');
      assert.strictEqual(result.taskType, 'DEBUG');
    });

    it('should extract JSON from markdown code block', async function () {
      const output = `Here is my analysis:

\`\`\`json
{"complexity":"SIMPLE","taskType":"TASK","reasoning":"Add new feature"}
\`\`\`

Done.`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'TASK');
    });
  });
}

function defineCodexProviderTests() {
  // ============================================================================
  // CODEX (Codex CLI) OUTPUT FORMAT TESTS
  // ============================================================================
  describe('Codex Provider', function () {
    const agent = createMockAgent({ provider: 'codex' });

    it('should parse raw JSON text output (not wrapped)', async function () {
      // Codex outputs raw JSON when model returns structured data
      const output =
        '{"complexity":"SIMPLE","taskType":"INQUIRY","reasoning":"Single arithmetic question"}';

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });

    it('should NOT use turn.completed result event (has no result field)', async function () {
      // CRITICAL REGRESSION TEST: turn.completed has type:result but NO result field
      // The actual JSON is in earlier text, NOT in the result event
      const output = `{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\\"complexity\\":\\"SIMPLE\\",\\"taskType\\":\\"INQUIRY\\",\\"reasoning\\":\\"Quick question\\"}"}]}}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });

    it('should parse multi-line raw JSON output', async function () {
      // Codex may output JSON spread across multiple lines
      const output = `{
  "complexity": "STANDARD",
  "taskType": "TASK",
  "reasoning": "Multi-file implementation"
}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('should handle NDJSON with text events followed by empty result', async function () {
      // Real-world Codex output: text events + turn.completed (no result)
      const output = `{"type":"thread.started"}
{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\\"complexity\\":\\"TRIVIAL\\",\\"taskType\\":\\"INQUIRY\\",\\"reasoning\\":\\"Simple query\\"}"}]}}
{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":30}}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'TRIVIAL');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });
  });
}

function defineGeminiProviderTests() {
  // ============================================================================
  // GEMINI (Gemini CLI) OUTPUT FORMAT TESTS
  // ============================================================================
  describe('Gemini Provider', function () {
    const agent = createMockAgent({ provider: 'gemini' });

    it('should parse raw JSON text output', async function () {
      const output = '{"complexity":"SIMPLE","taskType":"DEBUG","reasoning":"Fix typo"}';

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'DEBUG');
    });

    it('should parse message event with text content', async function () {
      const output = `{"type":"init"}
{"type":"message","role":"assistant","content":"{\\"complexity\\":\\"STANDARD\\",\\"taskType\\":\\"TASK\\",\\"reasoning\\":\\"New feature\\"}"}
{"type":"result","success":true}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('should NOT use result event without result field', async function () {
      // CRITICAL REGRESSION TEST: Gemini result event may have success but no result
      const output = `{"type":"message","role":"assistant","content":"{\\"complexity\\":\\"CRITICAL\\",\\"taskType\\":\\"DEBUG\\",\\"reasoning\\":\\"Security fix\\"}"}
{"type":"result","success":true}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'CRITICAL');
      assert.strictEqual(result.taskType, 'DEBUG');
    });
  });
}

function defineEdgeCaseTests() {
  // ============================================================================
  // EDGE CASES AND ERROR HANDLING
  // ============================================================================
  describe('Edge Cases', function () {
    const agent = createMockAgent({ provider: 'claude' });

    it('should throw on empty output', async function () {
      await assert.rejects(() => parseResultOutput(agent, ''), /Task execution failed/);
    });

    it('should throw on "Task not found" output', async function () {
      await assert.rejects(
        () => parseResultOutput(agent, 'Task not found'),
        /Task execution failed/
      );
    });

    it('should throw on "Process terminated" output', async function () {
      await assert.rejects(
        () => parseResultOutput(agent, 'Process terminated by signal'),
        /Task execution failed/
      );
    });

    it('should throw when no JSON can be extracted', async function () {
      await assert.rejects(
        () => parseResultOutput(agent, 'Just some plain text with no JSON'),
        /output missing required JSON block/
      );
    });

    it('should handle JSON with extra whitespace', async function () {
      const output = `

  {"complexity":"SIMPLE","taskType":"INQUIRY","reasoning":"Test"}

`;
      const result = await parseResultOutput(agent, output);
      assert.strictEqual(result.complexity, 'SIMPLE');
    });

    it('should handle CRLF line endings', async function () {
      const output =
        '{"type":"result","result":{"complexity":"SIMPLE","taskType":"TASK","reasoning":"Windows"}}\r\n';
      const result = await parseResultOutput(agent, output);
      assert.strictEqual(result.complexity, 'SIMPLE');
    });

    it('should prefer result line with content over one without', async function () {
      // Two result lines: one with content, one without
      const output = `{"type":"result","success":true}
{"type":"result","subtype":"success","result":{"complexity":"STANDARD","taskType":"DEBUG","reasoning":"Real result"}}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.reasoning, 'Real result');
    });
  });
}

function defineSchemaValidationTests() {
  // ============================================================================
  // SCHEMA VALIDATION
  // ============================================================================
  describe('Schema Validation', function () {
    it('should validate against jsonSchema when configured', async function () {
      const agent = createMockAgent({
        provider: 'claude',
        jsonSchema: {
          type: 'object',
          properties: {
            complexity: { type: 'string', enum: ['TRIVIAL', 'SIMPLE', 'STANDARD', 'CRITICAL'] },
            taskType: { type: 'string', enum: ['INQUIRY', 'TASK', 'DEBUG'] },
            reasoning: { type: 'string' },
          },
          required: ['complexity', 'taskType', 'reasoning'],
        },
      });

      const output = '{"complexity":"SIMPLE","taskType":"INQUIRY","reasoning":"Valid"}';
      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'SIMPLE');
    });

    it('should throw for validator role with invalid schema', async function () {
      const agent = createMockAgent({
        provider: 'claude',
        role: 'validator',
        jsonSchema: {
          type: 'object',
          properties: {
            score: { type: 'number', minimum: 0, maximum: 100 },
          },
          required: ['score'],
        },
      });

      // Missing required 'score' field
      const output = '{"wrongField":"value"}';

      await assert.rejects(() => parseResultOutput(agent, output), /failed JSON schema validation/);
    });

    it('should warn but not throw for non-validator roles without recovery support', async function () {
      const warnings = [];
      const agent = {
        ...createMockAgent({
          provider: 'gateway',
          role: 'conductor',
        }),
        _publish: (msg) => {
          if (msg.topic === 'AGENT_SCHEMA_WARNING') {
            warnings.push(msg);
          }
        },
      };

      // Output with wrong type for 'complexity' (number instead of string)
      // But since the schema has string type and we're passing a valid string,
      // let's test with missing required field instead
      const output = '{"complexity":"SIMPLE"}'; // Missing taskType and reasoning

      // Should NOT throw, but should publish warning
      const result = await parseResultOutput(agent, output);
      assert.strictEqual(result.complexity, 'SIMPLE');
    });
  });
}

function defineStructuredOutputFailureTests() {
  describe('Structured output failures', function () {
    it('tags missing JSON after recovery exhaustion', async function () {
      let recoveryAttempts = 0;
      const agent = {
        ...createMockAgent({ provider: 'codex', role: 'planner' }),
        _spawnClaudeTask() {
          recoveryAttempts += 1;
          return Promise.resolve({ success: true, output: 'still not JSON' });
        },
      };

      await assert.rejects(
        () => parseResultOutput(agent, 'completed without JSON'),
        (error) => {
          assert.strictEqual(error.code, 'STRUCTURED_OUTPUT_INVALID');
          assert.strictEqual(error.details.kind, 'missing_json');
          assert.strictEqual(error.details.recoveryAttempts, 3);
          return true;
        }
      );
      assert.strictEqual(recoveryAttempts, 3);
    });

    it('tags schema-invalid recovery exhaustion for planner output', async function () {
      let recoveryAttempts = 0;
      const agent = {
        ...createMockAgent({
          provider: 'codex',
          role: 'planner',
          jsonSchema: {
            type: 'object',
            properties: { score: { type: 'number' } },
            required: ['score'],
          },
        }),
        _spawnClaudeTask() {
          recoveryAttempts += 1;
          return Promise.resolve({ success: true, output: '{"score":"invalid"}' });
        },
      };

      await assert.rejects(
        () => parseResultOutput(agent, '{"score":"invalid"}'),
        (error) => {
          assert.strictEqual(error.code, 'STRUCTURED_OUTPUT_INVALID');
          assert.strictEqual(error.details.kind, 'schema_validation');
          assert.strictEqual(error.details.recoveryAttempts, 3);
          assert.match(error.details.validationError, /number/);
          return true;
        }
      );
      assert.strictEqual(recoveryAttempts, 3);
    });
  });
}

function defineRegressionTests() {
  // ============================================================================
  // REGRESSION TESTS
  // ============================================================================
  describe('Regression Tests', function () {
    it('REGRESSION: Codex turn.completed should not hijack result parsing', async function () {
      // This was the original bug: turn.completed creates type:result
      // but without result field, causing parseResultOutput to use it
      // instead of the actual text content
      const agent = createMockAgent({ provider: 'codex' });

      // Simulate real Codex output where JSON is in text, turn.completed has no result
      const output = `[1768207505878]{"type":"thread.started"}
[1768207506000]{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"{\\"complexity\\":\\"SIMPLE\\",\\"taskType\\":\\"INQUIRY\\",\\"reasoning\\":\\"What is 1+1\\"}"}]}}
[1768207508291]{"type":"turn.completed","usage":{"input_tokens":3194,"output_tokens":50}}`;

      const result = await parseResultOutput(agent, output);

      // Should get the actual classification, NOT fail due to empty result
      assert.strictEqual(result.complexity, 'SIMPLE');
      assert.strictEqual(result.taskType, 'INQUIRY');
      assert.ok(result.reasoning.includes('1+1'));
    });

    it('REGRESSION: Gemini result event without result field', async function () {
      const agent = createMockAgent({ provider: 'gemini' });

      const output = `{"type":"init"}
{"type":"message","role":"assistant","content":"{\\"complexity\\":\\"STANDARD\\",\\"taskType\\":\\"TASK\\",\\"reasoning\\":\\"Implement feature\\"}"}
{"type":"result","success":true}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'STANDARD');
      assert.strictEqual(result.taskType, 'TASK');
    });

    it('REGRESSION: Should handle result as string containing markdown JSON', async function () {
      // Claude CLI sometimes returns result as string with markdown
      const agent = createMockAgent({ provider: 'claude' });

      const output =
        '{"type":"result","subtype":"success","result":"```json\\n{\\"complexity\\":\\"TRIVIAL\\",\\"taskType\\":\\"INQUIRY\\",\\"reasoning\\":\\"Quick lookup\\"}\\n```"}';

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'TRIVIAL');
      assert.strictEqual(result.taskType, 'INQUIRY');
    });

    it('REGRESSION: Multi-line JSON should be reassembled', async function () {
      const agent = createMockAgent({ provider: 'codex' });

      // JSON spread across multiple lines (pretty-printed by model)
      const output = `{
  "complexity": "CRITICAL",
  "taskType": "DEBUG",
  "reasoning": "Security vulnerability in auth"
}`;

      const result = await parseResultOutput(agent, output);

      assert.strictEqual(result.complexity, 'CRITICAL');
      assert.strictEqual(result.taskType, 'DEBUG');
    });
  });
}
