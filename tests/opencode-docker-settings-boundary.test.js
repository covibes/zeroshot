const assert = require('node:assert');
const childProcess = require('node:child_process');
const { spawnClaudeTaskIsolated } = require('../src/agent/agent-task-executor');
const {
  ISOLATED_SETTINGS_FILE_ENV,
  ISOLATED_SETTINGS_FILE_MARKER,
  LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV,
  wrapTaskRunWithIsolatedSettings,
} = require('../src/task-run-model-args');

const EXTERNAL_MODEL = 'kimi/kimi-k2-5';
const MISMATCHED_MODEL = 'attacker/other-model';

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

describe('Docker provider settings trust boundary', function () {
  it('rejects an agent model that does not match the effective settings snapshot', async function () {
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

  it('rejects empty and mismatched snapshots before spawning', function () {
    const command = ['zeroshot', 'task', 'run'];
    for (const settings of [{}, configuredSettings(MISMATCHED_MODEL)]) {
      assert.throws(
        () =>
          wrapTaskRunWithIsolatedSettings(command, {
            providerName: 'opencode',
            settings,
            modelSpecSource: 'provider-level',
            modelSpec: { level: 'level2', model: EXTERNAL_MODEL },
          }),
        /does not match the effective isolated level2 model/
      );
    }
  });

  it('transports only the requested level and model, never arbitrary settings or secrets', function () {
    const settings = configuredSettings();
    settings.providerSettings.opencode.apiKey = 'secret-opencode-key';
    settings.providerSettings.opencode.unknown = { nested: true };
    settings.providerSettings.codex = { apiKey: 'secret-codex-key' };
    settings.unknownRoot = 'not-transported';

    const wrapped = wrapTaskRunWithIsolatedSettings(
      ['zeroshot', 'task', 'run', '--model-level', 'level2'],
      {
        providerName: 'opencode',
        settings,
        modelSpecSource: 'provider-level',
        modelSpec: {
          level: 'level2',
          model: EXTERNAL_MODEL,
          reasoningEffort: 'high',
        },
      }
    );
    assert.deepStrictEqual(JSON.parse(wrapped[3]), {
      providerSettings: {
        opencode: {
          levelOverrides: {
            level2: { model: EXTERNAL_MODEL },
          },
        },
      },
    });
    assert.strictEqual(wrapped.join(' ').includes('secret-'), false);
    assert.strictEqual(wrapped.join(' ').includes('unknown'), false);
  });

  it('stages a legitimate minimal snapshot through the temporary settings file', function () {
    const readSettingsScript = String.raw`
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(process.env.ZEROSHOT_SETTINGS_FILE, 'utf8'));
`.trim();
    const wrapped = wrapTaskRunWithIsolatedSettings(['node', '-e', readSettingsScript], {
      providerName: 'opencode',
      settings: configuredSettings(),
      modelSpecSource: 'provider-level',
      modelSpec: { level: 'level2', model: EXTERNAL_MODEL },
    });
    const result = childProcess.spawnSync(wrapped[0], wrapped.slice(1), { encoding: 'utf8' });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      providerSettings: {
        opencode: {
          levelOverrides: {
            level2: { model: EXTERNAL_MODEL },
          },
        },
      },
    });
  });

  it('strips the isolated settings path and markers before the provider watcher', async function () {
    const { buildWatcherEnv } = await import('../task-lib/runner.js');
    const env = buildWatcherEnv({
      KEEP_ME: 'yes',
      [ISOLATED_SETTINGS_FILE_ENV]: '/tmp/private-settings.json',
      [ISOLATED_SETTINGS_FILE_MARKER]: '1',
      [LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV]: '{"spoofed":true}',
    });
    assert.deepStrictEqual(env, { KEEP_ME: 'yes' });
  });
});
