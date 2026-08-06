/**
 * OMP fresh-only isolation: no continuation across an isolated task, ever.
 *
 * Issue #866 made OMP sessions resumable (`sessionResume: true`), but *only* on the host,
 * worktree, detached cluster-agent, and standalone manual-resume paths. Docker stays fresh-only,
 * for a stronger reason than a capability flag: the container filesystem is ephemeral, so a
 * session partition allocated inside it could never be resumed and its ownership row would be
 * unreclaimable once the container is removed.
 *
 * This suite is the regression guard for that boundary. Session reuse must stay rejected before
 * resume construction under isolation; an isolated task must allocate no partition at all
 * (`ZEROSHOT_OMP_SESSIONLESS`, see task-lib/omp-storage-root.js) and therefore launch
 * `--no-session`; a bare session id must never be accepted on any path; and neither same-container
 * next task nor container recreation may thread a prior OMP session ID forward. The suite also
 * pins the *positive* side — an un-isolated agent with a complete verified snapshot does reuse —
 * so a future change cannot quietly re-disable resume everywhere and still pass.
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

/** A *complete* post-#866 omp snapshot: the generic tuple plus the exact optional `ompSession`
 * field, which `normalizeProviderSession` requires for provider omp. */
function ompSession(overrides = {}) {
  return buildProviderSession({
    provider: 'omp',
    sessionId: 'omp-session-1',
    ompSession: {
      schemaVersion: 1,
      partitionId: '11111111-1111-4111-8111-111111111111',
      sessionFileName: '2026-08-02T00-00-00-000Z_omp-session-1.jsonl',
      sessionFileIdentity: { device: '2049', inode: '17' },
      artifactManifestDigest: `sha256:${'a'.repeat(64)}`,
      executionFingerprint: `sha256:${'b'.repeat(64)}`,
      selectedProvider: 'anthropic',
      selectedModel: '@default',
    },
    ...overrides,
  });
}

describe('OMP fresh-only isolation', function () {
  describe('agentCanReuseSession', function () {
    it('is false under Docker isolation', function () {
      assert.strictEqual(agentCanReuseSession({ isolation: { enabled: true } }, 'omp'), false);
    });

    it('is true without isolation, because #866 made host/worktree sessions resumable', function () {
      assert.strictEqual(agentCanReuseSession({ isolation: null }, 'omp'), true);
      assert.strictEqual(agentCanReuseSession({}, 'omp'), true);
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

    it('resolves a complete snapshot when the agent is not isolated', function () {
      const agent = buildOmpAgent({ providerSession: ompSession() });
      const resolved = resolveAgentProviderSession(agent, 'omp');
      assert.ok(resolved, 'an un-isolated agent with a verified snapshot may reuse it');
      assert.strictEqual(resolved.ompSession.partitionId, '11111111-1111-4111-8111-111111111111');
    });

    it('rejects a snapshot missing the required ompSession field', function () {
      const incomplete = ompSession();
      delete incomplete.ompSession;
      const agent = buildOmpAgent({ providerSession: incomplete });
      assert.strictEqual(resolveAgentProviderSession(agent, 'omp'), null);
      assert.strictEqual(agent.providerSession, null);
    });
  });

  describe('providerSessionFromCompletedTask', function () {
    it('never captures a session from a cleanly completed isolated task', function () {
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

    it('captures nothing without a committed ownership record, isolation or not', function () {
      // The generic sessionId column is never populated by the rpc-stdio watcher; only a
      // committed task.ompSessionOwnership record proves a resumable OMP session.
      const agent = buildOmpAgent({ iteration: 1 });
      const captured = providerSessionFromCompletedTask({
        agent,
        providerName: 'omp',
        taskInfo: {
          id: 'task-generation-1',
          provider: 'omp',
          status: 'completed',
          sessionId: 'omp-thread-with-no-ownership-row',
        },
        logicalSuccess: true,
      });
      assert.strictEqual(captured, null);
    });
  });

  describe('restoreAgentProviderSession', function () {
    it('never restores an omp session into an isolated agent across an orchestrator restart', function () {
      const agent = buildOmpAgent({ iteration: 2, isolation: { enabled: true } });
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
    it('is sessionless when no verified partition is supplied (the Docker/isolated shape)', function () {
      // An isolated run allocates no partition at all (task-lib/runner.js#resolveOmpSessionPlan
      // returns null under ZEROSHOT_OMP_SESSIONLESS), so `ompSession` is absent and the adapter
      // falls back to `--no-session`.
      for (const spec of [buildOmpCommand(), buildOmpCommand({ cwd: '/workspace' })]) {
        assert.ok(
          spec.args.includes('--no-session'),
          `expected --no-session in ${spec.args.join(' ')}`
        );
        assert.ok(!spec.args.includes('--resume'));
        assert.ok(!spec.args.includes('--continue'));
        assert.ok(!spec.args.includes('--session-dir'));
      }
    });

    it('never accepts --continue, and never a bare session id without a verified partition', function () {
      assert.throws(() => buildOmpCommand({ continueSession: true }), /never supports --continue/);
      assert.throws(
        () => buildOmpCommand({ resumeSessionId: 'omp-session-1' }),
        /requires a verified session partition/
      );
      // Not even alongside a *fresh* partition: continuation is always an explicit verified resume.
      assert.throws(
        () =>
          buildOmpCommand({
            resumeSessionId: 'omp-session-1',
            ompSession: { kind: 'fresh', partition: { path: '/srv/omp-sessions/p' } },
          }),
        /requires a verified session partition/
      );
    });

    it('uses --session-dir for a fresh partition and adds the exact --resume path for a verified one', function () {
      const fresh = buildOmpCommand({
        ompSession: { kind: 'fresh', partition: { path: '/srv/omp-sessions/p' } },
      });
      assert.ok(!fresh.args.includes('--no-session'));
      assert.deepStrictEqual(
        fresh.args.slice(fresh.args.indexOf('--session-dir'), fresh.args.indexOf('--session-dir') + 2),
        ['--session-dir', '/srv/omp-sessions/p']
      );
      assert.ok(!fresh.args.includes('--resume'));

      const resumed = buildOmpCommand({
        ompSession: {
          kind: 'resume',
          partition: { path: '/srv/omp-sessions/p' },
          file: { path: '/srv/omp-sessions/p/2026_sess.jsonl' },
        },
      });
      assert.ok(!resumed.args.includes('--no-session'));
      assert.deepStrictEqual(
        resumed.args.slice(resumed.args.indexOf('--resume'), resumed.args.indexOf('--resume') + 2),
        ['--resume', '/srv/omp-sessions/p/2026_sess.jsonl'],
        'resume takes the exact verified absolute path, never an id search'
      );
    });
  });
});
