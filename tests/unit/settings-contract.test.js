const assert = require('node:assert');

describe('settings CommonJS contract', function () {
  it('preserves the exact export surface, function arities, and dynamic path getter', function () {
    const api = require('../../lib/settings');
    assert.deepStrictEqual(Reflect.ownKeys(api), [
      'loadSettings',
      'mutateSettings',
      'validateSetting',
      'coerceValue',
      'SettingsValidationError',
      'DEFAULT_SETTINGS',
      'getSettingsFile',
      'settingsFileExists',
      'getClaudeCommand',
      'MODEL_HIERARCHY',
      'VALID_MODELS',
      'validateModelAgainstMax',
      'clearProviderDefaultsCache',
      'mapLegacyModelToLevel',
      'SETTINGS_FILE',
    ]);
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(api)
          .filter(([, value]) => typeof value === 'function')
          .map(([key, value]) => [key, value.length])
      ),
      {
        loadSettings: 0,
        mutateSettings: 1,
        validateSetting: 2,
        coerceValue: 2,
        SettingsValidationError: 1,
        getSettingsFile: 0,
        settingsFileExists: 0,
        getClaudeCommand: 0,
        validateModelAgainstMax: 2,
        clearProviderDefaultsCache: 0,
        mapLegacyModelToLevel: 1,
      }
    );
    assert.strictEqual(
      typeof Object.getOwnPropertyDescriptor(api, 'SETTINGS_FILE').get,
      'function'
    );
  });
});
