const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClaudeTaskRunner = require('../src/claude-task-runner');
const { loadSettings } = require('../lib/settings');
const { LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV } = require('../src/task-run-model-args');

const EXTERNAL_MODEL = 'kimi/kimi-k2-5';
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

function resolveRunnerProviderLevel() {
  const runner = new ClaudeTaskRunner({ quiet: true });
  const settings = loadSettings();
  const context = runner._getProviderContext('opencode', settings);
  return runner._resolveModelSpec({
    explicitModelSpec: null,
    model: null,
    reasoningEffort: null,
    modelLevel: 'level2',
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
  delete process.env[LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV];
});

describe('ClaudeTaskRunner provider-level model trust', function () {
  it('resolves an ordinary configured selection without a source flag', function () {
    writeSettings(configuredSettings());
    assert.strictEqual(resolveRunnerProviderLevel().model, EXTERNAL_MODEL);
  });

  it('runs an ordinary configured external selection without caller provenance', async function () {
    writeSettings(configuredSettings());
    let capturedArgs;
    const runner = new ClaudeTaskRunner({ quiet: true });
    runner._spawnAndGetTaskId = (_command, args) => {
      capturedArgs = args;
      return Promise.resolve('task-test');
    };
    runner._waitForTaskReady = () => Promise.resolve();
    runner._followLogs = () => Promise.resolve({ success: true, output: 'ok', error: null });

    const result = await runner.run('configured task', {
      provider: 'opencode',
      modelLevel: 'level2',
      reasoningEffort: 'high',
      outputFormat: 'json',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      capturedArgs.slice(
        capturedArgs.indexOf('--model-level'),
        capturedArgs.indexOf('--model-level') + 2
      ),
      ['--model-level', 'level2']
    );
    assert.strictEqual(capturedArgs.includes('--model'), false);
  });

  it('rejects a concrete external model even when it equals the configured override', function () {
    writeSettings(configuredSettings());
    const runner = new ClaudeTaskRunner({ quiet: true });
    const settings = loadSettings();
    const context = runner._getProviderContext('opencode', settings);
    assert.throws(
      () =>
        runner._resolveModelSpec({
          explicitModelSpec: { level: 'level2', model: EXTERNAL_MODEL },
          model: null,
          reasoningEffort: null,
          modelLevel: null,
          ...context,
        }),
      { permanent: true }
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

  it('rejects the legacy overlay locally and keeps non-OpenCode models strict', function () {
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

    process.env[LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV] = JSON.stringify({
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
      /is not a trusted settings channel/
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
