/**
 * Output Reformatter Tests
 *
 * Tests schema validation and the opencode CLI structured-output recovery path.
 */

const assert = require('assert');
const sinon = require('sinon');
const {
  reformatOutput,
  buildReformatPrompt,
  validateAgainstSchema,
  DEFAULT_MAX_ATTEMPTS,
} = require('../src/agent/output-reformatter');
const { parseResultOutput } = require('../src/agent/agent-task-executor');


function opencodeTextEvent(value) {
  return `${JSON.stringify({
    type: 'text',
    part: { type: 'text', text: JSON.stringify(value) },
  })}\n`;
}

afterEach(function () {
  sinon.restore();
});

describe('Output Reformatter', function () {
  describe('buildReformatPrompt', function () {
    it('should build prompt with schema and output', function () {
      const schema = { type: 'object', properties: { foo: { type: 'string' } } };
      const rawOutput = 'Here is the result: foo is bar';

      const prompt = buildReformatPrompt(rawOutput, schema);

      assert.ok(prompt.includes('Convert this text into a JSON object'));
      assert.ok(prompt.includes('"foo"'));
      assert.ok(prompt.includes('Here is the result'));
      assert.ok(prompt.includes('Start with { end with }'));
    });

    it('should include previous error when provided', function () {
      const schema = { type: 'object', properties: { x: { type: 'number' } } };
      const rawOutput = 'The value is 42';
      const previousError = 'Missing required field: x';

      const prompt = buildReformatPrompt(rawOutput, schema, previousError);

      assert.ok(prompt.includes('PREVIOUS ATTEMPT FAILED'));
      assert.ok(prompt.includes('Missing required field: x'));
      assert.ok(prompt.includes('Fix this issue'));
    });

    it('should truncate very long outputs', function () {
      const schema = { type: 'object' };
      const rawOutput = 'x'.repeat(10000);

      const prompt = buildReformatPrompt(rawOutput, schema);

      // Should truncate to last 4000 chars
      assert.ok(prompt.length < 10000);
      assert.ok(prompt.includes('xxxx')); // Contains truncated content
    });
  });

  describe('validateAgainstSchema', function () {
    it('should return null for valid object', function () {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };
      const parsed = { name: 'Alice', age: 30 };

      const error = validateAgainstSchema(parsed, schema);

      assert.strictEqual(error, null);
    });

    it('should return error for missing required field', function () {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      const parsed = { other: 'value' };

      const error = validateAgainstSchema(parsed, schema);

      assert.ok(error !== null);
      assert.ok(error.includes('name'));
    });

    it('should return error for wrong type', function () {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      };
      const parsed = { count: 'not a number' };

      const error = validateAgainstSchema(parsed, schema);

      assert.ok(error !== null);
      assert.ok(error.includes('number'));
    });

    it('should return error for invalid enum value', function () {
      const schema = {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      };
      const parsed = { status: 'UNKNOWN' };

      const error = validateAgainstSchema(parsed, schema);

      assert.ok(error !== null);
    });
  });

  describe('DEFAULT_MAX_ATTEMPTS', function () {
    it('should be 3', function () {
      assert.strictEqual(DEFAULT_MAX_ATTEMPTS, 3);
    });
  });

  describe('reformatOutput', function () {
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' } },
      required: ['plan'],
      additionalProperties: false,
    };

    it('recovers tool-call-only output through the active opencode task runtime', async function () {
      let capturedPrompt;
      const result = await reformatOutput({
        rawOutput: '{"type":"tool_use","name":"read","input":{"path":"src/adapter.js"}}',
        schema,
        providerName: 'opencode',
        runReformat: async (prompt) => {
          capturedPrompt = prompt;
          return {
            success: true,
            output: opencodeTextEvent({ plan: 'Inspect the adapter' }),
          };
        },
      });

      assert.deepStrictEqual(result, { plan: 'Inspect the adapter' });
      assert.match(capturedPrompt, /Do NOT use any tools/);
    });

    it('recovers the structured-output parser in the same agent execution context', async function () {
      const spawnCalls = [];
      const agent = {
        id: 'planner',
        role: 'planner',
        running: true,
        state: 'executing_task',
        config: { jsonSchema: schema },
        _resolveProvider: () => 'opencode',
        _spawnClaudeTask: async (prompt, options) => {
          spawnCalls.push({ prompt, options });
          return {
            success: true,
            output: opencodeTextEvent({ plan: 'Recovered through fallback' }),
          };
        },
      };

      const result = await parseResultOutput(
        agent,
        'Tool call: read src/adapter.js (completed); no final response was emitted'
      );

      assert.deepStrictEqual(result, { plan: 'Recovered through fallback' });
      assert.strictEqual(spawnCalls.length, 1);
      assert.deepStrictEqual(spawnCalls[0].options, { skipStructuredResultCheck: true, nested: true });
    });

    it('retries schema-invalid output and returns the valid recovery', async function () {
      const outputs = [{ wrong: true }, { plan: 'Recovered' }];
      const prompts = [];

      const result = await reformatOutput({
        rawOutput: 'No JSON plan was emitted',
        schema,
        providerName: 'opencode',
        runReformat: async (prompt) => {
          prompts.push(prompt);
          return { success: true, output: opencodeTextEvent(outputs.shift()) };
        },
      });

      assert.deepStrictEqual(result, { plan: 'Recovered' });
      assert.strictEqual(prompts.length, 2);
      assert.match(prompts[1], /PREVIOUS ATTEMPT FAILED/);
    });

    it('does not invoke an opencode runtime for another provider', async function () {
      const runReformat = sinon.spy();

      await assert.rejects(
        () =>
          reformatOutput({
            rawOutput: 'Some text',
            schema,
            providerName: 'claude',
            runReformat,
          }),
        /not available for provider "claude"/
      );
      assert.strictEqual(runReformat.callCount, 0);
    });

    it('waits for owned task-tree exit before cancellation settles and never retries', async function () {
      let cancelled = false;
      let finishTask;
      let settled = false;
      const runReformat = sinon.spy(
        () =>
          new Promise((resolve) => {
            finishTask = resolve;
          })
      );
      const recovery = reformatOutput({
        rawOutput: 'No JSON plan was emitted',
        schema,
        providerName: 'opencode',
        isCancelled: () => cancelled,
        runReformat,
      });
      recovery.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      await new Promise((resolve) => setImmediate(resolve));
      cancelled = true;
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false);
      assert.strictEqual(runReformat.callCount, 1);

      finishTask({ success: false, error: 'owned process tree terminated' });
      await assert.rejects(recovery, (error) => {
        assert.strictEqual(error.code, 'REFORMAT_CANCELLED');
        return true;
      });
      assert.strictEqual(runReformat.callCount, 1);
    });

    it('reports task-runtime failures after the configured attempts', async function () {
      const runReformat = sinon.stub().resolves({
        success: false,
        error: 'opencode task failed: not authenticated',
      });

      await assert.rejects(
        () =>
          reformatOutput({
            rawOutput: 'No JSON plan was emitted',
            schema,
            providerName: 'opencode',
            maxAttempts: 2,
            runReformat,
          }),
        /not authenticated/
      );
      assert.strictEqual(runReformat.callCount, 2);
    });

    it('propagates cancellation from parseResultOutput without a missing-JSON error', async function () {
      let cancelled = false;
      let finishTask;
      const agent = {
        id: 'planner',
        role: 'planner',
        running: true,
        state: 'executing_task',
        config: { jsonSchema: schema },
        _resolveProvider: () => 'opencode',
        _spawnClaudeTask: () =>
          new Promise((resolve) => {
            finishTask = resolve;
          }),
      };
      const parsing = parseResultOutput(agent, 'Tool call completed without final JSON');
      await new Promise((resolve) => setImmediate(resolve));
      cancelled = true;
      agent.running = false;
      finishTask({ success: false, error: 'owned process tree terminated' });

      await assert.rejects(parsing, (error) => {
        assert.strictEqual(error.code, 'REFORMAT_CANCELLED');
        assert.doesNotMatch(error.message, /missing required JSON block/);
        return true;
      });
    });
  });
});
