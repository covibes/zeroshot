/**
 * Test: `zeroshot setup undo` (lib/setup-undo.js)
 *
 * Verifies the three-way conflict rule from issue #606:
 * - current === appliedValue  -> restore priorValue (delete if null)
 * - current === priorValue    -> already-restored (no-op)
 * - otherwise (changed since apply) -> skipped-modified, never clobbered
 * - undo is idempotent
 * - full round trip: plan -> apply -> undo returns settings to exact pre-apply bytes
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const settingsPath = require.resolve('../../lib/settings');
const setupApplyPath = require.resolve('../../lib/setup-apply');
const setupUndoPath = require.resolve('../../lib/setup-undo');
const setupJournalPath = require.resolve('../../lib/setup-journal');
const repoSettingsPath = require.resolve('../../lib/repo-settings');

describe('setup-undo', function () {
  this.timeout(15000);

  it('preserves the CommonJS API contract', function () {
    const setupUndo = require('../../lib/setup-undo');
    assert.deepStrictEqual(Reflect.ownKeys(setupUndo), ['undo']);
    assert.strictEqual(setupUndo.undo.length, 0);
  });

  let TEST_DIR;
  let TEST_SETTINGS_FILE;
  let repoRoot;
  let applyModule;
  let undoModule;

  function decisionsFile(obj) {
    const p = path.join(TEST_DIR, 'decisions.json');
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
  }

  function readSettings() {
    return JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'));
  }

  beforeEach(function () {
    TEST_DIR = path.join(
      os.tmpdir(),
      'zeroshot-setup-undo-test-' + crypto.randomBytes(8).toString('hex')
    );
    fs.mkdirSync(TEST_DIR, { recursive: true });
    TEST_SETTINGS_FILE = path.join(TEST_DIR, 'settings.json');

    repoRoot = path.join(TEST_DIR, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    execSync('git init', { cwd: repoRoot, stdio: 'ignore' });

    process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;
    delete require.cache[settingsPath];
    delete require.cache[setupApplyPath];
    delete require.cache[setupUndoPath];
    delete require.cache[setupJournalPath];
    delete require.cache[repoSettingsPath];

    applyModule = require('../../lib/setup-apply');
    undoModule = require('../../lib/setup-undo');
  });

  afterEach(function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('restores priorValue for a key unmodified since apply', function () {
    applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultProvider: 'codex' }),
      cwd: repoRoot,
    });
    assert.strictEqual(readSettings().defaultProvider, 'codex');

    const results = undoModule.undo({});
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].status, 'restored');
    assert.strictEqual(readSettings().defaultProvider, 'claude');
  });

  it('deletes the key when priorValue is null (key did not exist before apply)', function () {
    // A journaled write whose key did not exist pre-apply (priorValue: null) —
    // built directly against the journal file, since a real apply of a key that
    // did not previously exist is not reachable via any currently-consumed
    // decisionId (every consumed settings key already has a default value).
    const settings = { defaultProvider: 'claude', syntheticNewKey: 'created-by-apply' };
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(settings, null, 2));

    const journalPath = path.join(TEST_DIR, 'setup-undo-journal.json');
    fs.writeFileSync(
      journalPath,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              scope: 'global',
              path: 'syntheticNewKey',
              repoRoot: null,
              priorValue: null,
              appliedValue: 'created-by-apply',
              appliedAt: new Date(0).toISOString(),
            },
          ],
        },
        null,
        2
      )
    );

    const results = undoModule.undo({});
    const syntheticResult = results.find((r) => r.path === 'syntheticNewKey');
    assert.strictEqual(syntheticResult.status, 'deleted');
    assert.strictEqual('syntheticNewKey' in readSettings(), false);
  });

  it('skips (never clobbers) a key changed externally since apply, reporting skipped-modified', function () {
    applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultProvider: 'codex' }),
      cwd: repoRoot,
    });

    // External tooling changes the same key after apply, before undo runs.
    const settings = readSettings();
    settings.defaultProvider = 'gemini';
    fs.writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(settings, null, 2));

    const results = undoModule.undo({});
    assert.strictEqual(results[0].status, 'skipped-modified');
    assert.strictEqual(results[0].current, 'gemini');
    assert.strictEqual(results[0].wouldRestore, 'claude');
    // Must NOT clobber the externally-set value.
    assert.strictEqual(readSettings().defaultProvider, 'gemini');
  });

  it('is idempotent: running undo twice reports already-restored on the second run with no writes', function () {
    applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultProvider: 'codex', defaultDelivery: 'pr' }),
      cwd: repoRoot,
    });

    const first = undoModule.undo({});
    assert.ok(first.every((r) => r.status === 'restored'));
    const settingsAfterFirstUndo = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');

    const second = undoModule.undo({});
    assert.ok(second.every((r) => r.status === 'already-restored'));
    assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), settingsAfterFirstUndo);
  });

  it('full round trip: plan -> apply -> undo returns global settings to exact pre-apply bytes', function () {
    const { buildSetupPlan } = require('../../lib/setup-plan');
    const { loadSettings, mutateSettings, settingsFileExists } = require('../../lib/settings');
    const { readRepoSettings } = require('../../lib/repo-settings');

    // Establish a concrete pre-apply settings file (simulates a user who has
    // already customized some settings before ever running `setup apply`).
    // logLevel has no cascading normalization on load/save, unlike maxModel
    // (which recomputes providerSettings.claude.maxLevel on every loadSettings()
    // call) - picking it keeps this test isolated to the apply/undo round trip.
    const preExisting = loadSettings();
    preExisting.logLevel = 'verbose';
    mutateSettings((settings) => {
      Object.assign(settings, preExisting);
    });
    const preApplyBytes = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');

    const cwd = repoRoot;
    const settings = loadSettings();
    settings.__meta = { fileExists: settingsFileExists() };
    const { settings: repoSettings } = readRepoSettings(cwd);
    const plan = buildSetupPlan({
      cwd,
      settings,
      repoSettings,
      env: { ...process.env, __isTTY: false },
    });
    assert.ok(plan.schemaVersion);

    applyModule.applyDecisions({
      decisionsPath: decisionsFile({ defaultProvider: 'codex', defaultDelivery: 'pr' }),
      cwd: repoRoot,
    });
    assert.notStrictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), preApplyBytes);

    undoModule.undo({});

    assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), preApplyBytes);
  });
});
