/**
 * Test: Setup plan contract (buildSetupPlan)
 *
 * Verifies the pinned, versioned setup contract from issue #605:
 * - Pure over injected inputs, no writes, no prompts
 * - Stable decisionId registry
 * - defaultIsolation/defaultDelivery map to canonical settings keys only
 * - No secrets ever surface in the plan
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSetupPlan, isConsumedPath } = require('../../lib/setup-plan');
const { VALID_PROVIDERS: PROVIDER_NAMES } = require('../../lib/provider-names');

const EXPECTED_DECISION_IDS = new Set([
  'defaultProvider',
  ...PROVIDER_NAMES.map((name) => `providerLevel.${name}`),
  'defaultIsolation',
  'allowLocalNoIsolation',
  'defaultDelivery',
  'defaultIssueSource',
  'prBase',
  'dockerMounts',
  'dockerEnvPassthrough',
  'updatePolicy',
]);

function makeProviderDefaults() {
  const defaults = {};
  for (const name of PROVIDER_NAMES) {
    defaults[name] = {
      minLevel: 'level1',
      maxLevel: 'level3',
      defaultLevel: 'level2',
      levelOverrides: {},
    };
  }
  return defaults;
}

function makeDeps(overrides = {}) {
  return {
    commandExists: () => false,
    getCommandPath: () => null,
    checkDocker: () => ({ available: false }),
    checkGhAuth: () => ({ authenticated: false }),
    execSync: () => {
      throw new Error('not a repo');
    },
    listProviders: () => PROVIDER_NAMES,
    getProvider: (name) => ({
      cliCommand: name,
    }),
    getProviderDefaults: () => makeProviderDefaults(),
    getNodeVersion: () => 'v99.0.0',
    getPackageVersion: () => '9.9.9',
    ...overrides,
  };
}

function freshMachinePlan() {
  return buildSetupPlan({
    cwd: '/fresh/machine/cwd',
    settings: { __meta: { fileExists: false } },
    repoSettings: null,
    env: {},
    deps: makeDeps(),
  });
}

function fullyConfiguredExecSync(command) {
  if (command.includes('is-inside-work-tree')) return 'true\n';
  if (command.includes('abbrev-ref origin/HEAD')) return 'origin/main\n';
  if (command.includes('abbrev-ref HEAD')) return 'main\n';
  if (command.includes('remote get-url origin')) return 'https://github.com/acme/widgets.git\n';
  throw new Error(`unexpected command: ${command}`);
}

function fullyConfiguredPlan() {
  const deps = makeDeps({
    commandExists: () => true,
    getCommandPath: (cmd) => `/usr/local/bin/${cmd}`,
    checkDocker: () => ({ available: true }),
    checkGhAuth: () => ({ authenticated: true }),
    execSync: (command) => fullyConfiguredExecSync(command),
  });

  return buildSetupPlan({
    cwd: '/configured/repo',
    settings: {
      __meta: { fileExists: true },
      defaultProvider: 'claude',
      defaultIsolation: 'none',
      defaultDelivery: 'none',
      allowLocalNoIsolation: false,
      defaultIssueSource: 'github',
      dockerMounts: ['gh', 'git', 'ssh'],
      dockerEnvPassthrough: [],
      updatePolicy: 'notify',
    },
    repoSettings: { prBase: 'main' },
    env: {},
    deps,
  });
}

describe('buildSetupPlan', function () {
  describe('shape', function () {
    it('always returns a typed schemaVersion/facts/decisions/recommended/risk/proposedWrites', function () {
      const plan = freshMachinePlan();
      assert.strictEqual(plan.schemaVersion, 2);
      assert.strictEqual(typeof plan.facts, 'object');
      assert.ok(Array.isArray(plan.decisions));
      assert.strictEqual(typeof plan.recommended, 'object');
      assert.strictEqual(typeof plan.risk, 'object');
      assert.ok(Array.isArray(plan.proposedWrites));
    });
  });

  describe('fresh machine', function () {
    it('includes every registry decisionId when no global settings exist', function () {
      const plan = freshMachinePlan();
      const ids = plan.decisions.map((d) => d.decisionId).sort();
      assert.deepStrictEqual(ids, [...EXPECTED_DECISION_IDS].sort());
    });

    it('never surfaces a secret anywhere in the plan', function () {
      const plan = freshMachinePlan();
      const serialized = JSON.stringify(plan);
      assert.ok(!/apikey|token|secret/i.test(serialized), serialized);
    });

    it('proposedWrites reference only the canonical settings keys', function () {
      const plan = freshMachinePlan();
      const allowedPaths = new Set([
        'defaultProvider',
        'defaultIsolation',
        'defaultDelivery',
        'defaultIssueSource',
        'dockerMounts',
        'dockerEnvPassthrough',
        'updatePolicy',
        ...PROVIDER_NAMES.map((name) => `providerSettings.${name}`),
      ]);
      assert.ok(plan.proposedWrites.length > 0);
      for (const write of plan.proposedWrites) {
        assert.ok(allowedPaths.has(write.path), `unexpected path: ${write.path}`);
        assert.ok(['global', 'repo'].includes(write.scope));
        assert.ok('from' in write);
        assert.ok('to' in write);
        assert.ok(typeof write.decisionId === 'string');
      }
    });

    it('never proposes a write for a settings key no resolver consumes (no dead writes)', function () {
      const plan = freshMachinePlan();
      // allowLocalNoIsolation/prBase are still valid *decisions* (a future wizard
      // could surface them), but confirmed dead by grep as of #606 — no resolver
      // reads them, so proposing a write for them would advertise a write apply
      // will always skip. Assert every proposedWrites path is one apply will
      // actually perform.
      assert.ok(plan.decisions.some((d) => d.decisionId === 'allowLocalNoIsolation'));
      assert.ok(plan.decisions.some((d) => d.decisionId === 'prBase'));
      assert.ok(!plan.proposedWrites.some((w) => w.decisionId === 'allowLocalNoIsolation'));
      assert.ok(!plan.proposedWrites.some((w) => w.decisionId === 'prBase'));
      for (const write of plan.proposedWrites) {
        assert.ok(
          isConsumedPath(write.scope, write.path),
          `unconsumed path: ${write.scope}:${write.path}`
        );
      }
    });

    it('proposes a providerSettings.<provider> write for every providerLevel decision', function () {
      const plan = freshMachinePlan();
      const providerLevelWrites = plan.proposedWrites.filter((w) =>
        w.decisionId.startsWith('providerLevel.')
      );
      assert.deepStrictEqual(
        providerLevelWrites.map((w) => w.decisionId).sort(),
        PROVIDER_NAMES.map((name) => `providerLevel.${name}`).sort()
      );
      for (const write of providerLevelWrites) {
        const providerName = write.decisionId.slice('providerLevel.'.length);
        assert.strictEqual(write.path, `providerSettings.${providerName}`);
        assert.strictEqual(write.scope, 'global');
        assert.strictEqual(write.from, null);
        assert.deepStrictEqual(write.to, {
          minLevel: 'level1',
          defaultLevel: 'level2',
          maxLevel: 'level3',
        });
      }
    });
  });

  describe('fully configured', function () {
    it('excludes inferable decisionIds and proposes fewer/no writes', function () {
      const plan = fullyConfiguredPlan();
      const ids = plan.decisions.map((d) => d.decisionId);
      assert.ok(!ids.includes('defaultIssueSource'));
      assert.ok(!ids.includes('prBase'));
      assert.strictEqual(plan.decisions.length, 0);
      assert.strictEqual(plan.proposedWrites.length, 0);
    });
  });

  describe('CI / non-TTY', function () {
    it('recommends updatePolicy=off', function () {
      const plan = buildSetupPlan({
        cwd: '/ci/cwd',
        settings: { __meta: { fileExists: true } },
        repoSettings: null,
        env: { CI: 'true', __isTTY: false },
        deps: makeDeps(),
      });
      assert.strictEqual(plan.recommended.updatePolicy, 'off');
    });

    it('recommends updatePolicy=notify for interactive TTY sessions', function () {
      const plan = buildSetupPlan({
        cwd: '/tty/cwd',
        settings: { __meta: { fileExists: true } },
        repoSettings: null,
        env: { __isTTY: true },
        deps: makeDeps(),
      });
      assert.strictEqual(plan.recommended.updatePolicy, 'notify');
    });
  });

  describe('repo vs non-repo cwd', function () {
    it('nulls git branch/remote/ghAuthed and never recommends worktree when not a repo', function () {
      const plan = buildSetupPlan({
        cwd: '/not/a/repo',
        settings: { __meta: { fileExists: true } },
        repoSettings: null,
        env: {},
        deps: makeDeps({
          commandExists: (cmd) => cmd === 'gh',
          checkDocker: () => ({ available: false }),
          execSync: () => {
            throw new Error('not a repo');
          },
        }),
      });
      assert.strictEqual(plan.facts.git.isRepo, false);
      assert.strictEqual(plan.facts.git.branch, null);
      assert.strictEqual(plan.facts.git.remote, null);
      assert.strictEqual(plan.facts.git.ghAuthed, null);
      assert.notStrictEqual(plan.recommended.defaultIsolation, 'worktree');
    });

    it('recommends worktree isolation when cwd is a git repo', function () {
      const plan = fullyConfiguredPlan();
      assert.strictEqual(plan.facts.git.isRepo, true);
      assert.strictEqual(plan.recommended.defaultIsolation, 'worktree');
    });
  });

  describe('decisionId registry snapshot', function () {
    it('matches the exact registry ID set (catches accidental renames)', function () {
      const plan = freshMachinePlan();
      const recommendedIds = new Set(Object.keys(plan.recommended));
      assert.deepStrictEqual(recommendedIds, EXPECTED_DECISION_IDS);
    });
  });

  describe('canonical write paths', function () {
    it('maps isolation and delivery decisions directly to their canonical settings keys', function () {
      const plan = freshMachinePlan();
      const isolationWrites = plan.proposedWrites.filter(
        (w) => w.decisionId === 'defaultIsolation'
      );
      const deliveryWrites = plan.proposedWrites.filter((w) => w.decisionId === 'defaultDelivery');
      assert.ok(isolationWrites.length > 0);
      assert.ok(deliveryWrites.length > 0);
      assert.ok(isolationWrites.every((w) => w.path === 'defaultIsolation'));
      assert.ok(deliveryWrites.every((w) => w.path === 'defaultDelivery'));
      assert.ok(isolationWrites.every((w) => w.to === plan.recommended.defaultIsolation));
    });
  });

  describe('provider default recommendation', function () {
    it('recommends the registry default even when other CLIs are installed but it is not', function () {
      const plan = buildSetupPlan({
        cwd: '/fresh/machine/cwd',
        settings: { __meta: { fileExists: false } },
        repoSettings: null,
        env: {},
        deps: makeDeps({
          commandExists: (cmd) => cmd === 'codex' || cmd === 'gemini',
        }),
      });
      assert.strictEqual(plan.recommended.defaultProvider, 'claude');
      assert.strictEqual(plan.risk.defaultProvider, 'medium');
    });

    it('reports low risk when the registry default CLI is available', function () {
      const plan = buildSetupPlan({
        cwd: '/fresh/machine/cwd',
        settings: { __meta: { fileExists: false } },
        repoSettings: null,
        env: {},
        deps: makeDeps({
          commandExists: (cmd) => cmd === 'claude' || cmd === 'codex' || cmd === 'gemini',
        }),
      });
      assert.strictEqual(plan.recommended.defaultProvider, 'claude');
      assert.strictEqual(plan.risk.defaultProvider, 'low');
    });
  });

  describe('no writes', function () {
    it('never touches the filesystem', function () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-setup-plan-'));
      try {
        const before = fs.readdirSync(tempDir).sort();
        buildSetupPlan({
          cwd: tempDir,
          settings: { __meta: { fileExists: false } },
          repoSettings: null,
          env: {},
          deps: makeDeps(),
        });
        const after = fs.readdirSync(tempDir).sort();
        assert.deepStrictEqual(before, after);
        assert.deepStrictEqual(before, []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
