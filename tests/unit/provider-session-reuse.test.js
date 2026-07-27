const assert = require('assert');
const path = require('path');

const {
  providerSessionFromCompletedTask,
  resolveAgentResumeSessionId,
} = require('../../src/agent/provider-session');
const { buildCompletionResult, buildTaskRunArgs } = require('../../src/agent/agent-task-executor');

const TEST_CWD = path.resolve('/tmp/provider-session-project');

function buildSession(overrides = {}) {
  return {
    provider: 'claude',
    sessionId: 'claude-session-1',
    agentId: 'worker',
    taskId: 'task-generation-1',
    generation: 1,
    cwd: TEST_CWD,
    worktreePath: null,
    contextCursor: 41,
    guidanceCursor: 17,
    promptText: 'FOLLOW-UP-INSTRUCTIONS',
    ...overrides,
  };
}

function buildAgent(overrides = {}) {
  return {
    id: overrides.id || 'worker',
    iteration: overrides.iteration ?? 2,
    config: { cwd: TEST_CWD, ...overrides.config },
    cluster: { id: 'cluster-1' },
    providerSession: overrides.providerSession ?? null,
    currentContextCursor: overrides.currentContextCursor ?? 41,
    currentGuidanceCursor: overrides.currentGuidanceCursor ?? 17,
    lastGuidanceAppliedAt: overrides.lastGuidanceAppliedAt ?? 17,
    currentPromptText: overrides.currentPromptText ?? 'FOLLOW-UP-INSTRUCTIONS',
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
      contextCursor: 41,
      guidanceCursor: 17,
      promptText: 'FOLLOW-UP-INSTRUCTIONS',
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
