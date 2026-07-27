const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClaudeTaskRunner = require('../src/claude-task-runner');
const { loadSettings } = require('../lib/settings');
const { spawnClaudeTaskIsolated } = require('../src/agent/agent-task-executor');
const { ISOLATED_PROVIDER_SETTINGS_ENV } = require('../src/task-run-model-args');

const EXTERNAL_MODEL = 'kimi/kimi-k2-5';
const MISMATCHED_MODEL = 'attacker/other-model';
let settingsDir;
let settingsFile;
let previousSettingsFile;

function writeSettings(value) {
  fs.writeFileSync(settingsFile, JSON.stringify(value));
}

function configuredSettings(model = EXTERNAL_MODEL) {
  return {
    defaultProvider: 'opencode',
    providerSettings: {
      opencode: {
        defaultLevel: 'level2',
        levelOverrides: {
          level2: { model, reasoningEffort: 'high' },
        },
      },
    },
  };
}

function resolveRunnerProviderLevel(model) {
  const runner = new ClaudeTaskRunner({ quiet: true });
  const settings = loadSettings();
  const context = runner._getProviderContext('opencode', settings);
  return runner._resolveModelSpec({
    explicitModelSpec: {
      level: 'level2',
      model,
      reasoningEffort: 'high',
    },
    modelSpecSource: 'provider-level',
    model: null,
    reasoningEffort: null,
    modelLevel: null,
    ...context,
  });
}

before(function () {
  settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opencode-model-trust-'));
  settingsFile = path.join(settingsDir, 'settings.json');
  previousSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
  process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
});

after(function () {
  if (previousSettingsFile === undefined) {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
  } else {
    process.env.ZEROSHOT_SETTINGS_FILE = previousSettingsFile;
  }
  fs.rmSync(settingsDir, { recursive: true, force: true });
});

afterEach(function () {
  delete process.env[ISOLATED_PROVIDER_SETTINGS_ENV];
});

describe('ClaudeTaskRunner provider-level model trust', function () {
  it('accepts a model only when it matches the effective level override', function () {
    writeSettings(configuredSettings());
    assert.strictEqual(resolveRunnerProviderLevel(EXTERNAL_MODEL).model, EXTERNAL_MODEL);

    assert.throws(
      () => resolveRunnerProviderLevel(MISMATCHED_MODEL),
      /does not match the configured level2 model/
    );
  });

  it('rejects claimed external models with empty or nonexistent settings', function () {
    writeSettings({ defaultProvider: 'opencode' });
    assert.throws(
      () => resolveRunnerProviderLevel(EXTERNAL_MODEL),
      /does not match the configured level2 model/
    );

    fs.unlinkSync(settingsFile);
    assert.throws(
      () => resolveRunnerProviderLevel(EXTERNAL_MODEL),
      /does not match the configured level2 model/
    );
  });
});

describe('Child provider command trust boundary', function () {
  it('rejects caller-supplied provenance and keeps direct models strict', function () {
    writeSettings(configuredSettings());
    const { prepareSingleAgentProviderCommand } = require('../task-lib/provider-helper-runtime.js');

    assert.throws(
      () =>
        prepareSingleAgentProviderCommand({
          provider: 'opencode',
          context: 'attacker context',
          modelSpecSource: 'provider-level',
          options: {
            modelSpec: { level: 'level2', model: EXTERNAL_MODEL },
          },
        }),
      /modelSpecSource is not accepted/
    );
    assert.throws(
      () =>
        prepareSingleAgentProviderCommand({
          provider: 'opencode',
          context: 'direct context',
          options: { modelSpec: { model: EXTERNAL_MODEL } },
        }),
      { permanent: true }
    );
  });

  it('keeps non-Opencode direct model validation strict', function () {
    const { prepareSingleAgentProviderCommand } = require('../task-lib/provider-helper-runtime.js');
    assert.throws(
      () =>
        prepareSingleAgentProviderCommand({
          provider: 'codex',
          context: 'direct context',
          options: { modelSpec: { model: 'attacker/external-model' } },
        }),
      { permanent: true }
    );

    process.env[ISOLATED_PROVIDER_SETTINGS_ENV] = JSON.stringify({
      codex: {
        defaultLevel: 'level2',
        levelOverrides: {
          level2: { model: 'attacker/external-model' },
        },
      },
    });
    assert.throws(
      () =>
        prepareSingleAgentProviderCommand({
          provider: 'codex',
          context: 'configured context',
          options: { modelSpec: { level: 'level2' } },
        }),
      { permanent: true }
    );
  });

  it('does not expose the removed configured-model CLI option', function () {
    writeSettings({ autoCheckUpdates: false });
    const result = childProcess.spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'cli', 'index.js'),
        'task',
        'run',
        'test',
        '--configured-model',
        EXTERNAL_MODEL,
      ],
      { encoding: 'utf8', env: { ...process.env, CI: 'true' } }
    );
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /unknown option '--configured-model'/);
  });
});

describe('Docker provider settings trust boundary', function () {
  it('rejects an agent model that does not match the effective settings snapshot', async function () {
    writeSettings({ defaultProvider: 'opencode' });
    let spawnCount = 0;
    const agent = {
      id: 'mismatched-docker',
      config: { outputFormat: 'json', strictSchema: true },
      isolation: {
        enabled: true,
        clusterId: 'test-cluster',
        manager: {
          spawnInContainer() {
            spawnCount += 1;
            throw new Error('must not spawn');
          },
        },
      },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({
        level: 'level2',
        model: EXTERNAL_MODEL,
        reasoningEffort: 'high',
      }),
      _resolveModelSpecSource: () => 'provider-level',
      _log() {},
    };

    await assert.rejects(
      spawnClaudeTaskIsolated(agent, 'test context'),
      /does not match the effective isolated level2 model/
    );
    assert.strictEqual(spawnCount, 0);
  });

  it('rejects ClaudeTaskRunner mismatches before spawning in Docker', async function () {
    writeSettings(configuredSettings());
    let spawnCount = 0;
    const runner = new ClaudeTaskRunner({ quiet: true, timeout: 20 });

    await assert.rejects(
      runner._runIsolated('test context', {
        provider: 'opencode',
        modelSpec: {
          level: 'level2',
          model: MISMATCHED_MODEL,
          reasoningEffort: 'high',
        },
        modelSpecSource: 'provider-level',
        outputFormat: 'json',
        isolation: {
          clusterId: 'test-cluster',
          manager: {
            spawnInContainer() {
              spawnCount += 1;
              throw new Error('must not spawn');
            },
          },
        },
      }),
      /does not match the effective isolated level2 model/
    );
    assert.strictEqual(spawnCount, 0);
  });
});
