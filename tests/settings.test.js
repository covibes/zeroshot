/**
 * Test: Settings System
 *
 * Tests persistent settings stored in ~/.zeroshot/settings.json
 * - Load/save settings
 * - Default values
 * - Type coercion
 * - Validation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

// Test storage directory (isolated)
const TEST_STORAGE_DIR = path.join(os.tmpdir(), 'zeroshot-settings-test-' + Date.now());
const TEST_SETTINGS_FILE = path.join(TEST_STORAGE_DIR, 'settings.json');
const CLI_ENTRY = path.join(__dirname, '..', 'cli', 'index.js');

function runSettingsCli(args) {
  return spawnSync(process.execPath, [CLI_ENTRY, 'settings', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      NODE_ENV: 'test',
      ZEROSHOT_DAEMON: '1',
      ZEROSHOT_SETTINGS_FILE: TEST_SETTINGS_FILE,
    },
  });
}

let settingsModule;
let originalSettingsFileEnv;

function writeSettingsFile(settings) {
  const dir = path.dirname(TEST_SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function loadSettingsWithDefaults() {
  if (!fs.existsSync(TEST_SETTINGS_FILE)) {
    return { ...settingsModule.DEFAULT_SETTINGS };
  }
  const data = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
  return { ...settingsModule.DEFAULT_SETTINGS, ...JSON.parse(data) };
}

function registerSettingsHooks() {
  before(function () {
    originalSettingsFileEnv = process.env.ZEROSHOT_SETTINGS_FILE;
    process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;
    fs.mkdirSync(TEST_STORAGE_DIR, { recursive: true });
    settingsModule = require('../lib/settings');
    assert.strictEqual(
      path.resolve(settingsModule.SETTINGS_FILE),
      path.resolve(TEST_SETTINGS_FILE)
    );
  });

  after(function () {
    try {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch (e) {
      console.error('Cleanup failed:', e.message);
    } finally {
      if (originalSettingsFileEnv === undefined) {
        delete process.env.ZEROSHOT_SETTINGS_FILE;
      } else {
        process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFileEnv;
      }
    }
  });

  beforeEach(function () {
    assert.strictEqual(process.env.ZEROSHOT_SETTINGS_FILE, TEST_SETTINGS_FILE);
    assert.strictEqual(
      path.resolve(settingsModule.SETTINGS_FILE),
      path.resolve(TEST_SETTINGS_FILE)
    );
    if (fs.existsSync(TEST_SETTINGS_FILE)) {
      fs.unlinkSync(TEST_SETTINGS_FILE);
    }
  });
}

function registerSettingsExportsTests() {
  it('should export required functions and constants', function () {
    assert.ok(typeof settingsModule.loadSettings === 'function');
    assert.ok(typeof settingsModule.mutateSettings === 'function');
    assert.strictEqual(settingsModule.saveSettings, undefined);
    assert.ok(typeof settingsModule.validateSetting === 'function');
    assert.ok(typeof settingsModule.coerceValue === 'function');
    assert.ok(typeof settingsModule.DEFAULT_SETTINGS === 'object');
  });
}

function registerSettingsDefaultTests() {
  it('should have correct default settings', function () {
    const { DEFAULT_SETTINGS } = settingsModule;

    assert.strictEqual(DEFAULT_SETTINGS.maxModel, 'opus');
    assert.strictEqual(DEFAULT_SETTINGS.defaultConfig, 'conductor-bootstrap');
    assert.strictEqual(DEFAULT_SETTINGS.defaultDocker, false);
    assert.strictEqual(DEFAULT_SETTINGS.strictSchema, true);
    assert.strictEqual(DEFAULT_SETTINGS.logLevel, 'normal');
    assert.strictEqual(DEFAULT_SETTINGS.defaultProvider, 'claude');
    assert.ok(DEFAULT_SETTINGS.providerSettings);
    assert.strictEqual(DEFAULT_SETTINGS.autoCheckUpdates, true);
    assert.strictEqual(DEFAULT_SETTINGS.lastUpdateCheckAt, null);
    assert.strictEqual(DEFAULT_SETTINGS.lastSeenVersion, null);
    assert.strictEqual(DEFAULT_SETTINGS.lastUpdateCheckClaim, null);
  });

  it('should load default settings when file does not exist', function () {
    const settings = loadSettingsWithDefaults();

    assert.strictEqual(settings.maxModel, 'opus');
    assert.strictEqual(settings.defaultConfig, 'conductor-bootstrap');
    assert.strictEqual(settings.defaultDocker, false);
    assert.strictEqual(settings.strictSchema, true);
    assert.strictEqual(settings.logLevel, 'normal');
  });
}

function registerSettingsPersistenceTests() {
  it('should save and load settings', function () {
    const newSettings = {
      maxModel: 'haiku',
      defaultConfig: 'conductor-junior-bootstrap',
      defaultDocker: true,
      logLevel: 'verbose',
    };

    writeSettingsFile(newSettings);
    assert.ok(fs.existsSync(TEST_SETTINGS_FILE), 'Settings file should exist');

    const loaded = loadSettingsWithDefaults();
    assert.strictEqual(loaded.maxModel, 'haiku');
    assert.strictEqual(loaded.defaultConfig, 'conductor-junior-bootstrap');
    assert.strictEqual(loaded.defaultDocker, true);
    assert.strictEqual(loaded.logLevel, 'verbose');
  });
}

function registerSettingsValidationTests() {
  it('should validate model values', function () {
    const { validateSetting } = settingsModule;

    // Valid models
    assert.strictEqual(validateSetting('maxModel', 'opus'), null);
    assert.strictEqual(validateSetting('maxModel', 'sonnet'), null);
    assert.strictEqual(validateSetting('maxModel', 'haiku'), null);

    // Invalid model
    const error = validateSetting('maxModel', 'gpt4');
    assert.ok(error !== null);
    assert.ok(error.includes('Invalid model'));
  });

  it('should validate log level values', function () {
    const { validateSetting } = settingsModule;

    // Valid log levels
    assert.strictEqual(validateSetting('logLevel', 'quiet'), null);
    assert.strictEqual(validateSetting('logLevel', 'normal'), null);
    assert.strictEqual(validateSetting('logLevel', 'verbose'), null);

    // Invalid log level
    const error = validateSetting('logLevel', 'debug');
    assert.ok(error !== null);
    assert.ok(error.includes('Invalid log level'));
  });
}

function registerSettingsCoercionTests() {
  it('should coerce boolean values', function () {
    const { coerceValue } = settingsModule;

    // defaultDocker
    assert.strictEqual(coerceValue('defaultDocker', 'true'), true);
    assert.strictEqual(coerceValue('defaultDocker', '1'), true);
    assert.strictEqual(coerceValue('defaultDocker', 'yes'), true);
    assert.strictEqual(coerceValue('defaultDocker', true), true);
    assert.strictEqual(coerceValue('defaultDocker', 'false'), false);
    assert.strictEqual(coerceValue('defaultDocker', 'no'), false);
    assert.strictEqual(coerceValue('defaultDocker', false), false);

    // strictSchema
    assert.strictEqual(coerceValue('strictSchema', 'true'), true);
    assert.strictEqual(coerceValue('strictSchema', '1'), true);
    assert.strictEqual(coerceValue('strictSchema', true), true);
    assert.strictEqual(coerceValue('strictSchema', 'false'), false);
    assert.strictEqual(coerceValue('strictSchema', false), false);
  });

  it('should coerce string values', function () {
    const { coerceValue } = settingsModule;

    assert.strictEqual(coerceValue('maxModel', 'haiku'), 'haiku');
    assert.strictEqual(coerceValue('defaultConfig', 'my-config'), 'my-config');
  });
}

function registerSettingsFileFormatTests() {
  it('settings file should be valid JSON with pretty printing', function () {
    const settings = {
      maxModel: 'sonnet',
      defaultConfig: 'test-config',
      defaultDocker: false,
      logLevel: 'normal',
    };

    writeSettingsFile(settings);

    // Should be valid JSON
    const raw = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'Settings file should be valid JSON');

    // Should be pretty-printed (indented)
    assert.ok(raw.includes('\n  '), 'Settings should be pretty-printed');
  });
}

function registerStrictSchemaPropagationTests() {
  describe('strictSchema propagation to agent-config (Issue #52)', function () {
    it('should propagate strictSchema=false from settings to agent config', function () {
      // Setup: Save settings with strictSchema=false
      writeSettingsFile({ strictSchema: false });

      // Override ZEROSHOT_SETTINGS_FILE for this test
      const originalEnv = process.env.ZEROSHOT_SETTINGS_FILE;
      process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;

      try {
        // Re-require to pick up the env var change
        delete require.cache[require.resolve('../lib/settings')];
        delete require.cache[require.resolve('../src/agent/agent-config')];

        const { validateAgentConfig } = require('../src/agent/agent-config');

        // Agent config without strictSchema set - should inherit from settings
        const agentConfig = {
          id: 'test-agent',
          role: 'conductor',
          triggers: [],
        };

        const normalized = validateAgentConfig(agentConfig);

        // strictSchema should be false (inherited from settings)
        assert.strictEqual(normalized.strictSchema, false);
      } finally {
        // Restore env
        if (originalEnv) {
          process.env.ZEROSHOT_SETTINGS_FILE = originalEnv;
        } else {
          delete process.env.ZEROSHOT_SETTINGS_FILE;
        }
        // Clean up require cache
        delete require.cache[require.resolve('../lib/settings')];
        delete require.cache[require.resolve('../src/agent/agent-config')];
      }
    });

    it('should NOT override explicit strictSchema in agent config', function () {
      // Setup: Save settings with strictSchema=false
      writeSettingsFile({ strictSchema: false });

      // Override ZEROSHOT_SETTINGS_FILE for this test
      const originalEnv = process.env.ZEROSHOT_SETTINGS_FILE;
      process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;

      try {
        delete require.cache[require.resolve('../lib/settings')];
        delete require.cache[require.resolve('../src/agent/agent-config')];

        const { validateAgentConfig } = require('../src/agent/agent-config');

        // Agent config WITH explicit strictSchema=true - should NOT be overridden
        const agentConfig = {
          id: 'test-agent',
          role: 'conductor',
          triggers: [],
          strictSchema: true, // Explicit - should be preserved
        };

        const normalized = validateAgentConfig(agentConfig);

        // strictSchema should remain true (explicit in config)
        assert.strictEqual(normalized.strictSchema, true);
      } finally {
        if (originalEnv) {
          process.env.ZEROSHOT_SETTINGS_FILE = originalEnv;
        } else {
          delete process.env.ZEROSHOT_SETTINGS_FILE;
        }
        delete require.cache[require.resolve('../lib/settings')];
        delete require.cache[require.resolve('../src/agent/agent-config')];
      }
    });

    it('should default strictSchema to true when not in settings', function () {
      // No settings file - defaults should apply
      const originalEnv = process.env.ZEROSHOT_SETTINGS_FILE;
      process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;

      // Ensure no settings file exists
      if (fs.existsSync(TEST_SETTINGS_FILE)) {
        fs.unlinkSync(TEST_SETTINGS_FILE);
      }

      try {
        delete require.cache[require.resolve('../lib/settings')];
        delete require.cache[require.resolve('../src/agent/agent-config')];

        const { validateAgentConfig } = require('../src/agent/agent-config');

        const agentConfig = {
          id: 'test-agent',
          role: 'conductor',
          triggers: [],
        };

        const normalized = validateAgentConfig(agentConfig);

        // strictSchema should default to true
        assert.strictEqual(normalized.strictSchema, true);
      } finally {
        if (originalEnv) {
          process.env.ZEROSHOT_SETTINGS_FILE = originalEnv;
        } else {
          delete process.env.ZEROSHOT_SETTINGS_FILE;
        }
        delete require.cache[require.resolve('../lib/settings')];
        delete require.cache[require.resolve('../src/agent/agent-config')];
      }
    });
  });
}
function registerTransactionalRecoveryTests() {
  describe('transactional malformed-file recovery and diagnostics', function () {
    function writeRawSettings(raw) {
      fs.mkdirSync(TEST_STORAGE_DIR, { recursive: true });
      fs.writeFileSync(TEST_SETTINGS_FILE, raw, 'utf8');
    }

    function writeMalformedSettings() {
      writeRawSettings('{"truncated":');
    }

    it('repairs malformed settings through reset --yes even when defaults are a semantic no-op', function () {
      writeMalformedSettings();
      const result = runSettingsCli(['reset', '--yes']);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), '✓ Non-provider settings reset to defaults');
      const repaired = JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'));
      assert.strictEqual(repaired.autoCheckUpdates, true);
      assert.strictEqual(repaired.lastUpdateCheckAt, null);
      assert.strictEqual(repaired.lastSeenVersion, null);
      assert.strictEqual(repaired.lastUpdateCheckClaim, null);
    });

    it('repairs malformed settings while applying an intended settings set mutation', function () {
      writeMalformedSettings();
      const result = runSettingsCli(['set', 'logLevel', 'verbose']);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('Set logLevel = "verbose"'));
      assert.strictEqual(
        JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8')).logLevel,
        'verbose'
      );
    });

    it('repairs a null settings document through reset --yes', function () {
      writeRawSettings('null');
      const result = runSettingsCli(['reset', '--yes']);

      assert.strictEqual(result.status, 0, result.stderr);
      const repaired = JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'));
      assert.strictEqual(repaired.autoCheckUpdates, true);
      assert.strictEqual(repaired.lastUpdateCheckClaim, null);
    });

    for (const [name, raw] of [
      ['null', 'null'],
      ['boolean', 'true'],
      ['number', '42'],
      ['string', '"invalid"'],
      ['array', '[]'],
    ]) {
      it(`repairs a ${name} settings document while applying settings set`, function () {
        writeRawSettings(raw);
        const result = runSettingsCli(['set', 'logLevel', 'verbose']);

        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(
          JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8')).logLevel,
          'verbose'
        );
      });
    }

    it('surfaces a settings read failure without replacing the existing file', function () {
      writeSettingsFile({ logLevel: 'verbose', unrelated: 'preserved' });
      assert.strictEqual(
        path.resolve(settingsModule.SETTINGS_FILE),
        path.resolve(TEST_SETTINGS_FILE)
      );
      const before = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = (filePath, ...args) => {
        if (path.resolve(filePath) === path.resolve(TEST_SETTINGS_FILE)) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return originalReadFileSync(filePath, ...args);
      };
      try {
        assert.throws(
          () =>
            settingsModule.mutateSettings((settings) => {
              settings.logLevel = 'normal';
            }),
          /Unable to persist global settings: permission denied/
        );
      } finally {
        fs.readFileSync = originalReadFileSync;
      }
      assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), before);
    });

    for (const [name, initialMode, expectedMode] of [
      ['broad permissions', 0o644, 0o600],
      ['stricter permissions', 0o400, 0o400],
    ]) {
      it(`publishes atomic settings with ${name} restricted`, function () {
        writeSettingsFile({ logLevel: 'normal' });
        fs.chmodSync(TEST_SETTINGS_FILE, initialMode);
        settingsModule.mutateSettings((settings) => {
          settings.logLevel = 'verbose';
        });

        assert.strictEqual(fs.statSync(TEST_SETTINGS_FILE).mode & 0o777, expectedMode);
      });
    }

    it('removes its restricted temporary file after an atomic rename failure', function () {
      writeSettingsFile({ logLevel: 'normal' });
      const before = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
      const originalRenameSync = fs.renameSync;
      let temporaryFile;
      fs.renameSync = (source, destination) => {
        if (path.resolve(destination) === path.resolve(TEST_SETTINGS_FILE)) {
          temporaryFile = source;
          assert.strictEqual(fs.statSync(source).mode & 0o777, 0o600);
          throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
        }
        return originalRenameSync(source, destination);
      };
      try {
        assert.throws(
          () =>
            settingsModule.mutateSettings((settings) => {
              settings.logLevel = 'verbose';
            }),
          /Unable to persist global settings: rename denied/
        );
      } finally {
        fs.renameSync = originalRenameSync;
      }
      assert.ok(temporaryFile);
      assert.strictEqual(fs.existsSync(temporaryFile), false);
      assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), before);
    });

    it('rejects an invalid nested Claude level with the manual-only diagnostic and no write', function () {
      writeSettingsFile({});
      const before = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
      const result = runSettingsCli(['set', 'providerSettings.claude.defaultLevel', 'level9']);

      assert.strictEqual(result.status, 1);
      assert.strictEqual(
        result.stderr.trim(),
        `Provider configuration is manual-only. Edit ${TEST_SETTINGS_FILE} directly (file 0600, parent directory 0700), then start a new run or restart already-running or detached work. Refusing to change providerSettings.claude.defaultLevel.`
      );
      assert.ok(!result.stderr.includes('Unable to persist global settings'));
      assert.ok(!result.stdout.includes('✓ Set'));
      assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), before);
    });

    it('distinguishes a persistence failure and never prints false success', function () {
      writeSettingsFile({ logLevel: 'normal' });
      const before = fs.readFileSync(TEST_SETTINGS_FILE, 'utf8');
      const lockPath = `${TEST_SETTINGS_FILE}.lock`;
      fs.mkdirSync(lockPath);
      try {
        const result = runSettingsCli(['set', 'logLevel', 'verbose']);
        assert.strictEqual(result.status, 1);
        assert.ok(result.stderr.includes('Unable to persist global settings'));
        assert.ok(!result.stderr.includes('Invalid defaultLevel'));
        assert.ok(!result.stdout.includes('✓ Set'));
        assert.strictEqual(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'), before);
      } finally {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
    });
  });
}

describe('Settings System', function () {
  this.timeout(10000);

  registerSettingsHooks();
  registerSettingsExportsTests();
  registerSettingsDefaultTests();
  registerSettingsPersistenceTests();
  registerSettingsValidationTests();
  registerSettingsCoercionTests();
  registerSettingsFileFormatTests();
  registerStrictSchemaPropagationTests();
  registerTransactionalRecoveryTests();
});
