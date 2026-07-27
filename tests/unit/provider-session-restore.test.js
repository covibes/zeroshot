const assert = require('assert');
const path = require('path');

const {
  restoreAgentProviderSession,
  updateAgentProviderSession,
} = require('../../src/agent/provider-session');

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

function buildAgent() {
  return {
    id: 'worker',
    iteration: 1,
    config: { cwd: TEST_CWD },
    cluster: { id: 'cluster-1' },
    providerSession: null,
    currentContextCursor: 41,
    currentGuidanceCursor: 17,
    lastGuidanceAppliedAt: 17,
    currentPromptText: 'FOLLOW-UP-INSTRUCTIONS',
    isolation: null,
    worktree: null,
  };
}

function lifecycleBus(messages) {
  return {
    query: () =>
      messages.map((data, index) => ({
        timestamp: index + 1,
        content: { data },
      })),
  };
}

function restore(agent, savedState, messages) {
  return restoreAgentProviderSession({
    agent,
    savedState,
    messageBus: lifecycleBus(messages),
    clusterId: 'cluster-1',
  });
}

const completedBoundary = {
  event: 'TASK_COMPLETED',
  provider: 'claude',
  taskId: 'task-generation-1',
  iteration: 1,
  contextCursor: 41,
  guidanceCursor: 17,
  promptText: 'FOLLOW-UP-INSTRUCTIONS',
};

describe('provider-session restart proof', function () {
  it('restores only the exact last completed task boundary', function () {
    const agent = buildAgent();
    const savedState = {
      state: 'idle',
      iteration: 1,
      providerSession: buildSession(),
      lastGuidanceAppliedAt: 17,
    };

    assert.deepStrictEqual(restore(agent, savedState, [completedBoundary]), buildSession());

    for (const boundary of [
      { event: 'TASK_STARTED', provider: 'claude', taskId: 'task-generation-2', iteration: 2 },
      { event: 'TASK_FAILED', provider: 'claude', taskId: 'task-generation-2', iteration: 2 },
      { event: 'RETRY_SCHEDULED', provider: 'claude', taskId: 'task-generation-2', iteration: 2 },
    ]) {
      assert.strictEqual(restore(agent, savedState, [completedBoundary, boundary]), null);
    }
  });

  it('drops legacy session-only state because its task provenance is ambiguous', function () {
    const agent = buildAgent();
    updateAgentProviderSession(agent, {
      provider: 'claude',
      sessionId: 'legacy-session',
    });
    assert.strictEqual(agent.providerSession, null);
  });

  it('drops continuation state without an exact durable context cursor', function () {
    const agent = buildAgent();
    const missingCursor = buildSession();
    delete missingCursor.contextCursor;

    updateAgentProviderSession(agent, missingCursor);
    assert.strictEqual(agent.providerSession, null);

    assert.strictEqual(
      restore(
        agent,
        {
          state: 'idle',
          iteration: 1,
          providerSession: missingCursor,
        },
        [
          {
            event: 'TASK_COMPLETED',
            provider: 'claude',
            taskId: 'task-generation-1',
            iteration: 1,
          },
        ]
      ),
      null
    );
  });

  it('fails closed when restored state is absent or guidance provenance is not bound', function () {
    const agent = buildAgent();

    for (const savedState of [
      {
        iteration: 1,
        providerSession: buildSession(),
        lastGuidanceAppliedAt: 17,
      },
      {
        state: 'idle',
        iteration: 1,
        providerSession: buildSession(),
      },
      {
        state: 'idle',
        iteration: 1,
        providerSession: buildSession(),
        lastGuidanceAppliedAt: 16,
      },
    ]) {
      assert.strictEqual(restore(agent, savedState, [completedBoundary]), null);
    }
  });

  it('rejects a restored completion whose durable cursor differs from the saved session', function () {
    const agent = buildAgent();
    assert.strictEqual(
      restore(
        agent,
        {
          state: 'idle',
          iteration: 1,
          providerSession: buildSession(),
          lastGuidanceAppliedAt: 17,
        },
        [{ ...completedBoundary, contextCursor: 42 }]
      ),
      null
    );
  });
});
