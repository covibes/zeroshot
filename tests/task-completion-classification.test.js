const assert = require('assert');

const { buildCompletionResult, parseResultOutput } = require('../src/agent/agent-task-executor');

function createAgent(options = {}) {
  return {
    id: options.id || 'validator-code',
    role: options.role || 'validator',
    processPid: null,
    config: {
      outputFormat: options.outputFormat ?? 'json',
      jsonSchema:
        options.jsonSchema === undefined
          ? {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
              },
              required: ['approved'],
            }
          : options.jsonSchema,
      cwd: options.cwd || process.cwd(),
    },
    worktree: null,
    isolation: null,
    _parseResultOutput:
      options.parseResultOutput ||
      (() => ({
        approved: true,
      })),
  };
}

function createState(output) {
  return {
    output,
    logFilePath: '/tmp/task.log',
  };
}

describe('buildCompletionResult', function () {
  it('keeps completed structured tasks successful when output parses', async function () {
    const agent = createAgent();

    const result = await buildCompletionResult({
      agent,
      taskId: 'task-1',
      providerName: 'claude',
      state: createState('{"type":"result","structured_output":{"approved":true}}'),
      stdout: 'Status: completed',
      success: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.error, null);
  });

  it('downgrades completed structured tasks to failure when output is unparsable', async function () {
    const agent = createAgent({
      parseResultOutput: () =>
        Promise.reject(new Error('Agent validator-code output missing required JSON block')),
    });

    const result = await buildCompletionResult({
      agent,
      taskId: 'task-2',
      providerName: 'claude',
      state: createState('partial output only'),
      stdout: 'Status: completed',
      success: true,
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /missing required JSON block/);
  });

  it('does not require structured parsing for text-output agents', async function () {
    let parseCalls = 0;
    const agent = createAgent({
      outputFormat: 'text',
      jsonSchema: null,
      parseResultOutput: () => {
        parseCalls += 1;
        return Promise.reject(new Error('should not be called'));
      },
    });

    const result = await buildCompletionResult({
      agent,
      taskId: 'task-3',
      providerName: 'claude',
      state: createState('plain text output'),
      stdout: 'Status: completed',
      success: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.error, null);
    assert.strictEqual(parseCalls, 0);
  });
  it('preserves permanent recovery metadata through local completion', async function () {
    const failure = Object.assign(new Error('Recovery adapter is unavailable'), {
      code: 'unsupported-capability',
      permanent: true,
      provider: 'codex',
      capability: 'structuredOutputRecovery',
    });
    const agent = createAgent({ parseResultOutput: () => Promise.reject(failure) });

    await assert.rejects(
      buildCompletionResult({
        agent,
        taskId: 'task-permanent',
        providerName: 'codex',
        state: createState('malformed'),
        stdout: 'Status: completed',
        success: true,
      }),
      (error) => error === failure
    );
  });

  it('passes recovery-disabled classification for stale output and fails invalid data closed', async function () {
    let parserOptions;
    const agent = createAgent({
      parseResultOutput(_output, options) {
        parserOptions = options;
        return Promise.reject(new Error('stale schema-invalid output'));
      },
    });

    const result = await buildCompletionResult({
      agent,
      taskId: 'task-stale',
      providerName: 'codex',
      state: createState('{"wrong":true}'),
      stdout: 'Status: stale',
      success: true,
    });

    assert.deepStrictEqual(parserOptions, { allowRecovery: false });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /stale schema-invalid output/);
  });
  it('propagates unannotated local authentication recovery failures without outer retry', async function () {
    const agent = createAgent({ role: 'planner' });
    agent.running = true;
    agent.state = 'executing_task';
    agent.config.jsonSchema = {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    };
    agent._resolveProvider = () => 'codex';
    agent._spawnClaudeTask = () => ({
      success: false,
      error: 'Authentication failed: invalid API key',
    });
    agent._parseResultOutput = (output, options) => parseResultOutput(agent, output, options);

    await assert.rejects(
      buildCompletionResult({
        agent,
        taskId: 'task-auth',
        providerName: 'codex',
        state: createState('model response without JSON'),
        stdout: 'Status: completed',
        success: true,
      }),
      (error) => {
        assert.match(error.message, /Authentication failed/);
        assert.strictEqual(error.recoveryAbort, true);
        assert.strictEqual(error.permanent, true);
        return true;
      }
    );
  });
});
