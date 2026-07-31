const assert = require('assert');
const { buildCompletionResult } = require('../../src/agent/agent-task-executor');

const {
  createProviderSessionAgent,
  createProviderSessionHarness,
} = require('../helpers/provider-session-harness');

// Drives the real capture pipeline against hand-written OMP JSONL frames so these
// tests exercise the same code a real `omp --mode json` process output would.
async function runFakeOmpProcess({ taskId, requestedSessionId, lines }) {
  const { createProviderSessionCapture } =
    await import('../../task-lib/provider-session-capture.js');
  let storedTask = {
    id: taskId,
    provider: 'omp',
    requestedResumeSessionId: requestedSessionId || undefined,
  };
  const updateTask = (_taskId, update) => {
    storedTask = { ...storedTask, ...update };
  };
  const capture = createProviderSessionCapture({
    providerName: 'omp',
    taskId,
    requestedSessionId,
    updateTask,
    log: () => {},
  });
  lines.forEach((line) => capture.captureLine(line));
  updateTask(taskId, { status: 'completed', ...capture.getCompletionUpdate(0) });
  return storedTask;
}

function ompSessionHeader(sessionId) {
  return JSON.stringify({ type: 'session', version: 3, id: sessionId });
}

describe('omp provider session lifecycle', function () {
  let harness;
  let messageBus;

  beforeEach(function () {
    harness = createProviderSessionHarness('zeroshot-omp-session-lifecycle-');
    messageBus = harness.messageBus;
  });

  afterEach(function () {
    harness.cleanup();
  });

  it('captures a fresh OMP session and tolerates a harmless repeated header', async function () {
    const cluster = { id: 'omp-fresh-cluster', createdAt: Date.now(), agents: [] };
    let agent;
    agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        provider: 'omp',
        prompt: 'OMP-FRESH-INSTRUCTIONS',
        outputFormat: 'text',
        hooks: {
          onComplete: { action: 'publish_message', config: { topic: 'IMPLEMENTATION_READY' } },
        },
      },
      runtime: {
        quiet: true,
        providerCliFeatures: { omp: { supportsResume: true } },
        mockSpawnFn: async (args) => {
          assert.ok(!args.includes('--resume'), 'a fresh run must never request --resume');
          const taskInfo = await runFakeOmpProcess({
            taskId: 'omp-fresh-task',
            requestedSessionId: null,
            lines: [ompSessionHeader('omp-1'), ompSessionHeader('omp-1')],
          });
          return buildCompletionResult({
            agent,
            taskId: 'omp-fresh-task',
            providerName: 'omp',
            state: { output: 'done', logFilePath: null },
            stdout: 'Status: completed',
            success: true,
            taskInfo,
          });
        },
      },
    });
    agent.running = true;

    await agent._executeTask({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'start' },
    });

    assert.strictEqual(agent.providerSession?.provider, 'omp');
    assert.strictEqual(agent.providerSession?.sessionId, 'omp-1');
    assert.strictEqual(
      messageBus.count({ cluster_id: cluster.id, topic: 'IMPLEMENTATION_READY' }),
      1
    );
  });

  it('resumes with the exact first-turn session id and rejects a forked id before hooks', async function () {
    const cluster = { id: 'omp-resume-cluster', createdAt: Date.now(), agents: [] };
    let attempts = 0;
    let agent;
    agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        provider: 'omp',
        prompt: 'OMP-RESUME-INSTRUCTIONS',
        outputFormat: 'text',
        maxRetries: 2,
        hooks: {
          onComplete: { action: 'publish_message', config: { topic: 'IMPLEMENTATION_READY' } },
        },
      },
      runtime: {
        quiet: true,
        providerCliFeatures: { omp: { supportsResume: true } },
        mockSpawnFn: async (args) => {
          attempts += 1;
          if (attempts === 1) {
            assert.ok(!args.includes('--resume'), 'the first turn has no session to resume');
            const taskInfo = await runFakeOmpProcess({
              taskId: 'omp-resume-task-1',
              requestedSessionId: null,
              lines: [ompSessionHeader('omp-1')],
            });
            return buildCompletionResult({
              agent,
              taskId: 'omp-resume-task-1',
              providerName: 'omp',
              state: { output: 'first turn done', logFilePath: null },
              stdout: 'Status: completed',
              success: true,
              taskInfo,
            });
          }

          if (attempts === 2) {
            const resumeIndex = args.indexOf('--resume');
            assert.ok(resumeIndex >= 0, 'the second turn must request --resume');
            assert.strictEqual(args[resumeIndex + 1], 'omp-1');
            assert.ok(!args.includes('--continue'), 'OMP must never receive --continue');
            // The fake process forks: it echoes a different session identity than requested.
            const taskInfo = await runFakeOmpProcess({
              taskId: 'omp-resume-task-2',
              requestedSessionId: 'omp-1',
              lines: [ompSessionHeader('omp-forked-2')],
            });
            return buildCompletionResult({
              agent,
              taskId: 'omp-resume-task-2',
              providerName: 'omp',
              state: { output: 'forked turn', logFilePath: null },
              stdout: 'Status: completed',
              success: true,
              taskInfo,
            });
          }

          assert.strictEqual(agent.providerSession, null);
          assert.ok(!args.includes('--resume'), 'a forked identity must force a fresh retry');
          return { success: true, output: 'fresh retry done', providerSession: null };
        },
      },
    });
    agent.running = true;

    await agent._executeTask({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'start' },
    });
    assert.strictEqual(agent.providerSession?.sessionId, 'omp-1');

    await agent._executeTask({
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'retry the continuation' },
    });

    assert.strictEqual(attempts, 3);
    assert.strictEqual(agent.providerSession, null);
    assert.strictEqual(
      messageBus.count({ cluster_id: cluster.id, topic: 'IMPLEMENTATION_READY' }),
      2,
      'the forked resume must fail before its completion hook, then the fresh retry succeeds'
    );
    const lifecycleEvents = messageBus
      .query({ cluster_id: cluster.id, topic: 'AGENT_LIFECYCLE', sender: 'worker' })
      .map((message) => message.content?.data?.event);
    assert.strictEqual(lifecycleEvents.filter((event) => event === 'TASK_COMPLETED').length, 2);
    assert.ok(lifecycleEvents.includes('TASK_FAILED'));
  });

  it('fails closed with resumeIdentityVerified:false when the requested identity is missing or malformed', async function () {
    const cluster = { id: 'omp-malformed-cluster', createdAt: Date.now(), agents: [] };
    let attempts = 0;
    let agent;
    agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        provider: 'omp',
        prompt: 'OMP-MALFORMED-INSTRUCTIONS',
        outputFormat: 'text',
        maxRetries: 1,
      },
      runtime: {
        quiet: true,
        providerCliFeatures: { omp: { supportsResume: true } },
        mockSpawnFn: async (args) => {
          attempts += 1;
          if (attempts === 1) {
            const taskInfo = await runFakeOmpProcess({
              taskId: 'omp-malformed-task-1',
              requestedSessionId: null,
              lines: [ompSessionHeader('omp-1')],
            });
            return buildCompletionResult({
              agent,
              taskId: 'omp-malformed-task-1',
              providerName: 'omp',
              state: { output: 'first turn done', logFilePath: null },
              stdout: 'Status: completed',
              success: true,
              taskInfo,
            });
          }

          const resumeIndex = args.indexOf('--resume');
          assert.ok(resumeIndex >= 0);
          assert.strictEqual(args[resumeIndex + 1], 'omp-1');
          // The fake process emits malformed / missing-id session frames only.
          const taskInfo = await runFakeOmpProcess({
            taskId: 'omp-malformed-task-2',
            requestedSessionId: 'omp-1',
            lines: [JSON.stringify({ type: 'session', id: '' }), 'not-json-at-all', '{broken'],
          });
          assert.strictEqual(taskInfo.resumeIdentityVerified, false);
          return buildCompletionResult({
            agent,
            taskId: 'omp-malformed-task-2',
            providerName: 'omp',
            state: { output: 'malformed turn', logFilePath: null },
            stdout: 'Status: completed',
            success: true,
            taskInfo,
          });
        },
      },
    });
    agent.running = true;

    await agent._executeTask({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'start' },
    });
    await agent._executeTask({
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'retry the continuation' },
    });

    assert.strictEqual(agent.providerSession, null);
    const failed = messageBus
      .query({ cluster_id: cluster.id, topic: 'AGENT_LIFECYCLE', sender: 'worker' })
      .some((message) => message.content?.data?.event === 'TASK_FAILED');
    assert.ok(failed, 'a missing/malformed identity must fail closed before hooks');
  });
});
