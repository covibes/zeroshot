/**
 * Test: `zeroshot setup apply` (lib/setup-apply.js)
 *
 * Verifies the issue #606 contract:
 * - Fail-closed validation (unknown decisionId / out-of-domain value -> zero writes)
 * - Idempotent re-apply (second run is a no-op)
 * - Writes confined to global settings, .zeroshot/settings.json, and the undo journal
 * - Dead settings keys (no consumer) are refused, not written
 * - No secret-shaped path is ever written
 * - defaultDelivery=ship requires explicit opt-in and is then live in startClusterFromText
 * - github issue-source hint prints a login command instead of storing anything
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { VALID_PROVIDERS } = require('../../lib/provider-names');

const settingsPath = require.resolve('../../lib/settings');
const setupApplyPath = require.resolve('../../lib/setup-apply');
const setupUndoPath = require.resolve('../../lib/setup-undo');
const setupJournalPath = require.resolve('../../lib/setup-journal');
const repoSettingsPath = require.resolve('../../lib/repo-settings');

describe('setup-apply', function () {
  this.timeout(15000);

  it('preserves the CommonJS API contract', function () {
    const setupApply = require('../../lib/setup-apply');
    assert.deepStrictEqual(Reflect.ownKeys(setupApply), [
      'applyDecisions',
      'applyDecisionValues',
      'resolveAndValidateDecisions',
      'writeResolvedDecisions',
      'assertSecretSafePath',
      'isConsumedPath',
      'CONSUMED_PATHS',
    ]);
  });

  let TEST_DIR;
  let TEST_SETTINGS_FILE;
  let TEST_JOURNAL_FILE;
  let repoRoot;
  let settingsModule;
  let applyModule;
  let startClusterModule;

  function decisionsFile(obj) {
    const p = path.join(TEST_DIR, 'decisions.json');
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
  }

  function readSettings() {
    return JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'));
  }

  function readJournal() {
    return JSON.parse(fs.readFileSync(TEST_JOURNAL_FILE, 'utf8'));
  }

  beforeEach(function () {
    TEST_DIR = path.join(
      os.tmpdir(),
      'zeroshot-setup-apply-test-' + crypto.randomBytes(8).toString('hex')
    );
    fs.mkdirSync(TEST_DIR, { recursive: true });
    TEST_SETTINGS_FILE = path.join(TEST_DIR, 'settings.json');
    TEST_JOURNAL_FILE = path.join(TEST_DIR, 'setup-undo-journal.json');

    repoRoot = path.join(TEST_DIR, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    execSync('git init', { cwd: repoRoot, stdio: 'ignore' });

    process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;
    delete require.cache[settingsPath];
    delete require.cache[setupApplyPath];
    delete require.cache[setupUndoPath];
    delete require.cache[setupJournalPath];
    delete require.cache[repoSettingsPath];

    settingsModule = require('../../lib/settings');
    applyModule = require('../../lib/setup-apply');
    startClusterModule = require('../../lib/start-cluster');
  });

  afterEach(function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('applies a valid decisions file and writes settings + journal', function () {
    const results = applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultProvider: 'codex' }),
      cwd: repoRoot,
    });

    assert.deepStrictEqual(results, [
      { decisionId: 'defaultProvider', applied: true, from: 'claude', to: 'codex' },
    ]);
    assert.strictEqual(readSettings().defaultProvider, 'codex');
    const journal = readJournal();
    assert.strictEqual(journal.entries.length, 1);
    assert.strictEqual(journal.entries[0].priorValue, 'claude');
    assert.strictEqual(journal.entries[0].appliedValue, 'codex');
  });

  it('applies an in-memory decision object without reading a file', function () {
    const results = applyModule.applyDecisionValues({
      decisions: { defaultProvider: 'codex' },
      cwd: repoRoot,
      deps: {
        readFile: () => assert.fail('object apply must not read a decisions file'),
      },
    });

    assert.strictEqual(results[0].applied, true);
    assert.strictEqual(readSettings().defaultProvider, 'codex');
  });

  it('stores defaultIsolation without boolean translation', function () {
    const results = applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultIsolation: 'worktree' }),
      cwd: repoRoot,
    });

    assert.deepStrictEqual(results, [
      { decisionId: 'defaultIsolation', applied: true, from: 'none', to: 'worktree' },
    ]);
    assert.strictEqual(readSettings().defaultIsolation, 'worktree');
    assert.strictEqual(readSettings().defaultDocker, undefined);
  });

  it('is idempotent: applying identical decisions twice writes only on the first run', function () {
    const decisions = decisionsFile({ defaultProvider: 'codex', defaultDelivery: 'pr' });

    applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot });
    const settingsAfterFirst = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
    const journalAfterFirst = fs.readFileSync(TEST_JOURNAL_FILE, 'utf8');

    const secondResults = applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot });

    assert.ok(secondResults.every((r) => r.applied === false && r.skippedReason === 'unchanged'));
    assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), settingsAfterFirst);
    assert.strictEqual(fs.readFileSync(TEST_JOURNAL_FILE, 'utf8'), journalAfterFirst);
    assert.strictEqual(JSON.parse(journalAfterFirst).entries.length, 2);
  });

  it('rejects an unknown decision ID without writing anything', function () {
    const decisions = decisionsFile({ bogusDecisionId: 'value' });
    assert.throws(
      () => applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot }),
      /Unknown decision ID: bogusDecisionId/
    );
    assert.ok(!fs.existsSync(TEST_SETTINGS_FILE));
    assert.ok(!fs.existsSync(TEST_JOURNAL_FILE));
  });

  it('rejects an out-of-domain value without writing anything', function () {
    const decisions = decisionsFile({ defaultProvider: 'not-a-real-provider' });
    assert.throws(
      () => applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot }),
      /Invalid value for decision "defaultProvider"/
    );
    assert.ok(!fs.existsSync(TEST_SETTINGS_FILE));
  });

  it('rejects a mixed request (one valid, one invalid decision) atomically', function () {
    const decisions = decisionsFile({
      defaultProvider: 'codex',
      defaultDelivery: 'not-a-real-delivery',
    });
    assert.throws(() => applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot }));
    assert.ok(!fs.existsSync(TEST_SETTINGS_FILE));
  });

  it('refuses to write dead settings keys (no consumer), reporting skippedReason "no-consumer"', function () {
    const decisions = decisionsFile({ allowLocalNoIsolation: true, prBase: 'main' });
    const results = applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot });

    assert.deepStrictEqual(
      results.map((r) => ({
        decisionId: r.decisionId,
        applied: r.applied,
        skippedReason: r.skippedReason,
      })),
      [
        { decisionId: 'allowLocalNoIsolation', applied: false, skippedReason: 'no-consumer' },
        { decisionId: 'prBase', applied: false, skippedReason: 'no-consumer' },
      ]
    );
    assert.ok(!fs.existsSync(TEST_SETTINGS_FILE));
    assert.ok(!fs.existsSync(path.join(repoRoot, '.zeroshot', 'settings.json')));
  });

  it('the secret-shaped path guard throws for a fabricated secret path', function () {
    assert.throws(
      () => applyModule.assertSecretSafePath('providerSettings.claude.apiKey'),
      /Refusing to write secret-shaped settings path/
    );
    assert.doesNotThrow(() => applyModule.assertSecretSafePath('defaultProvider'));
  });

  it('skips storing defaultDelivery=ship without --allow-risky-defaults', function () {
    const decisions = decisionsFile({ defaultDelivery: 'ship' });
    const results = applyModule.applyDecisions({
      decisionsPath: decisions,
      cwd: repoRoot,
      allowRiskyDefaults: false,
    });

    assert.deepStrictEqual(results, [
      {
        decisionId: 'defaultDelivery',
        applied: false,
        from: 'none',
        to: 'ship',
        skippedReason: 'requires-explicit-opt-in',
      },
    ]);
    assert.ok(!fs.existsSync(TEST_SETTINGS_FILE));
  });

  it('stores defaultDelivery=ship with --allow-risky-defaults and it is live in startClusterFromText', function () {
    const decisions = decisionsFile({ defaultDelivery: 'ship' });
    const results = applyModule.applyDecisions({
      decisionsPath: decisions,
      cwd: repoRoot,
      allowRiskyDefaults: true,
    });

    assert.strictEqual(results[0].applied, true);
    const settings = settingsModule.loadSettings();
    assert.strictEqual(settings.defaultDelivery, 'ship');

    const startOptions = startClusterModule.startClusterFromText({
      orchestrator: {
        start(_config, _input, options) {
          return options;
        },
      },
      config: { agents: [] },
      clusterId: 'c1',
      text: 'hello',
      options: {},
      settings,
    });
    assert.strictEqual(startOptions.autoPr, true);
    assert.strictEqual(startOptions.autoMerge, true);
    assert.strictEqual(startOptions.worktree, true);
  });

  it('confines writes to global settings, repo .zeroshot/settings.json, and the undo journal', function () {
    const decisions = decisionsFile({ defaultProvider: 'codex', dockerMounts: ['gh'] });
    const before = new Set(fs.readdirSync(TEST_DIR));
    applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot });

    const after = fs.readdirSync(TEST_DIR);
    const added = after.filter((f) => !before.has(f));
    assert.deepStrictEqual(new Set(added), new Set(['settings.json', 'setup-undo-journal.json']));

    // No decision in this request is repo-scoped and consumed today, so the repo dir
    // must be untouched (still just the bare git repo, no .zeroshot directory).
    assert.ok(!fs.existsSync(path.join(repoRoot, '.zeroshot')));
  });

  it('prints a login command and stores nothing when applying defaultIssueSource=github unauthenticated', function () {
    // Default settings already default to defaultIssueSource='github', so start
    // from a different value to force an actual write (not a no-op 'unchanged').
    settingsModule.mutateSettings((settings) => {
      settings.defaultIssueSource = 'gitlab';
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const decisions = decisionsFile({ defaultIssueSource: 'github' });
      applyModule.applyDecisions({
        decisionsPath: decisions,
        cwd: repoRoot,
        deps: { checkGhAuth: () => ({ authenticated: false }) },
      });
    } finally {
      console.log = originalLog;
    }

    assert.ok(logs.some((line) => line.includes('gh auth login')));
    const settings = readSettings();
    assert.strictEqual(settings.defaultIssueSource, 'github');
    for (const key of Object.keys(settings)) {
      assert.ok(
        !/token|secret|password|api[_-]?key|credential/i.test(key) || settings[key] === null
      );
    }
  });

  it('does not print a login hint when already gh-authenticated', function () {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const decisions = decisionsFile({ defaultIssueSource: 'github' });
      applyModule.applyDecisions({
        decisionsPath: decisions,
        cwd: repoRoot,
        deps: { checkGhAuth: () => ({ authenticated: true }) },
      });
    } finally {
      console.log = originalLog;
    }

    assert.ok(!logs.some((line) => line.includes('gh auth login')));
  });

  it('round-trips canonical levels for every registry provider', function () {
    const providerDecisions = Object.fromEntries(
      VALID_PROVIDERS.map((provider) => [
        `providerLevel.${provider}`,
        { minLevel: 'level1', defaultLevel: 'level2', maxLevel: 'level3' },
      ])
    );
    applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultIsolation: 'worktree', ...providerDecisions }),
      cwd: repoRoot,
    });

    const settings = readSettings();
    for (const provider of VALID_PROVIDERS) {
      assert.strictEqual(settings.providerSettings[provider].minLevel, 'level1');
      assert.strictEqual(settings.providerSettings[provider].defaultLevel, 'level2');
      assert.strictEqual(settings.providerSettings[provider].maxLevel, 'level3');
    }
  });

  for (const [name, value] of [
    ['unknown key', { minLevel: 'level1', defaultLevel: 'level2', maxLevel: 'level3', model: 'x' }],
    ['invalid level', { minLevel: 'level0', defaultLevel: 'level2', maxLevel: 'level3' }],
    ['invalid ordering', { minLevel: 'level2', defaultLevel: 'level1', maxLevel: 'level3' }],
  ]) {
    it(`rejects provider levels with ${name}`, function () {
      const decisions = decisionsFile({ 'providerLevel.codex': value });
      assert.throws(() => applyModule.applyDecisions({ decisionsPath: decisions, cwd: repoRoot }));
      assert.ok(!fs.existsSync(TEST_SETTINGS_FILE));
    });
  }
});
