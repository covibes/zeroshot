const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  findProviderRegistryEntry,
  getProviderRegistryEntry,
  normalizeProviderName,
} = require('../../lib/agent-cli-provider');

test('alias "oh-my-pi" resolves to the omp registry entry', () => {
  assert.equal(normalizeProviderName('oh-my-pi'), 'omp');
  const byAlias = findProviderRegistryEntry('oh-my-pi');
  const byId = findProviderRegistryEntry('omp');
  assert.ok(byAlias);
  assert.equal(byAlias.id, 'omp');
  assert.deepEqual(byAlias, byId);
});

test('pi provider is untouched and never aliased to omp', () => {
  const pi = getProviderRegistryEntry('pi');
  assert.equal(pi.id, 'pi');
  assert.deepEqual(pi.aliases, []);
  assert.notEqual(normalizeProviderName('pi'), 'omp');
});

test('omp registry entry has the exact display name, invoke spec, and settings fields', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.equal(omp.displayName, 'OMP (Oh My Pi)');
  assert.deepEqual(omp.aliases, ['oh-my-pi']);
  assert.deepEqual(omp.invoke, { lane: 'rpc-stdio', protocol: 'omp-v2' });
  assert.deepEqual(omp.settingsFields, []);
  assert.equal(omp.settingsDefaults, undefined);
  assert.equal(omp.settingsValidator, undefined);
});

test('omp registry entry has exactly the nine specified capability values', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.deepEqual(omp.capabilities, {
    worktreeIsolation: true,
    streamJson: true,
    thinkingMode: true,
    reasoningEffort: true,
    jsonSchema: false,
    mcpServers: false,
    webSearch: false,
    sessionResume: true,
    dockerIsolation: false,
  });
});

test('omp install/auth instructions describe version-selected package install, not an asset installer', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.equal(omp.installInstructions, 'bun install -g @oh-my-pi/pi-coding-agent@17.2.1');
  assert.equal(omp.authInstructions, 'omp\n/login');
});
