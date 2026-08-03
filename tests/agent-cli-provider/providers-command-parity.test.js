const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const helper = require('../../lib/agent-cli-provider');

const providersModulePath = require.resolve('../../src/providers');
const settingsModulePath = require.resolve('../../lib/settings');
const commandModulePath = require.resolve('../../cli/commands/providers');

const originalProvidersModule = require(providersModulePath);
const originalSettingsModule = require(settingsModulePath);
const originalConsoleLog = console.log;

afterEach(() => {
  require.cache[providersModulePath].exports = originalProvidersModule;
  require.cache[settingsModulePath].exports = originalSettingsModule;
  delete require.cache[commandModulePath];
  console.log = originalConsoleLog;
});

function loadCommands({ detected, providerFactory, settings }) {
  require.cache[providersModulePath].exports = {
    ...originalProvidersModule,
    detectProviders: async () => {
      await Promise.resolve();
      return detected;
    },
    getProvider: providerFactory,
  };
  require.cache[settingsModulePath].exports = {
    ...originalSettingsModule,
    loadSettings: () => settings,
  };
  delete require.cache[commandModulePath];
  return require(commandModulePath);
}

test('providers command renders rows from registry-backed runtime metadata', async () => {
  const settings = {
    defaultProvider: 'gemini',
    providerSettings: {
      claude: { defaultLevel: 'level1', levelOverrides: {} },
      codex: { defaultLevel: 'level3', levelOverrides: {} },
      gemini: { defaultLevel: 'level2', levelOverrides: {} },
      opencode: { defaultLevel: 'level2', levelOverrides: {} },
      pi: { defaultLevel: 'level2', levelOverrides: {} },
      copilot: { defaultLevel: 'level2', levelOverrides: {} },
    },
  };
  const detected = Object.fromEntries(
    helper
      .listProviderRegistryEntries()
      .map((entry, index) => [entry.id, { available: index % 2 === 0 }])
  );
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));

  const { providersCommand } = loadCommands({
    detected,
    settings,
    providerFactory: (name) => {
      const metadata = helper.getProviderRegistryEntry(name);
      return {
        displayName: metadata.displayName,
        getDefaultLevel: () => metadata.defaultLevels.default,
        resolveModelSpec: (level, overrides) => helper.resolveModelSpec(name, level, overrides),
        getCliPath: async () => {
          await Promise.resolve();
          return `/opt/${name}`;
        },
      };
    },
  });

  await providersCommand();

  assert.equal(logs[0], '\nProvider     Status       Default Level  Model             CLI Path');
  assert.equal(logs[1], '─'.repeat(70));

  const expectedRows = helper.listProviderRegistryEntries().map((metadata) => {
    const providerSettings = settings.providerSettings[metadata.id] || {};
    const defaultLevel = providerSettings.defaultLevel || metadata.defaultLevels.default;
    const modelLabel = helper.resolveModelSpec(metadata.id, defaultLevel).model || '-';
    const statusIcon = detected[metadata.id].available ? '✓ found' : '✗ not found';
    const cliPath = detected[metadata.id].available ? `/opt/${metadata.id}` : '-';
    const isDefault = settings.defaultProvider === metadata.id ? ' (default)' : '';
    return `${metadata.displayName.padEnd(12)} ${statusIcon.padEnd(12)} ${defaultLevel.padEnd(
      14
    )} ${modelLabel.padEnd(16)} ${cliPath}${isDefault}`;
  });

  assert.deepEqual(logs.slice(2, 2 + expectedRows.length), expectedRows);
});
