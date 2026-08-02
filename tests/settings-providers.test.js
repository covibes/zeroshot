const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadSettings,
  mutateSettings,
  validateSetting,
  DEFAULT_SETTINGS,
} = require('../lib/settings');
const {
  validateProviderFeatures,
  validateProviderSettings,
  validateProviderLevel,
} = require('../src/config-validator');
const { getProvider } = require('../src/providers');
const { getDefaultProviderId, normalizeProviderName } = require('../lib/provider-names');

describe('Provider settings', function () {
  const testDir = path.join(os.tmpdir(), `zeroshot-provider-settings-${Date.now()}`);
  const settingsFile = path.join(testDir, 'settings.json');

  before(function () {
    fs.mkdirSync(testDir, { recursive: true });
  });

  after(function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('validates defaultProvider values (including legacy aliases)', function () {
    assert.strictEqual(validateSetting('defaultProvider', 'codex'), null);
    assert.strictEqual(validateSetting('defaultProvider', 'openai'), null);
    assert.strictEqual(validateSetting('defaultProvider', 'opencode'), null);
    const error = validateSetting('defaultProvider', 'invalid-provider');
    assert.ok(error);
  });

  it('validates provider level bounds', function () {
    assert.doesNotThrow(() => {
      validateProviderLevel('codex', 'level2', 'level1', 'level3');
    });

    assert.throws(() => {
      validateProviderLevel('codex', 'level4', 'level1', 'level3');
    }, /Invalid level/);
  });

  it('validates provider overrides and reasoning rules', function () {
    assert.doesNotThrow(() => {
      validateProviderSettings('codex', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides: {
          level1: { model: 'gpt-5.4', reasoningEffort: 'low' },
        },
      });
    });

    assert.doesNotThrow(() => {
      validateProviderSettings('opencode', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides: {
          level2: { reasoningEffort: 'high' },
        },
      });
    });

    assert.doesNotThrow(() => {
      validateProviderSettings('codex', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level3',
        levelOverrides: {
          level3: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
        },
      });
    });

    assert.doesNotThrow(() => {
      validateProviderSettings('claude', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level3',
        levelOverrides: {
          level3: { model: 'claude-opus-4-8', reasoningEffort: 'max' },
        },
      });
    });

    assert.throws(() => {
      validateProviderSettings('gemini', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides: {
          level2: { reasoningEffort: 'high' },
        },
      });
    }, /reasoningEffort overrides are only supported/);
  });

  it('declares strict default-off web search only for Codex and OpenCode', function () {
    assert.strictEqual(getProvider('codex').getDefaultSettings().webSearch, false);
    assert.strictEqual(getProvider('opencode').getDefaultSettings().webSearch, false);
    assert.strictEqual(
      validateSetting('providerSettings', {
        codex: { webSearch: true },
        opencode: { webSearch: false },
      }),
      null
    );
    assert.match(
      validateSetting('providerSettings', { codex: { webSearch: 'yes' } }),
      /providerSettings\.codex\.webSearch must be a boolean/
    );
    assert.match(
      validateSetting('providerSettings', { claude: { webSearch: true } }),
      /Unknown provider setting: providerSettings\.claude\.webSearch/
    );
  });

  it('round-trips web search through settings mutation and reads', function () {
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    fs.writeFileSync(settingsFile, '{}', 'utf8');
    try {
      mutateSettings((settings) => {
        settings.providerSettings.codex.webSearch = true;
        settings.providerSettings.opencode.webSearch = true;
      });
      const settings = loadSettings();
      assert.strictEqual(settings.providerSettings.codex.webSearch, true);
      assert.strictEqual(settings.providerSettings.opencode.webSearch, true);
    } finally {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    }
  });

  it('validates gateway settings and accepts arbitrary model ids', function () {
    assert.doesNotThrow(() => {
      validateProviderSettings('gateway', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: 'gateway-key',
        model: 'openrouter/meta-llama/test',
        toolPolicy: {
          roots: ['.'],
          commands: ['node'],
        },
        levelOverrides: {
          level2: { model: 'openrouter/meta-llama/test' },
        },
      });
    });

    assert.throws(() => {
      validateProviderSettings('gateway', {
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: 'gateway-key',
        model: 'test-model',
        toolPolicy: {
          roots: '.',
          commands: ['node'],
        },
      });
    }, /toolPolicy\.roots must be an array of strings/);
  });

  it('accepts max reasoning effort in agent config for Claude and Codex', function () {
    const settings = loadSettings();
    const result = validateProviderFeatures(
      {
        agents: [
          {
            id: 'claude-worker',
            role: 'implementation',
            provider: 'claude',
            model: 'claude-opus-4-8',
            reasoningEffort: 'max',
          },
          {
            id: 'codex-worker',
            role: 'implementation',
            provider: 'codex',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'max',
          },
        ],
      },
      settings
    );

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.warnings, []);
  });

  it('lists max in invalid reasoning-effort diagnostics', function () {
    const result = validateProviderFeatures(
      {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            provider: 'codex',
            reasoningEffort: 'extreme',
          },
        ],
      },
      loadSettings()
    );

    assert.ok(result.warnings.some((warning) => warning.includes('low|medium|high|xhigh|max')));
  });

  it('validates Anthropic-compatible gateway settings', function () {
    assert.doesNotThrow(() => {
      validateProviderSettings('gateway', {
        protocol: 'anthropic',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'gateway-key',
        model: 'MiniMax-M3',
        maxTokens: 8192,
        toolPolicy: {
          roots: ['.'],
          commands: ['node'],
        },
      });
    });

    assert.throws(() => {
      validateProviderSettings('gateway', {
        protocol: 'anthropic',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'gateway-key',
        model: 'MiniMax-M3',
        toolPolicy: {
          roots: ['.'],
          commands: ['node'],
        },
      });
    }, /maxTokens is required/);
  });

  it('registers the supported MiniMax gateway models', function () {
    const catalog = getProvider('gateway').getModelCatalog();
    assert.deepStrictEqual(catalog['MiniMax-M3'], { rank: 3 });
    assert.deepStrictEqual(catalog['MiniMax-M2.7'], { rank: 2 });
  });

  it('applies legacy maxModel to claude levels', function () {
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    fs.writeFileSync(settingsFile, JSON.stringify({ maxModel: 'haiku' }, null, 2), 'utf8');

    const settings = loadSettings();
    assert.strictEqual(settings.providerSettings.claude.maxLevel, 'level1');
    assert.strictEqual(settings.providerSettings.claude.defaultLevel, 'level1');
  });

  it('uses gpt-5.4 as the default codex model', function () {
    const codex = getProvider('codex');
    const modelSpec = codex.resolveModelSpec(codex.getDefaultLevel(), {});
    assert.strictEqual(modelSpec.model, 'gpt-5.4');
  });

  it('maps claude level3 to opus alias', function () {
    const claude = getProvider('claude');
    const modelSpec = claude.resolveModelSpec('level3', {});
    assert.strictEqual(modelSpec.model, 'opus');
  });

  it('accepts recent canonical Claude model ids', function () {
    const claude = getProvider('claude');
    assert.strictEqual(claude.validateModelId('claude-opus-4-6'), 'claude-opus-4-6');
  });

  it('marks invalid model errors as permanent', function () {
    const claude = getProvider('claude');
    assert.throws(() => {
      try {
        claude.validateModelId('not-a-model');
      } catch (error) {
        assert.strictEqual(error.permanent, true);
        throw error;
      }
    }, /Invalid model "not-a-model"/);
  });

  it('fails before command build when model override is invalid', function () {
    const claude = getProvider('claude');
    assert.throws(() => {
      claude.buildCommand('test context', {
        modelSpec: { model: 'opus-4.6' },
        cliFeatures: { supportsModel: true },
      });
    }, /Invalid model "opus-4.6"/);
  });

  it('resolves defaultProvider to the registry default on a fresh settings load', function () {
    const freshSettingsFile = path.join(testDir, 'fresh-settings.json');
    process.env.ZEROSHOT_SETTINGS_FILE = freshSettingsFile;
    fs.writeFileSync(freshSettingsFile, '{}', 'utf8');
    try {
      const settings = loadSettings();
      assert.strictEqual(settings.defaultProvider, getDefaultProviderId());
    } finally {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    }
  });

  it('restores defaultProvider to the registry default on whole-settings reset', function () {
    const resetSettingsFile = path.join(testDir, 'reset-settings.json');
    process.env.ZEROSHOT_SETTINGS_FILE = resetSettingsFile;
    fs.writeFileSync(
      resetSettingsFile,
      JSON.stringify({ defaultProvider: 'codex' }, null, 2),
      'utf8'
    );
    try {
      mutateSettings((settings) => {
        for (const key of Object.keys(settings)) delete settings[key];
        Object.assign(settings, JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS })));
      });
      const settings = loadSettings();
      assert.strictEqual(settings.defaultProvider, getDefaultProviderId());
    } finally {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    }
  });

  it('recovers legacy provider-less watcher records as Claude even when the registry marker points elsewhere, while fresh lookups follow the marker', async function () {
    // resolveWatcherCommand is the exact function watcher.js and attachable-watcher.js
    // call to resolve a persisted task/watcher record's provider.
    const { resolveWatcherCommand } = await import('../task-lib/watcher-output-runtime.js');
    const { supportsProviderStructuredOutputRecovery } = require('../lib/agent-cli-provider');
    const providerRegistry = require('../lib/agent-cli-provider/provider-registry');

    const originalGetDefaultProviderId = providerRegistry.getDefaultProviderId;
    providerRegistry.getDefaultProviderId = () => 'codex';
    try {
      // Fresh (marker-driven) resolution follows the overridden registry default.
      assert.strictEqual(getDefaultProviderId(), 'codex');

      // A legacy persisted watcher/task record never stored a `provider` field.
      const legacyConfig = {};
      const commandSpec = { binary: 'legacy-binary', args: [], env: {} };
      const { providerName } = resolveWatcherCommand(
        legacyConfig,
        commandSpec,
        [],
        normalizeProviderName
      );

      assert.strictEqual(providerName, 'claude');
      assert.strictEqual(supportsProviderStructuredOutputRecovery(providerName), true);
    } finally {
      providerRegistry.getDefaultProviderId = originalGetDefaultProviderId;
    }
  });
});
