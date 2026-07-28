/**
 * Output Reformatter Tests
 *
 * Tests schema validation and the opencode CLI structured-output recovery path.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');
const sinon = require('sinon');
const {
  reformatOutput,
  buildReformatPrompt,
  validateAgainstSchema,
  DEFAULT_MAX_ATTEMPTS,
} = require('../src/agent/output-reformatter');
const { parseResultOutput } = require('../src/agent/agent-task-executor');

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = sinon.spy();
  return child;
}

function emitResult(child, { stdout = '', stderr = '', code = 0, signal = null } = {}) {
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.emit('close', code, signal);
  });
}

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

    it('recovers tool-call-only opencode output through the CLI', async function () {
      const child = createFakeChild();
      const spawnStub = sinon.stub(childProcess, 'spawn').callsFake(() => {
        emitResult(child, { stdout: opencodeTextEvent({ plan: 'Inspect the adapter' }) });
        return child;
      });

      const result = await reformatOutput({
        rawOutput: '{"type":"tool_use","name":"read","input":{"path":"src/adapter.js"}}',
        schema,
        providerName: 'opencode',
      });

      assert.deepStrictEqual(result, { plan: 'Inspect the adapter' });
      assert.strictEqual(spawnStub.callCount, 1);
      const [binary, args, options] = spawnStub.firstCall.args;
      assert.strictEqual(binary, 'opencode');
      assert.deepStrictEqual(args.slice(0, 3), ['run', '--format', 'json']);
      assert.match(args[3], /Do NOT use any tools/);
      assert.deepStrictEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    });

    it('recovers the structured-output parser after primary extraction finds no JSON', async function () {
      const child = createFakeChild();
      sinon.stub(childProcess, 'spawn').callsFake(() => {
        emitResult(child, { stdout: opencodeTextEvent({ plan: 'Recovered through fallback' }) });
        return child;
      });
      const agent = {
        id: 'planner',
        role: 'planner',
        running: true,
        state: 'executing_task',
        config: { jsonSchema: schema },
        _resolveProvider: () => 'opencode',
      };

      const result = await parseResultOutput(
        agent,
        'Tool call: read src/adapter.js (completed); no final response was emitted'
      );

      assert.deepStrictEqual(result, { plan: 'Recovered through fallback' });
    });

    it('retries schema-invalid output and returns the valid recovery', async function () {
      const outputs = [{ wrong: true }, { plan: 'Recovered' }];
      const spawnStub = sinon.stub(childProcess, 'spawn').callsFake(() => {
        const child = createFakeChild();
        emitResult(child, { stdout: opencodeTextEvent(outputs.shift()) });
        return child;
      });

      const result = await reformatOutput({
        rawOutput: 'No JSON plan was emitted',
        schema,
        providerName: 'opencode',
      });

      assert.deepStrictEqual(result, { plan: 'Recovered' });
      assert.strictEqual(spawnStub.callCount, 2);
      assert.match(spawnStub.secondCall.args[1][3], /PREVIOUS ATTEMPT FAILED/);
    });

    it('does not invoke opencode for another provider', async function () {
      const spawnStub = sinon.stub(childProcess, 'spawn');

      await assert.rejects(
        () =>
          reformatOutput({
            rawOutput: 'Some text',
            schema,
            providerName: 'claude',
          }),
        /not available for provider "claude"/
      );
      assert.strictEqual(spawnStub.callCount, 0);
    });

    it('kills an in-flight reformat and does not retry after cancellation', async function () {
      let cancelled = false;
      const child = createFakeChild();
      const spawnStub = sinon.stub(childProcess, 'spawn').callsFake(() => {
        setImmediate(() => {
          cancelled = true;
        });
        return child;
      });

      await assert.rejects(
        () =>
          reformatOutput({
            rawOutput: 'No JSON plan was emitted',
            schema,
            providerName: 'opencode',
            isCancelled: () => cancelled,
          }),
        /reformatting cancelled/
      );
      assert.strictEqual(spawnStub.callCount, 1);
      sinon.assert.calledOnceWithExactly(child.kill, 'SIGKILL');
    });

    it('reports opencode process failures after the configured attempts', async function () {
      const spawnStub = sinon.stub(childProcess, 'spawn').callsFake(() => {
        const child = createFakeChild();
        emitResult(child, { stderr: 'not authenticated', code: 1 });
        return child;
      });

      await assert.rejects(
        () =>
          reformatOutput({
            rawOutput: 'No JSON plan was emitted',
            schema,
            providerName: 'opencode',
            maxAttempts: 2,
          }),
        /not authenticated/
      );
      assert.strictEqual(spawnStub.callCount, 2);
    });
  });
});
