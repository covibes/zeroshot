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
const { startLivenessCheck, stop, stopLivenessCheck } = require('../src/agent/agent-lifecycle');

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

  it('does not erase explicit retention when no cleanup result exists', async function () {
    const retained = new TaskExecutionHandle('test-agent');
    retained.retainOwnership();
    await retained.waitForCancellation();
    retained.finishExecution();
    assert.strictEqual(retained.settled, false);

    const ordinary = new TaskExecutionHandle('test-agent');
    await ordinary.waitForCancellation();
    ordinary.finishExecution();
    assert.strictEqual(ordinary.settled, true);
  });

  it('preserves a consumed unconfirmed cleanup result until retry succeeds', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let attempts = 0;
    handle.assignTaskId('consumed-cleanup-result');
    handle.setCancelAction(() => {
      attempts++;
      return attempts === 1 ? { forced: false, reason: 'cleanup still pending' } : { forced: true };
    });

    const firstTermination = await handle.cancel('deadline cleanup');
    assert.strictEqual(firstTermination.forced, false);
    const consumedTermination = await handle.waitForCancellation();
    assert.strictEqual(consumedTermination.forced, false);
    assert.strictEqual(consumedTermination.reason, 'cleanup still pending');
    handle.finishExecution();
    assert.strictEqual(handle.settled, false);
    assert.deepStrictEqual(registry.activeTaskIds, ['consumed-cleanup-result']);

    await registry.cancelAll('later cleanup retry');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(handle.settled, true);
    assert.strictEqual(registry.size, 0);
  });

  it('fails closed an unkillable local child after bounded deadline cleanup', async function () {
    const clock = sinon.useFakeTimers();
    const handle = new TaskExecutionHandle('test-agent');
    handle.assignTaskId('local-deadline-child');
    let attempts = 0;
    handle.setCancelAction(() => {
      attempts++;
      return { forced: false, reason: 'local cleanup pending' };
    });
    const failurePromise = new Promise((resolve) => {
      handle.setFailClosedAction(resolve);
    });

    handle.armDeadline(5);
    await clock.tickAsync(5);
    const failure = await failurePromise;
    handle.finishExecution();

    assert.strictEqual(attempts, 3);
    assert.strictEqual(failure.code, 'NESTED_TASK_TERMINATION_EXHAUSTED');
    assert.strictEqual(failure.taskId, 'local-deadline-child');
    assert.strictEqual(failure.terminationAttempts, 3);
    assert.strictEqual(failure.retainTaskHandle, true);
    assert.strictEqual(handle.settled, false);
  });

  it('fails closed an isolated child when deadline cleanup keeps rejecting', async function () {
    const clock = sinon.useFakeTimers();
    const handle = new TaskExecutionHandle('test-agent');
    handle.assignTaskId('isolated-deadline-child');
    let attempts = 0;
    handle.setCancelAction(() => {
      attempts++;
      return Promise.reject(new Error('isolated cleanup command failed'));
    });
    const failurePromise = new Promise((resolve) => {
      handle.setFailClosedAction(resolve);
    });

    handle.armDeadline(5);
    await clock.tickAsync(5);
    const failure = await failurePromise;
    handle.finishExecution();

    assert.strictEqual(attempts, 3);
    assert.strictEqual(failure.code, 'NESTED_TASK_TERMINATION_EXHAUSTED');
    assert.strictEqual(failure.taskId, 'isolated-deadline-child');
    assert.match(failure.message, /isolated cleanup command failed/);
    assert.strictEqual(failure.permanent, true);
    assert.strictEqual(handle.settled, false);
  });

  it('settles after cleanup is confirmed before execution finishes', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let attempts = 0;
    handle.setCancelAction(() => {
      attempts++;
      return attempts === 1
        ? { forced: false, reason: 'cleanup temporarily unavailable' }
        : { forced: true };
    });

    const firstTermination = await handle.cancel('first cleanup attempt');
    assert.strictEqual(firstTermination.forced, false);
    const cancellation = registry.cancelAll('retry cleanup');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(handle.settled, false);

    handle.finishExecution();
    await cancellation;
    assert.strictEqual(attempts, 2);
    assert.strictEqual(handle.settled, true);
    assert.strictEqual(registry.size, 0);
  });

  it('settles after cleanup is confirmed following execution finish', async function () {
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    let attempts = 0;
    handle.setCancelAction(() => {
      attempts++;
      return attempts === 1
        ? { forced: false, reason: 'cleanup temporarily unavailable' }
        : { forced: true };
    });

    const firstTermination = await handle.cancel('first cleanup attempt');
    assert.strictEqual(firstTermination.forced, false);
    handle.finishExecution();
    assert.strictEqual(handle.settled, false);

    await registry.cancelAll('retry cleanup');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(handle.settled, true);
    assert.strictEqual(registry.size, 0);
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

  it('fails closed the registered child after liveness cleanup is exhausted', async function () {
    const clock = sinon.useFakeTimers();
    const registry = new NestedExecutionRegistry('test-agent');
    const handle = registry.register(new TaskExecutionHandle('test-agent'));
    handle.assignTaskId('nested-task-stuck');
    let rejectExecution;
    const executionFailure = new Promise((_resolve, reject) => {
      rejectExecution = reject;
    }).catch((error) => error);
    handle.setFailClosedAction(rejectExecution);
    const events = [];
    const agent = {
      id: 'test-agent',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 1,
      staleDuration: 1000,
      taskStartedAt: -1,
      lastOutputTime: -1,
      currentTask: null,
      currentTaskId: null,
      processPid: null,
      nestedExecutions: registry,
      cluster: {},
      _killTask: () => Promise.resolve({ forced: false, reason: 'cleanup still pending' }),
      _publishLifecycle(topic, data) {
        events.push({ topic, data });
      },
      _log() {},
    };

    startLivenessCheck(agent);
    await clock.tickAsync(120000);
    stopLivenessCheck(agent);
    const failure = await executionFailure;

    assert(failure, 'registered child must receive the permanent failure');
    assert.strictEqual(failure.code, 'ISOLATED_TASK_TERMINATION_EXHAUSTED');
    assert.strictEqual(failure.taskId, 'nested-task-stuck');
    assert.deepStrictEqual(failure.nestedTaskIds, ['nested-task-stuck']);
    assert.strictEqual(failure.permanent, true);
    assert.strictEqual(failure.retainTaskHandle, true);
    assert.strictEqual(handle.settled, false);
    assert.strictEqual(registry.size, 1);
    assert.strictEqual(agent.currentTask, null);
    assert.strictEqual(agent.currentTaskId, null);
    const exhausted = events.find(({ topic }) => topic === 'AGENT_TERMINATION_EXHAUSTED');
    assert.deepStrictEqual(exhausted.data.nestedTaskIds, ['nested-task-stuck']);
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
        assert.deepStrictEqual(options, {
          skipStructuredResultCheck: true,
          nested: true,
          structuredOutputRecovery: true,
        });
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

  it('keeps an SDK canonical parsedResult as the sole terminal result shape', async function () {
    const canonicalSdkResult = {
      plan: {
        summary: 'persisted SDK result',
        steps: ['reload evidence', 'publish completion'],
      },
      approved: true,
    };
    const agent = {
      id: 'planner',
      role: 'planner',
      config: { jsonSchema: schema, outputFormat: 'json' },
      _resolveProvider: () => 'omp',
      _parseResultOutput() {
        throw new Error('canonical SDK results must not be parsed or wrapped again');
      },
    };
    const state = {
      output: '',
      skipStructuredResultCheck: false,
      _cachedParsedResult: canonicalSdkResult,
    };

    const result = await buildCompletionResult({
      agent,
      taskId: 'sdk-task-1',
      providerName: 'omp',
      state,
      stdout: '',
      success: true,
      taskInfo: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.parsedResult, canonicalSdkResult);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.parsedResult, 'result'), false);
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

describe('OMP SDK prepared task watcher boundary', function () {
  function sdkPreparedInvocation(requestPath) {
    return {
      invoke: {
        lane: 'spawn',
        parser: 'omp-sdk-ndjson',
        ptyEligible: false,
        strictTerminal: true,
      },
      environmentPolicy: { inherit: 'minimal', values: {} },
      credentialNames: ['FAKE_OMP_SECRET'],
      privateArtifacts: { root: '/tmp/zeroshot-omp-sdk-test', requestPath, owned: true },
      executionIdentity: {
        backend: 'omp-sdk',
        backendVersion: '17.2.1',
        runtime: { name: 'bun', version: '1.3.14' },
        transport: 'sdk',
      },
      semanticIdentity: {
        requestedModelSelector: 'amazon-bedrock/openai.gpt-5.6-sol',
        reasoningEffort: 'max',
        provider: 'amazon-bedrock',
      },
      containmentRequirement: { mode: 'host-process-tree', required: true },
    };
  }

  function sdkRequest(prompt) {
    return {
      protocolVersion: 1,
      runId: 'watcher-run-1',
      cwd: '/tmp/workspace',
      executionContext: 'host',
      prompt,
      modelSelector: 'amazon-bedrock/openai.gpt-5.6-sol',
      reasoningEffort: 'max',
      outputMode: 'json',
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'number' } },
        required: ['answer'],
        additionalProperties: false,
      },
      modelsConfig: {},
      auth: {
        mode: 'environment',
        credentials: { 'amazon-bedrock': { env: 'FAKE_OMP_SECRET' } },
      },
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
      context: '',
    };
  }

  function sdkResultFrame(request) {
    return {
      protocolVersion: 1,
      type: 'result',
      runId: request.runId,
      backend: { id: 'omp-sdk', version: '17.2.1' },
      runtime: { name: 'bun', version: '1.3.14' },
      requested: {
        modelSelector: request.modelSelector,
        reasoningEffort: request.reasoningEffort,
        outputMode: request.outputMode,
      },
      resolved: { modelSelector: request.modelSelector },
      strictOutput: {
        source: 'caller',
        mode: 'strict',
        status: 'valid',
        yield: { successful: true, incremental: false, count: 1 },
      },
      fallback: false,
      execution: { exitCode: 0, aborted: false },
      value: { answer: 42 },
      usage: {
        source: 'omp-aggregate',
        completeness: 'unknown',
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 3,
        totalTokens: 26,
        requests: 2,
        durationMs: 123.5,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.01,
          cacheWrite: 0.02,
          total: 0.33,
        },
      },
    };
  }

  it('selects the non-PTY parser lane without persisting prompt or credential values', async function () {
    const { buildTaskRecord, buildWatcherConfig, shouldUseAttachableWatcher } =
      await import('../task-lib/runner.js');
    const prompt = 'private prompt that must not be stored';
    const secret = 'private credential that must not be serialized';
    const preparedInvocation = sdkPreparedInvocation('/tmp/zeroshot-omp-sdk-test/request.json');
    const commandSpec = {
      binary: '/opt/zeroshot/node_modules/bun/bin/bun',
      args: [
        '/opt/zeroshot/scripts/omp-sdk-sidecar.ts',
        preparedInvocation.privateArtifacts.requestPath,
      ],
      env: { FAKE_OMP_SECRET: secret },
      cleanup: [],
      cleanupMetadata: [],
    };
    const task = buildTaskRecord({
      id: 'sdk-task',
      prompt,
      cwd: '/tmp/workspace',
      options: {},
      logFile: '/tmp/sdk-task.log',
      providerName: 'omp',
      modelSpec: { model: preparedInvocation.semanticIdentity.requestedModelSelector },
      commandSpec,
      preparedInvocation,
    });
    const watcherConfig = buildWatcherConfig(
      'json',
      { type: 'object' },
      {},
      'omp',
      commandSpec,
      preparedInvocation
    );

    assert.strictEqual(
      shouldUseAttachableWatcher({ attachable: true }, preparedInvocation, 'omp'),
      false
    );
    assert.strictEqual(task.prompt, null);
    assert.strictEqual(task.fullPrompt, null);
    assert.strictEqual(task.inputSizeBytes, Buffer.byteLength(prompt));
    assert.match(task.inputDigest.value, /^[0-9a-f]{64}$/);
    assert.strictEqual(task.invoke.lane, 'spawn');
    assert.strictEqual(task.attachable, false);
    assert.strictEqual(task.sessionId, null);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(task, 'rpcPartition'), false);
    assert.strictEqual(watcherConfig.preparedInvocation.invoke.parser, 'omp-sdk-ndjson');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(watcherConfig, 'env'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(watcherConfig, 'jsonSchema'), false);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(watcherConfig.commandSpec, 'args'),
      false
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(watcherConfig.commandSpec, 'env'),
      false
    );
    const metadata = JSON.stringify({ task, watcherConfig });
    assert.strictEqual(metadata.includes(prompt), false);
    assert.strictEqual(metadata.includes(secret), false);
  });

  it('routes prepared ACP stdio invocations away from generic provider spawn', async function () {
    const { buildPreparedInvocation, buildWatcherConfig, shouldUseAttachableWatcher } =
      await import('../task-lib/runner.js');
    const { isAcpStdioWatcherConfig, resolveWatcherCommand } =
      await import('../task-lib/watcher-output-runtime.js');
    const preparedInvocation = buildPreparedInvocation({
      invoke: {
        lane: 'acp-stdio',
        parser: 'acp',
        ptyEligible: false,
        strictTerminal: false,
      },
      context: 'ACP prompt sent over JSON-RPC stdin',
    });
    const commandSpec = {
      binary: 'kiro-cli',
      args: ['acp'],
      env: {},
      cleanup: [],
      cleanupMetadata: [],
    };
    const watcherConfig = buildWatcherConfig(
      'stream-json',
      null,
      {},
      'kiro',
      commandSpec,
      preparedInvocation
    );

    assert.strictEqual(isAcpStdioWatcherConfig(watcherConfig), true);
    assert.strictEqual(shouldUseAttachableWatcher({}, preparedInvocation, 'kiro'), false);
    assert.throws(
      () => resolveWatcherCommand(watcherConfig, commandSpec, commandSpec.args, (name) => name),
      /declared process runner/
    );
  });

  it('uses stored invoke metadata for command attach eligibility and provider fallback only for legacy tasks', async function () {
    const { shouldAdvertiseTaskAttach } = await import('../task-lib/commands/run.js');
    const schema = { type: 'object' };
    const sdkTask = {
      provider: 'omp',
      invoke: sdkPreparedInvocation('/tmp/zeroshot-omp-sdk-test/request.json').invoke,
    };

    assert.strictEqual(
      shouldAdvertiseTaskAttach(sdkTask, { outputFormat: 'json', jsonSchema: schema }),
      false
    );
    assert.strictEqual(
      shouldAdvertiseTaskAttach(
        { provider: 'claude', invoke: { ...sdkTask.invoke, ptyEligible: true } },
        { outputFormat: 'json', jsonSchema: schema }
      ),
      true
    );
    assert.strictEqual(
      shouldAdvertiseTaskAttach(
        { provider: 'claude' },
        { outputFormat: 'json', jsonSchema: schema }
      ),
      false
    );
    assert.strictEqual(
      shouldAdvertiseTaskAttach(
        { provider: 'codex' },
        { outputFormat: 'json', jsonSchema: schema }
      ),
      true
    );
  });

  it('uses persisted invocation metadata as the resume authority', async function () {
    const { buildResumeTaskOptions } = await import('../task-lib/commands/resume.js');
    const sdkInvoke = sdkPreparedInvocation(
      '/tmp/zeroshot-omp-sdk-test/resume-request.json'
    ).invoke;

    assert.throws(
      () =>
        buildResumeTaskOptions({
          id: 'sdk-resume-task',
          provider: 'codex',
          invoke: sdkInvoke,
          sessionId: 'provider-session-that-must-not-override-the-sdk-lane',
          cwd: '/tmp/workspace',
        }),
      /prepared as a fresh strict OMP SDK invocation and cannot be resumed/
    );

    const directTask = {
      id: 'direct-resume-task',
      provider: 'codex',
      invoke: {
        lane: 'spawn',
        parser: 'provider',
        ptyEligible: true,
        strictTerminal: false,
      },
      sessionId: 'direct-provider-session',
      cwd: '/tmp/workspace',
    };
    assert.deepStrictEqual(buildResumeTaskOptions(directTask), {
      cwd: '/tmp/workspace',
      resume: 'direct-provider-session',
      provider: 'codex',
    });

    assert.throws(
      () =>
        buildResumeTaskOptions({
          id: 'legacy-unsupported-task',
          provider: 'gemini',
          sessionId: 'legacy-session',
          cwd: '/tmp/workspace',
        }),
      /does not support safe session resume/
    );
  });

  it('publishes only the canonical runner value after cleanup is attested', async function () {
    const request = sdkRequest('private collector prompt');
    const frame = sdkResultFrame(request);
    const { normalizeOmpSdkResultFrame } = require('../lib/agent-cli-provider');
    const terminal = {
      type: 'result',
      frame,
      event: normalizeOmpSdkResultFrame(frame, request),
    };
    const cleanupAttestation = {
      mode: 'host-process-tree',
      terminalBuffered: true,
      descendantsReaped: true,
      clean: true,
    };
    const preparedInvocation = sdkPreparedInvocation('/tmp/zeroshot-omp-sdk-test/request.json');
    const logs = [];
    const { completeOmpSdkProcessResult, completeWatcherTask } =
      await import('../task-lib/watcher-output-runtime.js');
    const completion = completeOmpSdkProcessResult(
      {
        terminal,
        progress: [],
        diagnosticStderr: '',
        cleanupAttestation,
      },
      { log: (line) => logs.push(line) }
    );
    assert.deepStrictEqual(completion.terminalUpdates.parsedResult, { answer: 42 });
    assert.strictEqual(completion.terminalUpdates.sdkEvidence.terminalType, 'result');
    assert.strictEqual(
      logs.some((line) => line.includes('"answer":42')),
      false
    );

    const unattested = completeOmpSdkProcessResult({
      terminal,
      progress: [],
      diagnosticStderr: '',
      cleanupAttestation: null,
    });
    assert.strictEqual(unattested.status, 'failed');
    assert.strictEqual(unattested.cleanupUncertain, true);
    assert.strictEqual(unattested.terminalUpdates.parsedResult, null);

    let persistedUpdate = null;
    await completeWatcherTask({
      taskId: 'sdk-task',
      completion,
      commandCleanup: { run: () => Promise.resolve(true) },
      terminateProvider: () => Promise.resolve(true),
      updateTask: (_id, update) => {
        persistedUpdate = update;
        return Promise.resolve();
      },
      emergencyLog: () => {},
      containmentRequirement: preparedInvocation.containmentRequirement,
    });
    assert.deepStrictEqual(persistedUpdate.parsedResult, { answer: 42 });
    assert.deepStrictEqual(persistedUpdate.cleanupAttestation, cleanupAttestation);
  });
});
