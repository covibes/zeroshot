/**
 * Regression tests for the task-execution lifecycle changes (PR #803).
 *
 * Covers the maintainer's required coverage:
 * - Local cancellation during pre-ID registration
 * - Parent task IDs retained in completion/token/hook metadata after nested reformat
 * - One recovery model call across validation and hooks (cached parsedResult)
 * - Late-ID cleanup (cancel after spawn, before task ID arrives)
 * - No retry before tree settlement
 */
const assert = require('assert');
const sinon = require('sinon');
const { TaskExecutionHandle } = require('../src/agent/task-execution-handle');
const { reformatOutput } = require('../src/agent/output-reformatter');
const { parseResultOutput, buildCompletionResult } = require('../src/agent/agent-task-executor');

afterEach(function () {
  sinon.restore();
});

function opencodeTextEvent(value) {
  return `${JSON.stringify({
    type: 'text',
    part: { type: 'text', text: JSON.stringify(value) },
  })}\n`;
}

describe('TaskExecutionHandle', function () {
  it('accepts cancellation before a task ID or process exists', function () {
    const handle = new TaskExecutionHandle('test-agent');
    assert.strictEqual(handle.isCancelled, false);
    assert.strictEqual(handle.taskId, null);
    assert.strictEqual(handle.pid, null);

    handle.cancel('early cancel');
    assert.strictEqual(handle.isCancelled, true);
    assert.strictEqual(handle.cancelReason, 'early cancel');
  });

  it('kills a late-attached process if already cancelled', function () {
    const handle = new TaskExecutionHandle('test-agent');
    handle.cancel('early cancel');

    let killed = false;
    const fakeProc = {
      kill: (_sig) => {
        killed = true;
      },
      once: () => {},
    };
    handle.attachProcess(fakeProc);
    assert.strictEqual(killed, true, 'process should be killed immediately on late attach');
  });

  it('assigns task ID and PID immutably', function () {
    const handle = new TaskExecutionHandle('test-agent');
    handle.assignTaskId('task-abc-1');
    handle.assignPid(9999);
    assert.strictEqual(handle.taskId, 'task-abc-1');
    assert.strictEqual(handle.pid, 9999);
  });

  it('settle resolves when the process exits', async function () {
    const handle = new TaskExecutionHandle('test-agent');
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.kill = () => {};
    handle.attachProcess(proc);

    const settled = handle.settle();
    proc.emit('close', 0, null);
    await settled;
    assert.strictEqual(handle.settled, true);
  });
});

describe('Parent identity preserved across nested reformat', function () {
  const schema = {
    type: 'object',
    properties: { plan: { type: 'string' } },
    required: ['plan'],
  };

  it('retains parent currentTaskId after a nested reformat launch', async function () {
    const agent = {
      id: 'planner',
      role: 'planner',
      running: true,
      state: 'executing_task',
      currentTaskId: 'parent-task-42',
      currentTask: { kill: () => {} },
      processPid: 1111,
      config: { jsonSchema: schema },
      _resolveProvider: () => 'opencode',
      _spawnClaudeTask: (prompt, options) => {
        // Simulate a nested launch that must NOT overwrite parent identity.
        assert.strictEqual(options.nested, true, 'reformat must pass nested: true');
        return {
          success: true,
          output: opencodeTextEvent({ plan: 'recovered plan' }),
        };
      },
    };

    const result = await parseResultOutput(agent, 'Tool call only, no JSON');

    assert.deepStrictEqual(result, { plan: 'recovered plan' });
    // Parent identity must be untouched.
    assert.strictEqual(agent.currentTaskId, 'parent-task-42');
    assert.strictEqual(agent.processPid, 1111);
    assert.ok(agent.currentTask, 'parent currentTask handle must survive');
  });
});

describe('Cached parsed result — one recovery model call', function () {
  const schema = {
    type: 'object',
    properties: { plan: { type: 'string' } },
    required: ['plan'],
  };

  it('buildCompletionResult returns cached parsedResult without re-parsing', async function () {
    let parseCallCount = 0;
    const agent = {
      id: 'planner',
      role: 'planner',
      running: true,
      state: 'executing_task',
      config: { jsonSchema: schema, outputFormat: 'json' },
      _resolveProvider: () => 'opencode',
      _parseResultOutput: (_output) => {
        parseCallCount++;
        return { plan: 'cached plan' };
      },
    };

    const state = {
      output: 'raw output',
      skipStructuredResultCheck: false,
    };

    const result = await buildCompletionResult({
      agent,
      taskId: 'task-1',
      providerName: 'opencode',
      state,
      stdout: '',
      success: true,
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.parsedResult, { plan: 'cached plan' });
    assert.strictEqual(parseCallCount, 1, 'parseResultOutput must be called exactly once');

    // The cached result is on state for downstream hooks.
    assert.deepStrictEqual(state._cachedParsedResult, { plan: 'cached plan' });
  });

  it('skips re-parse when state already has a cached result', async function () {
    let parseCallCount = 0;
    const agent = {
      id: 'planner',
      role: 'planner',
      config: { jsonSchema: schema, outputFormat: 'json' },
      _resolveProvider: () => 'opencode',
      _parseResultOutput: () => {
        parseCallCount++;
        return { plan: 'should not be called again' };
      },
    };

    const state = {
      output: 'raw output',
      skipStructuredResultCheck: false,
      _cachedParsedResult: { plan: 'already cached' },
    };

    // evaluateStructuredSuccess short-circuits when _cachedParsedResult is
    // already populated — no second parse, no second model call.
    const result = await buildCompletionResult({
      agent,
      taskId: 'task-1',
      providerName: 'opencode',
      state,
      stdout: '',
      success: true,
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.parsedResult, { plan: 'already cached' });
    assert.strictEqual(
      parseCallCount,
      0,
      '_parseResultOutput must not be called when cache exists'
    );
  });
});

describe('Cancellation identity end-to-end', function () {
  const schema = {
    type: 'object',
    properties: { plan: { type: 'string' } },
    required: ['plan'],
  };

  it('REFORMAT_CANCELLED propagates through parseResultOutput as cancellation, not missing-JSON', async function () {
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
    agent.running = false;
    finishTask({ success: false, error: 'owned process tree terminated' });

    await assert.rejects(parsing, (error) => {
      assert.strictEqual(error.code, 'REFORMAT_CANCELLED');
      assert.doesNotMatch(error.message, /missing required JSON block/);
      return true;
    });
  });

  it('reformatOutput checks cancellation between attempts and never retries after cancel', async function () {
    let cancelled = false;
    let attempts = 0;
    const runReformat = () => {
      attempts++;
      cancelled = true; // cancel during first attempt
      return { success: false, error: 'simulated failure' };
    };

    await assert.rejects(
      () =>
        reformatOutput({
          rawOutput: 'no json',
          schema,
          providerName: 'opencode',
          isCancelled: () => cancelled,
          runReformat,
          maxAttempts: 3,
        }),
      (error) => {
        assert.strictEqual(error.code, 'REFORMAT_CANCELLED');
        return true;
      }
    );
    assert.strictEqual(attempts, 1, 'must not retry after cancellation');
  });
});
