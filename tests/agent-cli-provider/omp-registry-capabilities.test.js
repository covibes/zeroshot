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
    sessionResume: false,
    dockerIsolation: true,
  });
});

test('omp install/auth instructions describe version-selected package install, not an asset installer', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.equal(omp.installInstructions, 'bun install -g @oh-my-pi/pi-coding-agent@17.2.1');
  assert.equal(omp.authInstructions, 'omp\n/login');
});

test('omp Docker metadata is env/broker-only: no automatic mount, exact 5-name allowlist', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.equal(omp.docker.mount, undefined);
  assert.equal(omp.docker.platform, 'linux/amd64');
  assert.deepEqual(omp.docker.configRoots, ['$HOME/.omp']);
  assert.equal(omp.docker.credentialInMount, false);
  // Per the maintainer's authoritative clarification (verified via
  // `gh api repos/the-open-engine/zeroshot/issues/comments/5160272623`), this is intentionally
  // narrower than OMP's full credential catalog / `credentialEnvKeys` inventory above.
  assert.deepEqual(omp.docker.envPassthrough, [
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'OMP_AUTH_BROKER_TOKEN',
    'OMP_AUTH_BROKER_URL',
    'OPENAI_API_KEY',
  ]);
  assert.ok(
    typeof omp.docker.install === 'string' && omp.docker.install.includes('sha256sum -c -')
  );
});

test('omp Docker envAuth requires one of 4 keys, or a complete broker URL+token pair', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.deepEqual(omp.docker.envAuth.requireOneOf, [
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'OMP_AUTH_BROKER_TOKEN',
    'OPENAI_API_KEY',
  ]);
  assert.deepEqual(omp.docker.envAuth.requireTogether, [
    ['OMP_AUTH_BROKER_URL', 'OMP_AUTH_BROKER_TOKEN'],
  ]);
});

test('omp Docker envPassthrough never automatically forwards non-allowlisted credentials (negative coverage)', () => {
  const omp = getProviderRegistryEntry('omp');
  for (const excluded of [
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'OMP_AUTH_BROKER_SNAPSHOT_CACHE',
    'OMP_AUTH_BROKER_ACCOUNT_POOL_FILE',
  ]) {
    assert.ok(
      !omp.docker.envPassthrough.includes(excluded),
      `${excluded} must require explicit dockerEnvPassthrough/--mount opt-in, not automatic forwarding`
    );
    assert.ok(
      !omp.docker.envAuth.requireOneOf.includes(excluded),
      `${excluded} must not gate auth satisfaction either`
    );
  }
  // The four non-broker exclusions remain in the full adapter credential inventory (host
  // inspection/redaction only) — only the automatic Docker allowlist is narrowed.
  for (const stillTracked of [
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
  ]) {
    assert.ok(
      omp.credentialEnvKeys.includes(stillTracked),
      `${stillTracked} should still be in the full adapter credential inventory for redaction`
    );
  }
});

test('every other registry entry keeps its docker metadata byte-identical (mount still present)', () => {
  for (const id of ['claude', 'codex', 'gateway', 'gemini', 'opencode', 'pi', 'kiro', 'copilot']) {
    const entry = getProviderRegistryEntry(id);
    assert.ok(entry.docker.mount, `${id} must keep its docker.mount`);
    assert.equal(entry.docker.platform, undefined, `${id} must not declare docker.platform`);
    assert.equal(entry.docker.configRoots, undefined, `${id} must not declare docker.configRoots`);
    assert.equal(entry.docker.envAuth, undefined, `${id} must not declare docker.envAuth`);
  }
});
