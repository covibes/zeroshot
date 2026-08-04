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
  assert.deepEqual(omp.settingsFields, [
    'transport',
    'minLevel',
    'defaultLevel',
    'maxLevel',
    'levelOverrides',
    'modelsConfig',
    'auth',
    'tools',
    'nestedAgents',
    'mcp',
  ]);
  assert.deepEqual(omp.settingsDefaults, {
    transport: 'sdk',
    minLevel: 'level1',
    defaultLevel: 'level2',
    maxLevel: 'level3',
    levelOverrides: {},
    modelsConfig: { providers: {} },
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
    nestedAgents: false,
    mcp: false,
  });
  assert.equal(omp.settingsValidator(omp.settingsDefaults), null);
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
    dockerIsolation: true,
  });
});

test('omp install/auth instructions require manual provider settings and local auth policy', () => {
  const omp = getProviderRegistryEntry('omp');
  assert.equal(omp.installInstructions, 'bun install -g @oh-my-pi/pi-coding-agent@17.2.1');
  assert.equal(
    omp.authInstructions,
    'Manually edit providerSettings.omp in ZEROSHOT_SETTINGS_FILE or $HOME/.zeroshot/settings.json (file 0600, parent directory 0700). Use declared environment or broker variables, an explicit host-only OMP agent directory containing agent.db, or keyless mode; Zeroshot never logs in or stores credential values.'
  );
  assert.doesNotMatch(omp.authInstructions, /login/i);
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
  // The 4 automatic *credential* names. The fifth allowlist entry, OMP_AUTH_BROKER_URL, is a
  // locator, not a credential — it authenticates nothing on its own, hence requireTogether.
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

test('omp Docker envAuth requireOneOf names are all real adapter credentials', () => {
  const omp = getProviderRegistryEntry('omp');
  // The auth gate accepts a name only if it is a registry-known credential AND usable, so a
  // requireOneOf entry missing from credentialEnvKeys would be permanently unsatisfiable.
  for (const name of omp.docker.envAuth.requireOneOf) {
    assert.ok(
      omp.credentialEnvKeys.includes(name),
      `${name} gates auth but is not in the adapter credential inventory`
    );
    assert.ok(
      omp.docker.envPassthrough.includes(name),
      `${name} gates auth but is never forwarded automatically`
    );
  }
});

test('omp Docker envAuth requires the broker URL to be a usable http(s) URL', () => {
  const omp = getProviderRegistryEntry('omp');
  // Per OMP v17.2.1 docs/environment-variables.md, OMP_AUTH_BROKER_URL is the broker's base URL
  // (e.g. https://broker.tailnet:8765) and OMP hard-errors on a broker URL it cannot resolve a
  // token for — so a non-URL value is malformed config, not a missing var.
  assert.deepEqual(omp.docker.envAuth.requireUrl, ['OMP_AUTH_BROKER_URL']);
  assert.ok(
    omp.docker.envPassthrough.includes('OMP_AUTH_BROKER_URL'),
    'the URL-validated var must be one the container actually receives'
  );
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
