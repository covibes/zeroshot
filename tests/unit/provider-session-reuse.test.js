const assert = require('assert');
const {
  providerSessionFromCompletedTask,
  resolveAgentResumeSessionId,
} = require('../../src/agent/provider-session');
const { buildCompletionResult, buildTaskRunArgs } = require('../../src/agent/agent-task-executor');
const {
  FOLLOW_UP_PROMPT_IDENTITY,
  PROVIDER_SESSION_TEST_CWD: TEST_CWD,
  buildProviderSession: buildSession,
} = require('../helpers/provider-session-harness');

function buildAgent(overrides = {}) {
  return {
    id: overrides.id || 'worker',
    iteration: overrides.iteration ?? 2,
    config: { cwd: TEST_CWD, ...overrides.config },
    cluster: { id: 'cluster-1' },
    providerSession: overrides.providerSession ?? null,
    currentContextSequence: overrides.currentContextSequence ?? 41,
    currentGuidanceSequence: overrides.currentGuidanceSequence ?? 17,
    lastGuidanceAppliedId: overrides.lastGuidanceAppliedId ?? 17,
    currentPromptIdentity: overrides.currentPromptIdentity ?? FOLLOW_UP_PROMPT_IDENTITY,
    isolation: overrides.isolation || null,
    worktree: overrides.worktree || null,
  };
}

function taskArgs(agent, providerName) {
  return buildTaskRunArgs({
    agent,
    providerName,
    modelSpec: {},
    runOutputFormat: 'stream-json',
  });
}

describe('agent-owned provider session reuse', function () {
  it('reuses an explicit ID only for the next generation of the same logical agent', function () {
    const claude = buildAgent({ providerSession: buildSession() });
    const codex = buildAgent({
      providerSession: buildSession({
        provider: 'codex',
        sessionId: 'codex-thread-1',
      }),
    });

    assert.deepStrictEqual(taskArgs(claude, 'claude').slice(-2), ['--resume', 'claude-session-1']);
    assert.deepStrictEqual(taskArgs(codex, 'codex').slice(-2), ['--resume', 'codex-thread-1']);

    const staleGeneration = buildAgent({
      iteration: 3,
      providerSession: buildSession(),
    });
    assert.ok(!taskArgs(staleGeneration, 'claude').includes('--resume'));
    assert.strictEqual(staleGeneration.providerSession, null);
  });

  it('starts fresh for unsupported providers, Docker, provider switches, and worktree drift', function () {
    const unsupported = buildAgent({ providerSession: buildSession() });
    assert.ok(!taskArgs(unsupported, 'gemini').includes('--resume'));

    const isolated = buildAgent({
      providerSession: buildSession(),
      isolation: { enabled: true },
    });
    assert.ok(!taskArgs(isolated, 'claude').includes('--resume'));

    const moved = buildAgent({
      providerSession: buildSession({ worktreePath: '/tmp/old-worktree' }),
      worktree: { enabled: true, path: '/tmp/new-worktree' },
    });
    assert.ok(!taskArgs(moved, 'claude').includes('--resume'));
  });

  it('captures only logically successful completed tasks with full provenance', function () {
    const agent = buildAgent({ iteration: 1 });
    const taskInfo = {
      id: 'task-generation-1',
      provider: 'codex',
      status: 'completed',
      sessionId: 'thread-complete',
    };
    const completed = providerSessionFromCompletedTask({
      agent,
      providerName: 'codex',
      taskInfo,
      logicalSuccess: true,
    });

    assert.deepStrictEqual(completed, {
      provider: 'codex',
      sessionId: 'thread-complete',
      agentId: 'worker',
      taskId: 'task-generation-1',
      generation: 1,
      cwd: TEST_CWD,
      worktreePath: null,
      contextSequence: 41,
      guidanceSequence: 17,
      promptIdentity: FOLLOW_UP_PROMPT_IDENTITY,
    });

    assert.strictEqual(
      providerSessionFromCompletedTask({
        agent,
        providerName: 'codex',
        taskInfo,
        logicalSuccess: false,
      }),
      null
    );
    assert.strictEqual(
      providerSessionFromCompletedTask({
        agent,
        providerName: 'codex',
        taskInfo: { ...taskInfo, status: 'failed' },
      }),
      null
    );
    assert.strictEqual(
      providerSessionFromCompletedTask({
        agent,
        providerName: 'codex',
        taskInfo: { ...taskInfo, sessionId: null },
      }),
      null
    );
  });

  it('discards a provider-completed session when structured output is invalid', async function () {
    const agent = {
      ...buildAgent({ iteration: 1 }),
      _parseResultOutput: () => Promise.reject(new Error('schema mismatch')),
    };
    const result = await buildCompletionResult({
      agent,
      taskId: 'task-generation-1',
      providerName: 'claude',
      state: { output: '{"wrong":true}', logFilePath: null },
      stdout: 'Status: completed',
      success: true,
      taskInfo: {
        id: 'task-generation-1',
        provider: 'claude',
        status: 'completed',
        sessionId: 'must-be-discarded',
      },
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.providerSession, null);
    assert.match(result.error, /schema mismatch/);
  });

  it('accepts only the exact provider identity requested for a resumed turn', async function () {
    const agent = buildAgent({
      iteration: 2,
      config: { outputFormat: 'text' },
    });
    const baseTaskInfo = {
      id: 'task-generation-2',
      provider: 'claude',
      status: 'completed',
      requestedResumeSessionId: 'claude-session-1',
    };

    const confirmed = await buildCompletionResult({
      agent,
      taskId: baseTaskInfo.id,
      providerName: 'claude',
      state: { output: 'done', logFilePath: null },
      stdout: 'Status: completed',
      success: true,
      taskInfo: { ...baseTaskInfo, sessionId: 'claude-session-1' },
    });
    assert.strictEqual(confirmed.success, true);
    assert.strictEqual(confirmed.providerSession.sessionId, 'claude-session-1');

    for (const [name, sessionId, expectedError] of [
      ['ignored', null, /did not confirm/],
      ['forked', 'forked-session', /different session identity/],
      ['absent', undefined, /did not confirm/],
    ]) {
      const result = await buildCompletionResult({
        agent,
        taskId: baseTaskInfo.id,
        providerName: 'claude',
        state: { output: `${name} resume probe`, logFilePath: null },
        stdout: 'Status: completed',
        success: true,
        taskInfo: { ...baseTaskInfo, sessionId },
      });

      assert.strictEqual(result.success, false, `${name} resume must fail the logical attempt`);
      assert.strictEqual(result.providerSession, null);
      assert.match(result.error, expectedError);
    }
  });

  it('never leaks one agent session into another agent', function () {
    const worker = buildAgent({ providerSession: buildSession() });
    const validator = buildAgent({
      id: 'validator',
      providerSession: buildSession(),
    });

    assert.strictEqual(resolveAgentResumeSessionId(worker, 'claude'), 'claude-session-1');
    assert.strictEqual(resolveAgentResumeSessionId(validator, 'claude'), null);
    assert.strictEqual(validator.providerSession, null);
  });
});
