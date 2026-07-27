const assert = require('assert');

const {
  providerSessionFromCompletedTask,
  resolveAgentResumeSessionId,
  updateAgentProviderSession,
} = require('../../src/agent/provider-session');
const { buildTaskRunArgs } = require('../../src/agent/agent-task-executor');

function buildAgent(overrides = {}) {
  return {
    config: { cwd: process.cwd(), ...overrides.config },
    cluster: { id: 'cluster-1' },
    providerSession: overrides.providerSession || null,
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
  it('reuses explicit Claude and Codex IDs for the same logical agent', function () {
    const claude = buildAgent({
      providerSession: { provider: 'claude', sessionId: 'claude-session-1' },
    });
    const codex = buildAgent({
      providerSession: { provider: 'codex', sessionId: 'codex-thread-1' },
    });

    assert.deepStrictEqual(taskArgs(claude, 'claude').slice(-2), ['--resume', 'claude-session-1']);
    assert.deepStrictEqual(taskArgs(codex, 'codex').slice(-2), ['--resume', 'codex-thread-1']);
  });

  it('starts fresh for unsupported providers, Docker isolation, and provider switches', function () {
    const unsupported = buildAgent({
      providerSession: { provider: 'claude', sessionId: 'claude-session-1' },
    });
    assert.ok(!taskArgs(unsupported, 'gemini').includes('--resume'));
    assert.strictEqual(unsupported.providerSession, null);

    const isolated = buildAgent({
      providerSession: { provider: 'claude', sessionId: 'claude-session-2' },
      isolation: { enabled: true },
    });
    assert.ok(!taskArgs(isolated, 'claude').includes('--resume'));
    assert.strictEqual(isolated.providerSession, null);
  });

  it('captures completed tasks and invalidates failed retry boundaries', function () {
    const agent = buildAgent();
    const completed = providerSessionFromCompletedTask({
      agent,
      providerName: 'codex',
      taskInfo: {
        provider: 'codex',
        status: 'completed',
        sessionId: 'thread-complete',
      },
    });
    updateAgentProviderSession(agent, completed);
    assert.strictEqual(resolveAgentResumeSessionId(agent, 'codex'), 'thread-complete');

    const failed = providerSessionFromCompletedTask({
      agent,
      providerName: 'codex',
      taskInfo: {
        provider: 'codex',
        status: 'failed',
        sessionId: 'thread-failed',
      },
    });
    updateAgentProviderSession(agent, failed);
    assert.strictEqual(resolveAgentResumeSessionId(agent, 'codex'), null);
  });

  it('never leaks one agent session into another agent', function () {
    const worker = buildAgent();
    const validator = buildAgent();
    updateAgentProviderSession(worker, {
      provider: 'claude',
      sessionId: 'worker-session',
    });

    assert.strictEqual(resolveAgentResumeSessionId(worker, 'claude'), 'worker-session');
    assert.strictEqual(resolveAgentResumeSessionId(validator, 'claude'), null);
    assert.strictEqual(validator.providerSession, null);
  });
});
