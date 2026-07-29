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
const {
  NestedExecutionRegistry,
  TaskExecutionHandle,
} = require('../src/agent/task-execution-handle');
const { reformatOutput } = require('../src/agent/output-reformatter');
const { executeHook } = require('../src/agent/agent-hook-executor');
const {
  buildCompletionResult,
  killTask,
  parseResultOutput,
} = require('../src/agent/agent-task-executor');
const { stop } = require('../src/agent/agent-lifecycle');

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

  it('settle resolves only after the complete nested execution settles', async function () {
    const handle = new TaskExecutionHandle('test-agent');
    let resolved = false;
    const settled = handle.settle().then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(resolved, false);

    handle.markSettled();
    await settled;
    assert.strictEqual(handle.settled, true);
  });
});

describe('NestedExecutionRegistry', function () {
  it('cancels a pre-launch handle and waits for its settlement', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let cancellationObserved = false;

    handle.setCancelAction(async () => {
      cancellationObserved = true;
      await new Promise((resolve) => setImmediate(resolve));
      handle.markSettled();
      return { forced: true };
    });

    await registry.cancelAll('cluster shutdown');

    assert.strictEqual(cancellationObserved, true);
    assert.strictEqual(handle.isCancelled, true);
    assert.strictEqual(handle.settled, true);
    assert.strictEqual(registry.size, 0);
  });

  it('does not settle cancellation until durable task cleanup finishes', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let releaseCleanup;
    let cleanupFinished = false;

    handle.assignTaskId('task-nested-race1');
    handle.setCancelAction(
      () =>
        new Promise((resolve) => {
          releaseCleanup = () => {
            cleanupFinished = true;
            handle.markSettled();
            resolve({ forced: true, taskId: handle.taskId });
          };
        })
    );

    const cancellation = registry.cancelAll('retry boundary');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(cleanupFinished, false);
    assert.strictEqual(registry.size, 1, 'retry must still observe the active child');

    releaseCleanup();
    await cancellation;
    assert.strictEqual(cleanupFinished, true);
    assert.strictEqual(registry.size, 0);
  });

  it('blocks new children while an inactivity cancellation snapshot settles', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let releaseCancellation;
    handle.setCancelAction(
      () =>
        new Promise((resolve) => {
          releaseCancellation = () => {
            handle.markSettled();
            resolve({ forced: true });
          };
        })
    );

    const cancellation = registry.cancelAll('Provider produced no output', {
      code: 'PROVIDER_INACTIVITY_TIMEOUT',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.throws(
      () => registry.register(new TaskExecutionHandle('test-agent')),
      (error) => {
        assert.strictEqual(error.code, 'PROVIDER_INACTIVITY_TIMEOUT');
        assert.strictEqual(error.nestedExecutionCancellation, true);
        return true;
      }
    );

    releaseCancellation();
    await cancellation;
    assert.strictEqual(registry.size, 0);
  });

  it('settles a child already confirmed terminal during cancellation', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    handle.setCancelAction(() => {
      handle.markSettled();
      return { forced: false, alreadyTerminal: true, status: 'completed' };
    });

    const termination = await registry.cancelAll('shutdown race');

    assert.strictEqual(termination.forced, true);
    assert.strictEqual(registry.size, 0);
  });

  it('routes nested deadlines through the same cancellation owner', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let cancellationDetails;

    handle.setCancelAction((reason, details) => {
      cancellationDetails = { reason, details };
      handle.markSettled();
      return { forced: true };
    });
    handle.armDeadline(5);

    await handle.settle();
    assert.match(cancellationDetails.reason, /timed out after 5ms/);
    assert.strictEqual(cancellationDetails.details.code, 'AGENT_TASK_TIMEOUT');
    registry.unregister(handle);
  });

  it('killTask reaches nested ownership without overwriting parent identity', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    const agent = {
      currentTask: null,
      currentTaskId: 'parent-task-42',
      processPid: 1111,
      nestedExecutions: registry,
      _stopLivenessCheck() {},
      _log() {},
    };

    handle.setCancelAction(() => {
      handle.markSettled();
      return { forced: true, taskId: 'nested-task-1' };
    });

    const termination = await killTask(agent, 'cluster shutdown');

    assert.notStrictEqual(termination?.forced, false);
    assert.strictEqual(handle.isCancelled, true);
    assert.strictEqual(registry.size, 0);
    assert.strictEqual(agent.currentTask, null);
    assert.strictEqual(agent.currentTaskId, 'parent-task-42');
    assert.strictEqual(agent.processPid, 1111);
  });

  it('stop cancels an active nested execution even after the parent follower is gone', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    const agent = {
      id: 'test-agent',
      running: true,
      state: 'executing_task',
      currentTask: null,
      currentTaskId: 'parent-task-42',
      processPid: 1111,
      nestedExecutions: registry,
      unsubscribe: null,
      _currentExecution: null,
      _stopLivenessCheck() {},
      _killTask(reason) {
        return killTask(this, reason);
      },
      _log() {},
    };
    handle.setCancelAction(() => {
      handle.markSettled();
      return { forced: true, taskId: 'nested-task-2' };
    });

    await stop(agent);

    assert.strictEqual(agent.running, false);
    assert.strictEqual(agent.state, 'stopped');
    assert.strictEqual(registry.size, 0);
    assert.strictEqual(handle.isCancelled, true);
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

describe('Cached parsed result hook consumers', function () {
  it('reuses parsedResult for hook logic, transforms, and templates', async function () {
    const published = [];
    const agent = {
      id: 'planner',
      role: 'planner',
      iteration: 1,
      cluster: { id: 'test-cluster', agents: [] },
      _parseResultOutput() {
        throw new Error('cached hook result must not be parsed again');
      },
      _log() {},
      _publish(message) {
        published.push(message);
      },
    };
    const result = {
      success: true,
      output: 'tool-only output requiring recovery',
      parsedResult: { plan: 'cached plan', approved: true },
    };

    await executeHook({
      hook: {
        action: 'publish_message',
        logic: {
          engine: 'javascript',
          script: 'return { receiver: result.approved ? "worker" : "broadcast" };',
        },
        config: {
          topic: 'PLAN_READY',
          receiver: 'broadcast',
          content: { data: { plan: '{{result.plan}}' } },
        },
      },
      agent,
      message: { topic: 'ISSUE_OPENED' },
      result,
      cluster: agent.cluster,
    });

    await executeHook({
      hook: {
        action: 'publish_message',
        transform: {
          engine: 'javascript',
          script:
            'return { topic: "VALIDATION_RESULT", content: { data: { approved: result.approved } } };',
        },
      },
      agent,
      message: { topic: 'PLAN_READY' },
      result,
      cluster: agent.cluster,
    });

    assert.deepStrictEqual(published[0], {
      topic: 'PLAN_READY',
      receiver: 'worker',
      content: { data: { plan: 'cached plan' } },
    });
    assert.strictEqual(published[1].topic, 'VALIDATION_RESULT');
    assert.strictEqual(published[1].content.data.approved, true);
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

  it('preserves unconfirmed nested cleanup metadata through structured success', async function () {
    const lifecycleError = new Error('nested cleanup was not confirmed');
    lifecycleError.nestedExecutionLifecycle = true;
    lifecycleError.retainTaskHandle = true;
    lifecycleError.permanent = true;
    lifecycleError.restartExhausted = true;
    lifecycleError.terminationExhausted = true;
    lifecycleError.taskId = 'nested-task-retained';
    const agent = {
      id: 'planner',
      role: 'planner',
      config: { jsonSchema: schema, outputFormat: 'json' },
      _parseResultOutput() {
        throw lifecycleError;
      },
    };

    await assert.rejects(
      buildCompletionResult({
        agent,
        taskId: 'parent-task-1',
        providerName: 'opencode',
        state: { output: 'tool-only output', skipStructuredResultCheck: false },
        stdout: 'Status: completed',
        success: true,
      }),
      (error) => {
        assert.strictEqual(error, lifecycleError);
        assert.strictEqual(error.taskId, 'nested-task-retained');
        assert.strictEqual(error.terminationExhausted, true);
        return true;
      }
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

  it('does not retry after an unconfirmed cleanup failure', async function () {
    let attempts = 0;
    const lifecycleError = new Error('durable child cleanup unconfirmed');
    lifecycleError.nestedExecutionLifecycle = true;
    lifecycleError.retainTaskHandle = true;
    lifecycleError.permanent = true;
    lifecycleError.terminationExhausted = true;

    const agent = {
      id: 'planner',
      role: 'planner',
      running: true,
      state: 'executing_task',
      config: { jsonSchema: schema },
      _resolveProvider: () => 'opencode',
      _spawnClaudeTask() {
        attempts++;
        throw lifecycleError;
      },
    };

    await assert.rejects(
      parseResultOutput(agent, 'Tool call completed without final JSON'),
      (error) => {
        assert.strictEqual(error, lifecycleError);
        assert.strictEqual(error.terminationExhausted, true);
        return true;
      }
    );
    assert.strictEqual(attempts, 1);
  });

  it('preserves provider-inactivity cancellation without launching another child', async function () {
    let attempts = 0;
    const cancellation = new Error('Provider produced no output');
    cancellation.code = 'PROVIDER_INACTIVITY_TIMEOUT';
    cancellation.nestedExecutionCancellation = true;
    cancellation.nestedExecutionLifecycle = true;

    const agent = {
      id: 'planner',
      role: 'planner',
      running: true,
      state: 'executing_task',
      config: { jsonSchema: schema },
      _resolveProvider: () => 'opencode',
      _spawnClaudeTask() {
        attempts++;
        throw cancellation;
      },
    };

    await assert.rejects(
      parseResultOutput(agent, 'Tool call completed without final JSON'),
      (error) => {
        assert.strictEqual(error, cancellation);
        assert.strictEqual(error.code, 'PROVIDER_INACTIVITY_TIMEOUT');
        return true;
      }
    );
    assert.strictEqual(attempts, 1);
  });
});
