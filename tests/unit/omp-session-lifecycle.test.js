const assert = require('assert');
const { buildCompletionResult } = require('../../src/agent/agent-task-executor');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const {
  createProviderSessionAgent,
  createProviderSessionHarness,
} = require('../helpers/provider-session-harness');

// Drives the real capture pipeline against hand-written OMP JSONL frames so these
// tests exercise the same code a real `omp --mode json` process output would.
async function runFakeOmpProcess({
  taskId,
  requestedSessionId,
  lines,
  failCapturePersistence = false,
}) {
  const { createProviderSessionCapture } =
    await import('../../task-lib/provider-session-capture.js');
  let storedTask = {
    id: taskId,
    provider: 'omp',
    requestedResumeSessionId: requestedSessionId || undefined,
  };
  const updateTask = (_taskId, update) => {
    if (
      failCapturePersistence &&
      !Object.hasOwn(update, 'status') &&
      Object.hasOwn(update, 'sessionId')
    ) {
      throw new Error('database is locked');
    }
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
  const captureError = capture.getCompletionError();
  updateTask(taskId, {
    status: captureError ? 'failed' : 'completed',
    error: captureError,
    ...capture.getCompletionUpdate(captureError ? 1 : 0),
  });
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

  it('retries fresh with full context when OMP fresh identity capture is unsafe', async function () {
    for (const scenario of [
      { name: 'missing', lines: [JSON.stringify({ type: 'turn_start' })] },
      { name: 'conflicting', lines: [ompSessionHeader('omp-a'), ompSessionHeader('omp-b')] },
      { name: 'persistence-failed', lines: [ompSessionHeader('omp-uncommitted')], fail: true },
    ]) {
      const cluster = {
        id: `omp-fresh-${scenario.name}-cluster`,
        createdAt: Date.now(),
        agents: [],
      };
      let attempts = 0;
      let agent;
      agent = createProviderSessionAgent({
        cluster,
        messageBus,
        config: {
          provider: 'omp',
          prompt: `OMP-FULL-CONTEXT-${scenario.name}`,
          outputFormat: 'text',
          maxRetries: 2,
          hooks: {
            onComplete: { action: 'publish_message', config: { topic: 'IMPLEMENTATION_READY' } },
          },
        },
        runtime: {
          quiet: true,
          providerCliFeatures: { omp: { supportsResume: true } },
          mockSpawnFn: async (args, { context }) => {
            attempts += 1;
            assert.ok(!args.includes('--resume'));
            if (attempts === 1) {
              const taskInfo = await runFakeOmpProcess({
                taskId: `omp-${scenario.name}-unsafe`,
                requestedSessionId: null,
                lines: scenario.lines,
                failCapturePersistence: scenario.fail === true,
              });
              return buildCompletionResult({
                agent,
                taskId: taskInfo.id,
                providerName: 'omp',
                state: { output: 'unsafe fresh completion', logFilePath: null },
                stdout: `Status: ${taskInfo.status}`,
                success: taskInfo.status === 'completed',
                taskInfo,
              });
            }

            assert.match(context, new RegExp(`OMP-FULL-CONTEXT-${scenario.name}`));
            assert.doesNotMatch(context, /Continuation Turn/);
            return { success: true, output: 'fresh retry done', providerSession: null };
          },
        },
      });
      agent.running = true;

      await agent._executeTask({
        topic: 'ISSUE_OPENED',
        sender: 'system',
        content: { text: `start ${scenario.name}` },
      });

      assert.strictEqual(attempts, 2, scenario.name);
      assert.strictEqual(agent.providerSession, null, scenario.name);
      assert.strictEqual(
        messageBus.count({ cluster_id: cluster.id, topic: 'IMPLEMENTATION_READY' }),
        1,
        `${scenario.name} completion must fail before hooks`
      );
    }
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

  it('enforces exact OMP identity through a fake process, watcher, and SQLite task row', async function () {
    this.timeout(40000);
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-watcher-home-'));
    const fixture = path.resolve(__dirname, '../fixtures/omp-session-watcher-runtime.js');

    try {
      const { stdout } = await execFileAsync(process.execPath, [fixture], {
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          ZEROSHOT_HOME: tempHome,
        },
        timeout: 30000,
      });
      const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT:'));
      assert.ok(resultLine, stdout);
      const result = JSON.parse(resultLine.slice('RESULT:'.length));

      assert.strictEqual(result.fresh.status, 'completed');
      assert.strictEqual(result.fresh.sessionId, 'omp-1');
      assert.strictEqual(result.fresh.resumeIdentityVerified, true);
      assert.strictEqual(result.resumed.status, 'completed');
      assert.strictEqual(result.resumed.requestedResumeSessionId, 'omp-1');
      assert.strictEqual(result.resumed.sessionId, 'omp-1');
      assert.strictEqual(result.resumed.resumeIdentityVerified, true);

      for (const failed of [
        result.forked,
        result.missing,
        result.malformedThenValid,
        result.conflicting,
        result.prefixMismatch,
        result.whitespace,
      ]) {
        assert.strictEqual(failed.status, 'failed');
        assert.strictEqual(failed.sessionId, null);
        assert.strictEqual(failed.sessionIdConflict, true);
        assert.strictEqual(failed.resumeIdentityVerified, false);
      }
      assert.match(result.forked.error, /different session identity/);
      assert.match(result.missing.error, /required session identity/);
      assert.match(result.malformedThenValid.error, /conflicting or malformed/);
      assert.match(result.conflicting.error, /conflicting or malformed/);
      assert.match(result.prefixMismatch.error, /different session identity/);
      assert.match(result.whitespace.error, /conflicting or malformed/);

      const resumedArgs = result.invocations.find((args) => args.at(-1) === 'resume-valid');
      assert.deepStrictEqual(resumedArgs, [
        '--mode',
        'json',
        '-p',
        '--cwd',
        result.repoRoot,
        '--auto-approve',
        '--resume',
        'omp-1',
        'resume-valid',
      ]);
      assert.ok(!result.invocations.some((args) => args.includes('--continue')));
      const forkedArgs = result.invocations.find((args) => args.at(-1) === 'resume-fork');
      assert.strictEqual(forkedArgs[forkedArgs.indexOf('--resume') + 1], result.fresh.sessionId);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
