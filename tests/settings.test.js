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

// Test storage directory (isolated)
const TEST_STORAGE_DIR = path.join(os.tmpdir(), 'zeroshot-settings-test-' + Date.now());
const TEST_SETTINGS_FILE = path.join(TEST_STORAGE_DIR, 'settings.json');

let settingsModule;

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
    if (!fs.existsSync(TEST_STORAGE_DIR)) {
      fs.mkdirSync(TEST_STORAGE_DIR, { recursive: true });
    }

    settingsModule = require('../lib/settings');
    Object.defineProperty(settingsModule, 'SETTINGS_FILE', {
      value: TEST_SETTINGS_FILE,
      writable: false,
    });
  });

  after(function () {
    try {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch (e) {
      console.error('Cleanup failed:', e.message);
    }
  });

  beforeEach(function () {
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
});
