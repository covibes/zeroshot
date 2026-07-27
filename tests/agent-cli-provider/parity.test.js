const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const helper = require('../../lib/agent-cli-provider');
const { ENV_PRESETS, MOUNT_PRESETS } = require('../../lib/docker-config');
const { validateSetting } = require('../../lib/settings');
const {
  KNOWN_PROVIDER_NAMES,
  VALID_PROVIDERS,
  normalizeProviderName,
} = require('../../lib/provider-names');
const runtimeProviders = require('../../src/providers');

const createdTempFiles = new Set();

afterEach(() => {
  for (const file of createdTempFiles) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const parentDir = path.dirname(file);
    if (path.basename(parentDir).startsWith('zeroshot-schema-')) {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  }
  createdTempFiles.clear();
});

function trackCleanup(command) {
  for (const file of command.cleanup || []) createdTempFiles.add(file);
}

function normalizeCommand(command) {
  trackCleanup(command);
  return {
    binary: command.binary,
    args: command.args.map((arg) =>
      typeof arg === 'string' && /zeroshot-schema-.*\.json$/.test(arg) ? '<schema-file>' : arg
    ),
    env: command.env,
    cleanup: (command.cleanup || []).map((file) =>
      /zeroshot-schema-.*\.json$/.test(file) ? '<schema-file>' : file
    ),
    cleanupMetadata: (command.cleanupMetadata || []).map((item) => ({
      ...item,
      path: /zeroshot-schema-.*\.json$/.test(item.path) ? '<schema-file>' : item.path,
    })),
  };
}

function fixture(provider, name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', provider, name), 'utf8');
}

function assertRuntimeCommandParity(provider, context, options) {
  const runtime = runtimeProviders.getProvider(provider).buildCommand(context, options);
  const direct = helper.buildProviderCommand(provider, context, options);
  assert.deepEqual(normalizeCommand(runtime), normalizeCommand(direct));
  return direct;
}

test('runtime Claude command facade delegates to helper', () => {
  assertRuntimeCommandParity('claude', 'test context', {
    authEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    outputFormat: 'json',
    jsonSchema: { type: 'object', properties: { foo: { type: 'string' } } },
    modelSpec: { level: 'level2', model: 'sonnet' },
    autoApprove: true,
    cliFeatures: {
      supportsOutputFormat: true,
      supportsJsonSchema: true,
      supportsAutoApprove: true,
      supportsModel: true,
    },
  });
});

test('Claude command loads the per-run settings overlay without replacing user config', () => {
  const command = assertRuntimeCommandParity('claude', 'test context', {
    outputFormat: 'json',
    modelSpec: { level: 'level2', model: 'sonnet' },
    claudeSettingsFile: '/tmp/zeroshot-run-settings.json',
    cliFeatures: { supportsSettings: true },
  });
  const settingsIndex = command.args.indexOf('--settings');
  assert.notEqual(settingsIndex, -1);
  assert.equal(command.args[settingsIndex + 1], '/tmp/zeroshot-run-settings.json');
  assert.equal(command.env.CLAUDE_CONFIG_DIR, undefined);
});

test('Claude MCP configs remain variadic without consuming the positional prompt', () => {
  const command = assertRuntimeCommandParity('claude', 'literal task prompt', {
    mcpConfig: ['/repo/.mcp.json', '/repo/extra.mcp.json'],
    modelSpec: { model: 'sonnet' },
    cliFeatures: { supportsMcpConfig: true },
  });
  const mcpIndex = command.args.indexOf('--mcp-config');
  const inputIndex = command.args.indexOf('--input-format');
  assert.deepEqual(command.args.slice(mcpIndex, inputIndex), [
    '--mcp-config',
    '/repo/.mcp.json',
    '/repo/extra.mcp.json',
  ]);
  assert.equal(command.args[inputIndex + 1], 'text');
  assert.equal(command.args.at(-1), 'literal task prompt');
});

test('Claude fails closed before spawn when required settings or MCP flags are unavailable', () => {
  assert.throws(
    () =>
      helper.buildProviderCommand('claude', 'context', {
        claudeSettingsFile: '/tmp/settings.json',
        cliFeatures: { supportsSettings: false },
      }),
    /Upgrade Claude Code/
  );
  assert.throws(
    () =>
      helper.buildProviderCommand('claude', 'context', {
        mcpConfig: ['/repo/.mcp.json'],
        cliFeatures: { supportsMcpConfig: false },
      }),
    /Upgrade Claude Code/
  );
});

test('runtime Codex command facade delegates to helper', () => {
  assertRuntimeCommandParity('codex', 'test context', {
    outputFormat: 'json',
    jsonSchema: { type: 'object', properties: { foo: { type: 'string' } } },
    cwd: '/tmp/project',
    modelSpec: { level: 'level3', model: 'gpt-5.4', reasoningEffort: 'xhigh' },
    autoApprove: true,
    cliFeatures: {
      supportsJson: true,
      supportsOutputSchema: true,
      supportsCwd: true,
      supportsConfigOverride: true,
      supportsAutoApprove: true,
      supportsSkipGitRepoCheck: true,
    },
  });
});

test('runtime Gemini command facade delegates to helper', () => {
  assertRuntimeCommandParity('gemini', 'gemini context', {
    outputFormat: 'stream-json',
    jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    cwd: '/tmp/project',
    modelSpec: { level: 'level3', model: 'gemini-2.5-pro' },
    autoApprove: true,
    cliFeatures: {
      supportsStreamJson: true,
      supportsCwd: true,
      supportsAutoApprove: true,
    },
  });
});

test('runtime Opencode command facade delegates to helper', () => {
  assertRuntimeCommandParity('opencode', 'opencode context', {
    outputFormat: 'json',
    jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    cwd: '/tmp/project',
    modelSpec: {
      level: 'level2',
      model: 'opencode/glm-4.7-free',
      reasoningEffort: 'high',
    },
    cliFeatures: {
      supportsJson: true,
      supportsVariant: true,
      supportsDir: true,
      supportsCwd: true,
    },
  });
});

test('runtime Pi command facade delegates to helper', () => {
  assertRuntimeCommandParity('pi', 'pi context', {
    outputFormat: 'json',
    jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    cwd: '/tmp/project',
    modelSpec: { level: 'level2', model: 'openai/gpt-5.5' },
    cliFeatures: {
      supportsJsonMode: true,
      supportsNoSession: true,
      supportsNoExtensions: true,
      supportsNoSkills: true,
      supportsNoPromptTemplates: true,
      supportsNoContextFiles: true,
      supportsNoApprove: true,
      supportsModel: true,
    },
  });
});

test('runtime Copilot command facade delegates to helper', () => {
  assertRuntimeCommandParity('copilot', 'copilot context', {
    outputFormat: 'json',
    autoApprove: true,
    jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    cwd: '/tmp/project',
    modelSpec: { level: 'level2', model: 'gpt-5.2' },
    cliFeatures: {
      supportsJsonOutput: true,
      supportsModel: true,
      supportsAllowAll: true,
      supportsNoAskUser: true,
      supportsAddDir: true,
    },
  });
});

test('gateway availability and cli path use the bundled node runtime, not PATH lookup', async () => {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-provider-'));
  const settingsFile = path.join(settingsDir, 'settings.json');
  const originalPath = process.env.PATH;
  const originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;

  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        defaultProvider: 'gateway',
        providerSettings: {
          gateway: {
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: 'gateway-key',
            model: 'openrouter/test-model',
            toolPolicy: {
              roots: ['.'],
              commands: ['node'],
            },
          },
        },
      },
      null,
      2
    )
  );

  process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
  process.env.PATH = '/nonexistent';

  try {
    const detected = await runtimeProviders.detectProviders();
    assert.equal(detected.gateway.available, true);
    assert.equal(runtimeProviders.getProvider('gateway').getCliPath(), process.execPath);
  } finally {
    process.env.PATH = originalPath;
    if (originalSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFile;
    }
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});

test('gateway provider discovery fails closed on malformed gateway settings', () => {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-provider-invalid-'));
  const settingsFile = path.join(settingsDir, 'settings.json');

  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        defaultProvider: 'gateway',
        providerSettings: {
          gateway: {
            toolPolicy: 'bad',
          },
        },
      },
      null,
      2
    )
  );

  try {
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "require('./src/providers').detectProviders().then((result) => process.stdout.write(JSON.stringify(result.gateway)))",
      ],
      {
        cwd: path.join(__dirname, '..', '..'),
        env: {
          ...process.env,
          ZEROSHOT_SETTINGS_FILE: settingsFile,
        },
        encoding: 'utf8',
      }
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { available: false });
  } finally {
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});

test('Codex helper exposes strict schema cleanup metadata through runtime facade', () => {
  const actual = runtimeProviders.getProvider('codex').buildCommand('schema context', {
    outputFormat: 'json',
    jsonSchema: { type: 'object', properties: { foo: { type: 'string' } } },
    cliFeatures: { supportsOutputSchema: true },
  });
  trackCleanup(actual);

  assert.equal(actual.cleanupMetadata.length, 1);
  assert.equal(actual.cleanupMetadata[0].kind, 'temp-file');
  assert.equal(actual.cleanupMetadata[0].reason, 'output-schema');
  assert.ok(fs.existsSync(actual.cleanupMetadata[0].path));

  const schema = JSON.parse(fs.readFileSync(actual.cleanupMetadata[0].path, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['foo']);
  assert.equal(path.dirname(path.dirname(actual.cleanupMetadata[0].path)), os.tmpdir());
  assert.match(path.basename(path.dirname(actual.cleanupMetadata[0].path)), /^zeroshot-schema-/);
});

test('model resolution and invalid-model permanence match helper', () => {
  for (const provider of helper.listProviderAdapters()) {
    const current = runtimeProviders.getProvider(provider);
    for (const level of ['level1', 'level2', 'level3']) {
      assert.deepEqual(
        helper.resolveModelSpec(provider, level),
        current.resolveModelSpec(level, {})
      );
    }

    assert.deepEqual(
      helper.resolveModelSpec(provider, 'level2', { level2: { model: '' } }),
      current.resolveModelSpec('level2', { level2: { model: '' } })
    );

    if (provider === 'pi' || provider === 'copilot' || provider === 'gateway') {
      assert.deepEqual(
        helper.resolveModelSpec(provider, 'level2', { level2: { model: 'invalid' } }),
        current.resolveModelSpec('level2', { level2: { model: 'invalid' } })
      );
      continue;
    }

    assert.throws(
      () => helper.resolveModelSpec(provider, 'level2', { level2: { model: 'invalid' } }),
      { permanent: true }
    );
    assert.throws(() => current.resolveModelSpec('level2', { level2: { model: 'invalid' } }), {
      permanent: true,
    });
  }
});

test('retry classification matches helper', () => {
  const cases = [
    new Error('Rate limit exceeded. Retry after 60 seconds.'),
    new Error('invalid_api_key: key revoked'),
    new Error('server_error'),
    new Error('RESOURCE_EXHAUSTED'),
    Object.assign(new Error('status 429'), { status: 429 }),
    Object.assign(new Error('status 401'), { statusCode: 401 }),
    Object.assign(new Error('network code'), { code: 'ECONNRESET' }),
    { message: 'invalid_api_key: key revoked' },
    Object.assign(new Error('unclassified'), { permanent: true }),
    new Error('unexpected output'),
  ];

  for (const provider of helper.listProviderAdapters()) {
    const current = runtimeProviders.getProvider(provider);
    for (const error of cases) {
      assert.equal(
        helper.classifyProviderError(provider, error).retryable,
        current.isRetryableError(error),
        `${provider}: ${error.message}`
      );
    }
  }
});

test('parser output from runtime facade matches helper fixtures', () => {
  for (const [provider, files] of [
    ['codex', ['text.jsonl', 'tool.jsonl']],
    ['gemini', ['text.jsonl', 'tool.jsonl']],
    [
      'kiro',
      [
        'text.jsonl',
        'tool.jsonl',
        'auth-failure.jsonl',
        'cancelled.jsonl',
        'empty.jsonl',
        'malformed.jsonl',
      ],
    ],
    ['pi', ['text.jsonl', 'tool.jsonl', 'command-failure.jsonl']],
    ['copilot', ['text.jsonl', 'tool.jsonl', 'unknown-event.jsonl']],
  ]) {
    for (const file of files) {
      const chunk = fixture(provider, file);
      assert.deepEqual(
        runtimeProviders.parseProviderChunk(provider, chunk),
        helper.parseProviderChunk(provider, chunk)
      );
    }
  }
});

test('parser output preserves edge-case fields through runtime facade', () => {
  const cases = [
    [
      'codex',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'function_call_output', call_id: 'call-1', output: 'ok', error: null },
      }),
    ],
    [
      'claude',
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: { message: 'bad' },
        usage: {},
      }),
    ],
    [
      'opencode',
      JSON.stringify({
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            state: { status: 'completed', output: 'ok' },
          },
        },
      }),
    ],
  ];

  for (const [provider, chunk] of cases) {
    assert.deepEqual(
      runtimeProviders.parseProviderChunk(provider, chunk),
      helper.parseProviderChunk(provider, chunk)
    );
  }
});

test('parser strips timestamp and agent prefixes like helper', () => {
  const raw = JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hi' },
    },
  });
  const chunk = `[1721088000000]validator       | ${raw}\n`;

  assert.deepEqual(
    runtimeProviders.parseProviderChunk('claude', chunk),
    helper.parseProviderChunk('claude', chunk)
  );
});

test('feature probing is deterministic from injected help text', () => {
  assert.deepEqual(helper.getProviderAdapter('claude').detectCliFeatures(''), {
    provider: 'claude',
    supportsOutputFormat: true,
    supportsStreamJson: true,
    supportsJsonSchema: true,
    supportsAutoApprove: true,
    supportsIncludePartials: true,
    supportsVerbose: true,
    supportsModel: true,
    supportsEffort: true,
    supportsSettings: false,
    supportsMcpConfig: false,
    unknown: true,
  });
  const claudeFeatures = helper
    .getProviderAdapter('claude')
    .detectCliFeatures('claude --settings --mcp-config --model');
  assert.equal(claudeFeatures.supportsSettings, true);
  assert.equal(claudeFeatures.supportsMcpConfig, true);
  assert.equal(claudeFeatures.unknown, false);

  assert.equal(
    helper
      .getProviderAdapter('codex')
      .detectCliFeatures('codex exec --json --output-schema --config -m -C').supportsAutoApprove,
    false
  );
  assert.equal(
    helper
      .getProviderAdapter('opencode')
      .detectCliFeatures('opencode run --format --model --variant --dir --cwd').supportsDir,
    true
  );
  assert.equal(
    helper.getProviderAdapter('opencode').detectCliFeatures('opencode run --format').supportsCwd,
    false
  );
  assert.equal(
    helper
      .getProviderAdapter('pi')
      .detectCliFeatures(
        'pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model'
      ).supportsNoApprove,
    true
  );
  assert.equal(
    helper
      .getProviderAdapter('copilot')
      .detectCliFeatures(
        'copilot -p --output-format json --model --allow-all --no-ask-user --add-dir'
      ).supportsAllowAll,
    true
  );
  assert.deepEqual(helper.getProviderAdapter('kiro').detectCliFeatures('kiro-cli acp --help'), {
    provider: 'kiro',
    supportsAcpStdio: true,
    supportsPromptImages: true,
    supportsLoadSession: false,
    supportsSessionCancel: true,
    supportsSessionSetModel: false,
    supportsSessionSetMode: false,
    supportsRemoteTransport: false,
    supportsCustomTransport: false,
    supportsPermissionRequests: false,
    supportsFsTools: false,
    supportsTerminalTools: false,
    unknown: false,
  });
  assert.deepEqual(helper.getProviderAdapter('gateway').detectCliFeatures(''), {
    provider: 'gateway',
    supportsBundledRunner: true,
    unknown: false,
  });
});

test('provider registry stays in parity across helper runtime settings and probe contract', async () => {
  assert.deepEqual(helper.listProviderAdapters(), VALID_PROVIDERS);
  assert.deepEqual(runtimeProviders.listProviders(), VALID_PROVIDERS);
  assert.deepEqual(
    helper.listProviderRegistryEntries().map((entry) => entry.id),
    VALID_PROVIDERS
  );
  assert.deepEqual(
    KNOWN_PROVIDER_NAMES.map((name) => normalizeProviderName(name)),
    KNOWN_PROVIDER_NAMES.map((name) => helper.normalizeProviderName(name))
  );

  for (const provider of VALID_PROVIDERS) {
    const metadata = helper.getProviderRegistryEntry(provider);
    const runtime = runtimeProviders.getProvider(provider);
    assert.equal(runtime.displayName, metadata.displayName);
    assert.deepEqual(runtime.getCredentialPaths(), metadata.credentialPaths);
    assert.deepEqual(runtime.getSettingsFields().slice(4), metadata.settingsFields);

    const response = await helper.runProviderExecutable(
      JSON.stringify({
        schemaVersion: 1,
        command: 'probe',
        provider,
        helpText: '',
      }),
      {
        runner: async () => {
          await Promise.resolve();
          return {
            stdout: '',
            stderr: '',
            exitCode: 0,
            signal: null,
            durationMs: 1,
          };
        },
      }
    );

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.provider.id, provider);
    assert.equal(response.envelope.result.provider.displayName, metadata.displayName);
    assert.deepEqual(
      response.envelope.result.credentials.map((credential) => credential.key),
      metadata.credentialEnvKeys
    );
  }

  assert.equal(validateSetting('defaultProvider', 'openai'), null);
  assert.equal(
    validateSetting('defaultProvider', 'invalid-provider'),
    `Invalid provider: invalid-provider. Valid providers: ${VALID_PROVIDERS.join(', ')}`
  );
  assert.equal(
    validateSetting('providerSettings', {
      openai: { defaultLevel: 'level2', levelOverrides: {} },
    }),
    null
  );
  assert.equal(
    validateSetting('providerSettings', {
      gateway: {
        defaultLevel: 'level2',
        levelOverrides: {},
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: 'gateway-key',
        model: 'openrouter/test-model',
        toolPolicy: { roots: ['.'], commands: ['node'] },
      },
    }),
    null
  );
  assert.equal(
    validateSetting('providerSettings', {
      'invalid-provider': { defaultLevel: 'level2', levelOverrides: {} },
    }),
    `Unknown provider in providerSettings: invalid-provider. Valid providers: ${VALID_PROVIDERS.join(', ')}`
  );

  for (const metadata of helper.listProviderRegistryEntries()) {
    assert.deepEqual(MOUNT_PRESETS[metadata.id], metadata.docker.mount);
    assert.deepEqual(ENV_PRESETS[metadata.id], metadata.docker.envPassthrough);
  }
});
