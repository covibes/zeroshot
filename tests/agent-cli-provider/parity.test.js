const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const helper = require('../../lib/agent-cli-provider');
const {
  OMP_INSTALL_COMMAND,
  OMP_PACKAGE_NAME,
  OMP_SUPPORTED_VERSION,
} = require('../../lib/agent-cli-provider/omp-release');
const { ENV_PRESETS, MOUNT_PRESETS } = require('../../lib/docker-config');
const { validateSetting } = require('../../lib/settings');
const {
  KNOWN_PROVIDER_NAMES,
  VALID_PROVIDERS,
  normalizeProviderName,
} = require('../../lib/provider-names');
const runtimeProviders = require('../../src/providers');

const createdTempFiles = new Set();
const CONTROL_MODEL_IDS = [
  'kimi/model\0suffix',
  'kimi/model\u0001suffix',
  'kimi/model\u001fsuffix',
  'kimi/model\u007fsuffix',
];

afterEach(() => {
  for (const file of createdTempFiles) {
    const parentDir = path.dirname(file);
    if (
      path.basename(parentDir).startsWith('zeroshot-schema-') ||
      path.basename(parentDir).startsWith('zeroshot-gemini-policy-')
    ) {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  }
  createdTempFiles.clear();
});

function trackCleanup(command) {
  for (const file of command.cleanup || []) createdTempFiles.add(file);
}

const VOLATILE_TEMP_PATH_PATTERN =
  /zeroshot-schema-.*\.json$|zeroshot-omp-config-[A-Za-z0-9_-]+(\/[^/]+\.yml)?$/;

function normalizeCommand(command) {
  trackCleanup(command);
  return {
    binary: command.binary,
    args: command.args.map((arg) =>
      typeof arg === 'string' && VOLATILE_TEMP_PATH_PATTERN.test(arg) ? '<temp-path>' : arg
    ),
    env: command.env,
    cleanup: (command.cleanup || []).map((file) =>
      VOLATILE_TEMP_PATH_PATTERN.test(file) ? '<temp-path>' : file
    ),
    cleanupMetadata: (command.cleanupMetadata || []).map((item) => ({
      ...item,
      path: VOLATILE_TEMP_PATH_PATTERN.test(item.path) ? '<temp-path>' : item.path,
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

function withTempSettings(settings, callback) {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-settings-'));
  const settingsFile = path.join(settingsDir, 'settings.json');
  const previousSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
  if (settings !== undefined) fs.writeFileSync(settingsFile, JSON.stringify(settings));
  process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;

  try {
    return callback();
  } finally {
    if (previousSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = previousSettingsFile;
    }
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
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

test('runtime Opencode command parity preserves the CLI default model', () => {
  withTempSettings(undefined, () => {
    const context = 'opencode default context';
    const runtimeOptions = {
      outputFormat: 'json',
      cliFeatures: {
        supportsJson: true,
        supportsVariant: true,
        supportsDir: true,
        supportsCwd: true,
      },
    };
    const runtime = runtimeProviders.getProvider('opencode').buildCommand(context, runtimeOptions);
    const direct = helper.buildProviderCommand('opencode', context, {
      ...runtimeOptions,
      modelSpec: helper.resolveModelSpec('opencode', 'level2'),
    });

    assert.deepEqual(normalizeCommand(runtime), normalizeCommand(direct));
    assert.equal(direct.args.includes('--model'), false);
  });
});

test('runtime Opencode command parity accepts an external model configured in Opencode settings', () => {
  withTempSettings(
    {
      providerSettings: {
        opencode: {
          defaultLevel: 'level2',
          levelOverrides: {
            level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
          },
        },
      },
    },
    () => {
      const context = 'opencode external context';
      const runtimeOptions = {
        outputFormat: 'json',
        cliFeatures: {
          supportsJson: true,
          supportsVariant: true,
          supportsDir: true,
          supportsCwd: true,
        },
      };
      const runtime = runtimeProviders
        .getProvider('opencode')
        .buildCommand(context, runtimeOptions);
      const direct = helper.buildProviderCommand('opencode', context, {
        ...runtimeOptions,
        modelSpec: helper.resolveModelSpec('opencode', 'level2', {
          level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
        }),
      });

      assert.deepEqual(normalizeCommand(runtime), normalizeCommand(direct));
      assert.deepEqual(direct.args.slice(0, 7), [
        'run',
        '--format',
        'json',
        '--model',
        'kimi/kimi-k2-5',
        '--variant',
        'high',
      ]);
    }
  );
});

test('runtime Opencode rejects an unconfigured external model before command construction', () => {
  withTempSettings(
    {
      providerSettings: {
        opencode: {
          defaultLevel: 'level2',
          levelOverrides: {},
        },
      },
    },
    () => {
      assert.throws(
        () =>
          runtimeProviders.getProvider('opencode').buildCommand('opencode external context', {
            modelSpec: { level: 'level2', model: 'kimi/kimi-k2-5' },
            cliFeatures: { supportsJson: true, supportsModel: true },
          }),
        (error) =>
          error.permanent === true &&
          /Invalid model "kimi\/kimi-k2-5" for provider "opencode"/.test(error.message)
      );
    }
  );
});

test('runtime Opencode rejects a direct external model even when a configured override matches', () => {
  withTempSettings(
    {
      providerSettings: {
        opencode: {
          defaultLevel: 'level2',
          levelOverrides: {
            level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
          },
        },
      },
    },
    () => {
      assert.throws(
        () =>
          runtimeProviders.getProvider('opencode').buildCommand('opencode direct context', {
            modelSpec: { level: 'level2', model: 'kimi/kimi-k2-5' },
            cliFeatures: { supportsJson: true, supportsModel: true },
          }),
        (error) =>
          error.permanent === true &&
          /Invalid model "kimi\/kimi-k2-5" for provider "opencode"/.test(error.message)
      );
    }
  );
});

test('runtime Opencode rejects a malformed configured model before command construction', () => {
  withTempSettings(
    {
      providerSettings: {
        opencode: {
          defaultLevel: 'level2',
          levelOverrides: {
            level2: { model: 'kimi/' },
          },
        },
      },
    },
    () => {
      assert.throws(
        () =>
          runtimeProviders.getProvider('opencode').buildCommand('opencode malformed context', {
            cliFeatures: { supportsJson: true, supportsModel: true },
          }),
        (error) =>
          error.permanent === true &&
          /Invalid configured model "kimi\/" for provider "opencode"/.test(error.message)
      );
    }
  );
});

test('runtime Opencode rejects control bytes in configured and direct models before command construction', () => {
  const opencode = runtimeProviders.getProvider('opencode');

  for (const model of CONTROL_MODEL_IDS) {
    withTempSettings(
      {
        providerSettings: {
          opencode: {
            defaultLevel: 'level2',
            levelOverrides: { level2: { model } },
          },
        },
      },
      () => {
        assert.throws(
          () =>
            opencode.buildCommand('configured control byte', {
              cliFeatures: { supportsJson: true, supportsModel: true },
            }),
          { name: 'InvalidProviderModelError', permanent: true }
        );
      }
    );

    assert.throws(
      () =>
        opencode.buildCommand('direct control byte', {
          modelSpec: { level: 'level2', model },
          cliFeatures: { supportsJson: true, supportsModel: true },
        }),
      { name: 'InvalidProviderModelError', permanent: true }
    );
  }
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

test('runtime OMP command facade delegates to helper', () => {
  withTempSettings({ providerSettings: { omp: { transport: 'rpc' } } }, () => {
    assertRuntimeCommandParity('omp', 'omp context', {
      cwd: '/tmp/project',
      modelSpec: { level: 'level2', model: 'openai/gpt-5.5' },
      cliFeatures: {
        versionMatches: true,
        supportsRpcMode: true,
        supportsConfig: true,
        supportsModel: true,
        supportsThinking: true,
        supportsApprovalMode: true,
        supportsNoTitle: true,
        supportsNoSession: true,
        supportsSessionDir: true,
        supportsResume: true,
      },
    });
  });
});

test('OMP registry install guidance is the pinned omp-release command, not a parallel literal', () => {
  const metadata = helper.getProviderRegistryEntry('omp');
  assert.equal(metadata.installInstructions, OMP_INSTALL_COMMAND);
  assert.equal(
    metadata.installInstructions,
    `bun install -g ${OMP_PACKAGE_NAME}@${OMP_SUPPORTED_VERSION}`
  );
  assert.match(metadata.installInstructions, new RegExp(`@${OMP_SUPPORTED_VERSION}$`));
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

    if (provider === 'opencode') {
      assert.throws(() => helper.resolveModelSpec(provider, 'level2', { level2: { model: '' } }), {
        permanent: true,
      });
      assert.throws(() => current.resolveModelSpec('level2', { level2: { model: '' } }), {
        permanent: true,
      });
    } else {
      assert.deepEqual(
        helper.resolveModelSpec(provider, 'level2', { level2: { model: '' } }),
        current.resolveModelSpec('level2', { level2: { model: '' } })
      );
    }

    if (
      provider === 'pi' ||
      provider === 'omp' ||
      provider === 'copilot' ||
      provider === 'gateway'
    ) {
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
    ['omp', ['text.jsonl', 'tool.jsonl', 'command-failure.jsonl']],
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
    supportsResume: true,
    supportsTools: false,
    supportsStrictMcpConfig: false,
    supportsNoSessionPersistence: false,
    unknown: true,
  });
  const claudeFeatures = helper
    .getProviderAdapter('claude')
    .detectCliFeatures('claude --settings --mcp-config --model');
  assert.equal(claudeFeatures.supportsSettings, true);
  assert.equal(claudeFeatures.supportsMcpConfig, true);
  assert.equal(claudeFeatures.unknown, false);

  assert.equal(
    helper.getProviderAdapter('claude').detectCliFeatures('claude --resume').supportsResume,
    true
  );
  assert.equal(
    helper.getProviderAdapter('claude').detectCliFeatures('claude --print').supportsResume,
    false
  );
  assert.equal(
    helper.getProviderAdapter('codex').detectCliFeatures('codex exec resume').supportsResume,
    true
  );
  assert.equal(
    helper.getProviderAdapter('codex').detectCliFeatures('codex exec --json').supportsResume,
    false
  );
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
  assert.equal(helper.getProviderAdapter('opencode').detectCliFeatures('').supportsResume, false);
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
      .getProviderAdapter('omp')
      .detectCliFeatures(
        'omp --mode rpc --config --model --thinking --approval-mode --no-title --no-session --session-dir --resume',
        '17.2.1'
      ).supportsApprovalMode,
    true
  );
  assert.equal(
    helper.getProviderAdapter('omp').detectCliFeatures('omp --mode rpc').supportsApprovalMode,
    false
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

  assert.deepEqual(
    helper
      .listProviderRegistryEntries()
      .filter((entry) => entry.capabilities.webSearch === true)
      .map((entry) => entry.id),
    ['codex', 'opencode']
  );

  for (const provider of VALID_PROVIDERS) {
    const metadata = helper.getProviderRegistryEntry(provider);
    const runtime = runtimeProviders.getProvider(provider);
    assert.equal(runtime.displayName, metadata.displayName);
    assert.deepEqual(runtime.getCredentialPaths(), metadata.credentialPaths);
    assert.deepEqual(runtime.getSettingsFields().slice(4), metadata.settingsFields);
    assert.equal(
      metadata.settingsFields.includes('webSearch'),
      metadata.capabilities.webSearch === true
    );

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

test('structured-output registry entries require recovery adapters', () => {
  for (const entry of helper.listProviderRegistryEntries()) {
    const eligible = entry.capabilities.jsonSchema !== false;
    assert.equal(helper.supportsProviderOutputReformatting(entry.id), eligible);
    assert.equal(
      typeof entry.adapter.buildStructuredOutputRecoveryCommand === 'function',
      eligible,
      entry.id
    );
  }
});

test('eligible adapters build restricted provider-owned recovery commands', () => {
  const cases = [
    {
      provider: 'claude',
      cliFeatures: {
        supportsTools: true,
        supportsStrictMcpConfig: true,
        supportsNoSessionPersistence: true,
      },
      assertCommand(command) {
        assert.ok(command.args.includes('--tools'));
        assert.ok(command.args.includes('--strict-mcp-config'));
        assert.ok(command.args.includes('--no-session-persistence'));
        assert.equal(command.args.includes('--dangerously-skip-permissions'), false);
        assert.equal(command.args.includes('--mcp-config'), false);
        assert.equal(command.args.includes('--resume'), false);
      },
    },
    {
      provider: 'codex',
      cliFeatures: {
        supportsSandbox: true,
        supportsEphemeral: true,
        supportsIgnoreUserConfig: true,
        supportsIgnoreRules: true,
        supportsStrictConfig: true,
        supportsConfigOverride: true,
        supportsOutputSchema: true,
      },
      assertCommand(command) {
        assert.ok(command.args.includes('--sandbox'));
        assert.ok(command.args.includes('read-only'));
        assert.ok(command.args.includes('--ephemeral'));
        assert.ok(command.args.includes('--ignore-user-config'));
        assert.ok(command.args.includes('--ignore-rules'));
        assert.ok(command.args.includes('--strict-config'));
        assert.ok(command.args.includes('web_search="disabled"'));
        assert.equal(command.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
        assert.equal(command.args.includes('resume'), false);
      },
    },
    {
      provider: 'gemini',
      cliFeatures: { supportsAdminPolicy: true },
      assertCommand(command) {
        const policyPath = command.args[command.args.indexOf('--admin-policy') + 1];
        assert.ok(command.args.includes('--admin-policy'));
        assert.match(
          fs.readFileSync(policyPath, 'utf8'),
          /toolName = "\*"[\s\S]*decision = "deny"[\s\S]*priority = 999/
        );
        assert.equal(command.args.includes('--yolo'), false);
        assert.deepEqual(command.cleanupMetadata.at(-1), {
          kind: 'temp-file',
          provider: 'gemini',
          path: policyPath,
          reason: 'admin-policy',
        });
      },
    },
    {
      provider: 'opencode',
      cliFeatures: { supportsAgent: true, supportsRecoveryIsolation: true },
      assertCommand(command) {
        const agentIndex = command.args.indexOf('--agent');
        assert.match(command.args[agentIndex + 1], /^zeroshot-output-reformatter-/);
        const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(config.default_agent, command.args[agentIndex + 1]);
        assert.deepEqual(config.permission, { '*': 'deny' });
        assert.deepEqual(config.tools, { '*': false });
        assert.deepEqual(config.agent[config.default_agent].permission, { '*': 'deny' });
        assert.deepEqual(config.mcp, {});
        assert.deepEqual(config.instructions, []);
        assert.deepEqual(config.plugin, []);
        assert.deepEqual(config.command, {});
        assert.equal(command.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
        assert.equal(command.env.OPENCODE_PURE, '1');
        assert.equal(command.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, '1');
        assert.equal(command.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1');
        assert.equal(command.env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
        assert.equal(command.env.OPENCODE_PERMISSION, '{"*":"deny"}');
        assert.equal(command.env.XDG_CONFIG_HOME, command.env.OPENCODE_CONFIG_DIR);
        assert.equal(command.env.OPENCODE_DB, ':memory:');
        assert.equal(command.cleanup.at(-1), command.env.XDG_CONFIG_HOME);
        assert.deepEqual(command.cleanupMetadata.at(-1), {
          kind: 'temp-directory',
          provider: 'opencode',
          path: command.env.XDG_CONFIG_HOME,
          reason: 'isolated-config',
        });
      },
    },
  ];

  for (const { provider, cliFeatures, assertCommand } of cases) {
    const prepared = helper.prepareSingleAgentProviderCommand({
      provider,
      context: 'repair this output',
      options: {
        outputFormat: 'json',
        jsonSchema: { type: 'object' },
        autoApprove: true,
        resumeSessionId: 'must-not-survive',
        continueSession: true,
        mcpConfig: ['must-not-survive'],
        structuredOutputRecovery: true,
        cliFeatures,
      },
    });
    trackCleanup(prepared.commandSpec);
    assertCommand(prepared.commandSpec);
  }
});

test('eligible adapters fail closed without recovery safety evidence', () => {
  for (const provider of ['claude', 'codex', 'gemini', 'opencode']) {
    assert.throws(
      () =>
        helper.prepareSingleAgentProviderCommand({
          provider,
          context: 'repair this output',
          options: {
            structuredOutputRecovery: true,
            cliFeatures: {},
          },
        }),
      (error) =>
        error.code === 'unsupported-capability' && error.capability === 'structuredOutputRecovery'
    );
  }
});
