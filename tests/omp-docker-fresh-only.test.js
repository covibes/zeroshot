/**
 * OMP fresh-only isolation: no continuation across an isolated task, ever.
 *
 * omp's `sessionResume` capability is (and remains) `false` in the registry — its RPC lane runs
 * `--no-session` unconditionally (see PR #907 / src/agent-cli-provider/adapters/omp.ts). This
 * suite is the regression guard for that boundary now that omp also has Docker isolation: session
 * reuse must stay rejected before resume construction under isolation, the built omp command must
 * always carry `--no-session` and never `--resume`/`--continue`, and neither same-container next
 * task nor container recreation may ever thread a prior OMP session ID forward.
 */

const assert = require('assert');
const helper = require('../lib/agent-cli-provider');
const {
  agentCanReuseSession,
  providerSessionFromCompletedTask,
  resolveAgentProviderSession,
  resolveAgentResumeSessionId,
  restoreAgentProviderSession,
} = require('../src/agent/provider-session');
const {
  FOLLOW_UP_PROMPT_IDENTITY,
  PROVIDER_SESSION_TEST_CWD: TEST_CWD,
  buildProviderSession,
} = require('./helpers/provider-session-harness');

const FULL_OMP_FEATURES = {
  versionMatches: true,
  supportsRpcMode: true,
  supportsConfig: true,
  supportsModel: true,
  supportsThinking: true,
  supportsApprovalMode: true,
  supportsNoTitle: true,
  supportsNoSession: true,
  supportsSessionDir: true,
  supportsResume: true,
};

function buildOmpCommand(options = {}) {
  return helper.buildProviderCommand('omp', 'prompt', {
    cliFeatures: FULL_OMP_FEATURES,
    modelSpec: { model: 'm' },
    ...options,
  });
}

function buildOmpAgent(overrides = {}) {
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

function ompSession(overrides = {}) {
  return buildProviderSession({ provider: 'omp', sessionId: 'omp-session-1', ...overrides });
}

describe('OMP fresh-only isolation', function () {
  describe('agentCanReuseSession', function () {
    it('is false under Docker isolation', function () {
      assert.strictEqual(agentCanReuseSession({ isolation: { enabled: true } }, 'omp'), false);
    });

    it('is false even without isolation (sessionResume capability is false)', function () {
      assert.strictEqual(agentCanReuseSession({ isolation: null }, 'omp'), false);
      assert.strictEqual(agentCanReuseSession({}, 'omp'), false);
    });
  });

  describe('resolveAgentProviderSession', function () {
    it('returns null and nulls agent.providerSession when isolation is enabled', function () {
      const agent = buildOmpAgent({
        providerSession: ompSession(),
        isolation: { enabled: true },
      });
      const resolved = resolveAgentProviderSession(agent, 'omp');
      assert.strictEqual(resolved, null);
      assert.strictEqual(agent.providerSession, null);
    });

    it('returns null and nulls agent.providerSession even without isolation', function () {
      const agent = buildOmpAgent({ providerSession: ompSession() });
      const resolved = resolveAgentProviderSession(agent, 'omp');
      assert.strictEqual(resolved, null);
      assert.strictEqual(agent.providerSession, null);
    });

    it('never leaks a resume session id for omp', function () {
      const agent = buildOmpAgent({ providerSession: ompSession() });
      assert.strictEqual(resolveAgentResumeSessionId(agent, 'omp'), null);
    });
  });

  describe('providerSessionFromCompletedTask', function () {
    it('never captures a session for omp, even from a cleanly completed isolated task', function () {
      const agent = buildOmpAgent({ iteration: 1, isolation: { enabled: true } });
      const taskInfo = {
        id: 'task-generation-1',
        provider: 'omp',
        status: 'completed',
        sessionId: 'omp-thread-should-never-persist',
      };
      const captured = providerSessionFromCompletedTask({
        agent,
        providerName: 'omp',
        taskInfo,
        logicalSuccess: true,
      });
      assert.strictEqual(captured, null);
    });
  });

  describe('restoreAgentProviderSession', function () {
    it('never restores an omp session across an orchestrator restart', function () {
      const agent = buildOmpAgent({ iteration: 2 });
      const savedState = {
        state: 'idle',
        iteration: 1,
        lastGuidanceAppliedId: '17',
        providerSession: ompSession({ generation: 1 }),
      };
      const messageBus = { query: () => [] };
      const restored = restoreAgentProviderSession({
        agent,
        savedState,
        messageBus,
        clusterId: 'cluster-1',
      });
      assert.strictEqual(restored, null);
    });
  });

  describe('simulated container recreation carries no session id forward', function () {
    it('a fresh agent after container recreation has no providerSession to resume from', function () {
      // Container recreation drops the old container id and creates a new one (see
      // orchestrator.js#_ensureIsolationForResume); it never rehydrates a provider session. Model
      // that as a fresh agent object with providerSession: null and confirm the resume path is a
      // no-op — full context must be rebuilt, never a continuation.
      const recreatedAgent = buildOmpAgent({
        providerSession: null,
        isolation: { enabled: true },
      });
      assert.strictEqual(resolveAgentProviderSession(recreatedAgent, 'omp'), null);
      assert.strictEqual(resolveAgentResumeSessionId(recreatedAgent, 'omp'), null);
    });
  });

  describe('the built omp command', function () {
    it('always contains --no-session', function () {
      const spec = buildOmpCommand();
      assert.ok(
        spec.args.includes('--no-session'),
        `expected --no-session in ${spec.args.join(' ')}`
      );
    });

    it('never contains --resume or --continue', function () {
      const spec = buildOmpCommand();
      assert.ok(!spec.args.includes('--resume'));
      assert.ok(!spec.args.includes('--continue'));
    });

    it('fails closed rather than accepting resumeSessionId/continueSession', function () {
      assert.throws(() => buildOmpCommand({ resumeSessionId: 'omp-session-1' }), /sessionless/);
      assert.throws(() => buildOmpCommand({ continueSession: true }), /sessionless/);
    });

    it('still contains --no-session under an isolated (Docker) invocation shape', function () {
      // The adapter has no isolation-specific branch — sessionless is unconditional — but this
      // guards against a future isolation-aware code path silently reintroducing --resume.
      const spec = buildOmpCommand({ cwd: '/workspace' });
      assert.ok(spec.args.includes('--no-session'));
      assert.ok(!spec.args.includes('--resume'));
    });
  });
});
