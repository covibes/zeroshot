const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const helper = require('../../lib/agent-cli-provider');

const FULL_FEATURES = {
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
};

function buildCommand(context, options = {}) {
  return helper.buildProviderCommand('omp', context, {
    cliFeatures: FULL_FEATURES,
    ...options,
  });
}

function assertOverlay(spec) {
  const configIndex = spec.args.indexOf('--config');
  assert.ok(configIndex !== -1, 'expected --config in argv');
  const overlayFile = spec.args[configIndex + 1];
  const overlayDir = path.dirname(overlayFile);
  assert.equal(path.dirname(overlayDir), path.resolve(os.tmpdir()));
  assert.match(path.basename(overlayDir), /^zeroshot-omp-config-[A-Za-z0-9_-]+$/);
  assert.match(path.basename(overlayFile), /\.yml$/);
  const dirMode = fs.statSync(overlayDir).mode & 0o777;
  const fileMode = fs.statSync(overlayFile).mode & 0o777;
  if (process.platform !== 'win32') {
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
  }
  assert.deepEqual(spec.cleanup, [overlayDir]);
  assert.deepEqual(spec.cleanupMetadata, [
    { kind: 'temp-directory', provider: 'omp', path: overlayDir, reason: 'isolated-config' },
  ]);
  fs.rmSync(overlayDir, { recursive: true, force: true });
}

test('omp buildCommand emits exact argv for a fully-featured build', () => {
  const spec = buildCommand('prompt', {
    cwd: '/tmp/x',
    modelSpec: { level: 'level3', model: 'm', reasoningEffort: 'high' },
  });

  assert.equal(spec.binary, 'omp');
  const configIndex = spec.args.indexOf('--config');
  const overlayFile = spec.args[configIndex + 1];
  assert.deepEqual(spec.args, [
    '--mode',
    'rpc',
    '--no-session',
    '--model',
    'm',
    '--thinking',
    'high',
    '--approval-mode',
    'yolo',
    '--no-title',
    '--config',
    overlayFile,
  ]);
  assert.equal(spec.cwd, '/tmp/x');
  assertOverlay(spec);
});

test('omp buildCommand never emits --no-tools/--no-extensions/--no-skills/--no-rules/--no-lsp', () => {
  const spec = buildCommand('prompt', { modelSpec: { model: 'm' } });
  for (const forbidden of [
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-lsp',
  ]) {
    assert.ok(!spec.args.includes(forbidden), `unexpected flag ${forbidden}`);
  }
  assertOverlay(spec);
});

test('omp buildCommand omits --thinking when no reasoningEffort is resolved', () => {
  const spec = buildCommand('prompt', { modelSpec: { model: 'm' } });
  assert.ok(!spec.args.includes('--thinking'));
  assertOverlay(spec);
});

test('omp resolveModelSpec maps level1|level2|level3 to @smol|@default|@slow', () => {
  const adapter = helper.getProviderAdapter('omp');
  assert.equal(adapter.resolveModelSpec('level1').model, '@smol');
  assert.equal(adapter.resolveModelSpec('level2').model, '@default');
  assert.equal(adapter.resolveModelSpec('level3').model, '@slow');
  assert.equal(adapter.resolveModelSpec('level1').reasoningEffort, undefined);
});

test('omp buildCommand passes an explicit model byte-for-byte after validation', () => {
  const spec = buildCommand('prompt', { modelSpec: { model: '@custom/model-1.2:beta' } });
  assert.ok(spec.args.includes('@custom/model-1.2:beta'));
  assertOverlay(spec);
});

test('omp buildCommand reasoningEffort "max" emits --thinking max without downgrade', () => {
  const spec = buildCommand('prompt', { modelSpec: { model: 'm', reasoningEffort: 'max' } });
  const thinkingIndex = spec.args.indexOf('--thinking');
  assert.equal(spec.args[thinkingIndex + 1], 'max');
  assertOverlay(spec);
});

test('omp validateModelId rejects whitespace, leading dash, >128 chars, and control characters', () => {
  const adapter = helper.getProviderAdapter('omp');
  for (const bad of ['has space', '-leading-dash', 'a'.repeat(200), 'controlchar', '']) {
    assert.throws(
      () => adapter.validateModelId(bad),
      (error) => {
        assert.equal(error.name, 'InvalidProviderModelError');
        return true;
      },
      `expected "${bad}" to be rejected`
    );
  }
  assert.equal(adapter.validateModelId(undefined), undefined);
  assert.equal(adapter.validateModelId(null), null);
  assert.equal(adapter.validateModelId('@default'), '@default');
});

test('omp buildCommand rejects nonempty mcpConfig with UnsupportedProviderCapabilityError', () => {
  assert.throws(
    () => buildCommand('prompt', { modelSpec: { model: 'm' }, mcpConfig: ['/tmp/x.json'] }),
    (error) => {
      assert.equal(error.name, 'UnsupportedProviderCapabilityError');
      assert.equal(error.provider, 'omp');
      assert.equal(error.capability, 'mcpServers');
      return true;
    }
  );
});

test('omp buildCommand emits a prompt-appended schema warning, never a native-schema claim', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const spec = buildCommand('do the thing', { modelSpec: { model: 'm' }, jsonSchema: schema });

  assert.deepEqual(
    spec.warnings.map((warning) => warning.code),
    ['omp-jsonschema']
  );
  assert.equal(spec.warnings[0].provider, 'omp');
  // Prompt + local validation only: no --schema/--json-schema/--output-schema style flag, and no
  // schema-related capability flip. The schema is carried in the RPC prompt text (buildOmpPrompt),
  // never in argv, since the rpc-stdio lane never sends the prompt as an argv element at all.
  assert.equal(
    spec.args.some((arg) => typeof arg === 'string' && /schema/i.test(arg)),
    false
  );
  const overlayDir = path.dirname(spec.args[spec.args.indexOf('--config') + 1]);
  fs.rmSync(overlayDir, { recursive: true, force: true });
});

test('omp buildOmpPrompt appends schema instructions for local validation, unchanged without a schema', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const plain = helper.buildOmpPrompt('do the thing', {});
  assert.equal(plain, 'do the thing');

  const withSchema = helper.buildOmpPrompt('do the thing', { jsonSchema: schema });
  assert.ok(withSchema.startsWith('do the thing'));
  assert.match(withSchema, /OUTPUT FORMAT/);
  assert.match(withSchema, /"ok"/);
  assert.match(withSchema, /"boolean"/);
});

test('omp buildCommand fails closed on resume/continue session control', () => {
  assert.throws(
    () => buildCommand('prompt', { modelSpec: { model: 'm' }, resumeSessionId: 'session-123' }),
    (error) => {
      assert.equal(error.name, 'ContractRequestError');
      assert.equal(error.field, 'options.resumeSessionId');
      assert.equal(error.exitCode, 2);
      return true;
    }
  );

  assert.throws(
    () => buildCommand('prompt', { modelSpec: { model: 'm' }, continueSession: true }),
    (error) => {
      assert.equal(error.name, 'ContractRequestError');
      assert.equal(error.field, 'options.continueSession');
      assert.equal(error.exitCode, 2);
      return true;
    }
  );

  // continueSession fails closed even alongside a verified resume partition: OMP RPC never
  // supports --continue at all.
  assert.throws(
    () =>
      buildCommand('prompt', {
        modelSpec: { model: 'm' },
        continueSession: true,
        ompSession: { kind: 'resume', partition: { path: '/p' }, file: { path: '/p/s.jsonl' } },
      }),
    (error) => error.field === 'options.continueSession'
  );
});

test('omp buildCommand emits --session-dir <partition> for a verified fresh session', () => {
  const spec = buildCommand('prompt', {
    modelSpec: { model: 'm' },
    ompSession: { kind: 'fresh', partition: { path: '/tmp/omp-sessions/abc' } },
  });
  assert.deepEqual(spec.args.slice(0, 4), [
    '--mode',
    'rpc',
    '--session-dir',
    '/tmp/omp-sessions/abc',
  ]);
  assert.ok(!spec.args.includes('--no-session'));
  assert.ok(!spec.args.includes('--resume'));
  assertOverlay(spec);
});

test('omp buildCommand emits --session-dir <partition> --resume <file> for a verified resume session', () => {
  const spec = buildCommand('prompt', {
    modelSpec: { model: 'm' },
    ompSession: {
      kind: 'resume',
      partition: { path: '/tmp/omp-sessions/abc' },
      file: { path: '/tmp/omp-sessions/abc/sess.jsonl' },
    },
  });
  assert.deepEqual(spec.args.slice(0, 6), [
    '--mode',
    'rpc',
    '--session-dir',
    '/tmp/omp-sessions/abc',
    '--resume',
    '/tmp/omp-sessions/abc/sess.jsonl',
  ]);
  assert.ok(!spec.args.includes('--no-session'));
  assertOverlay(spec);
});

test('omp buildCommand resume with a matching verified ompSession does not throw despite resumeSessionId', () => {
  const spec = buildCommand('prompt', {
    modelSpec: { model: 'm' },
    resumeSessionId: 'session-123',
    ompSession: {
      kind: 'resume',
      partition: { path: '/tmp/omp-sessions/abc' },
      file: { path: '/tmp/omp-sessions/abc/sess.jsonl' },
    },
  });
  assert.ok(spec.args.includes('--resume'));
  assertOverlay(spec);
});

test('omp buildCommand fails closed when fresh/resume session requested but CLI lacks --session-dir/--resume evidence', () => {
  assert.throws(
    () =>
      buildCommand('prompt', {
        modelSpec: { model: 'm' },
        cliFeatures: { ...FULL_FEATURES, supportsSessionDir: false },
        ompSession: { kind: 'fresh', partition: { path: '/p' } },
      }),
    (error) => error.code === 'unsupported-provider-cli' && error.message.includes('--session-dir')
  );

  assert.throws(
    () =>
      buildCommand('prompt', {
        modelSpec: { model: 'm' },
        cliFeatures: { ...FULL_FEATURES, supportsResume: false },
        ompSession: {
          kind: 'resume',
          partition: { path: '/p' },
          file: { path: '/p/s.jsonl' },
        },
      }),
    (error) => error.code === 'unsupported-provider-cli' && error.message.includes('--resume')
  );
});

test('omp buildCommand fails closed when the version does not match 17.2.1', () => {
  assert.throws(
    () =>
      buildCommand('prompt', {
        modelSpec: { model: 'm' },
        cliFeatures: { ...FULL_FEATURES, versionMatches: false },
      }),
    (error) => {
      assert.equal(error.name, 'ContractRequestError');
      assert.equal(error.code, 'unsupported-provider-cli');
      assert.equal(error.exitCode, 2);
      assert.ok(error.message.includes('17.2.1'));
      assert.ok(error.message.includes('bun install -g @oh-my-pi/pi-coding-agent@17.2.1'));
      return true;
    }
  );
});

for (const [flag, label] of [
  ['supportsRpcMode', '"rpc" mode'],
  ['supportsConfig', '--config'],
  ['supportsModel', '--model'],
  ['supportsApprovalMode', '--approval-mode'],
  ['supportsNoTitle', '--no-title'],
  ['supportsNoSession', '--no-session'],
]) {
  test(`omp buildCommand fails closed when ${flag} is absent`, () => {
    assert.throws(
      () =>
        buildCommand('prompt', {
          modelSpec: { model: 'm' },
          cliFeatures: { ...FULL_FEATURES, [flag]: false },
        }),
      (error) => {
        assert.equal(error.name, 'ContractRequestError');
        assert.equal(error.code, 'unsupported-provider-cli');
        assert.equal(error.exitCode, 2);
        assert.ok(error.message.includes(label), error.message);
        assert.ok(error.message.includes('Pi'), 'must state no fallback to Pi');
        return true;
      }
    );
  });
}

test('omp detectCliFeatures returns all-false on empty help/version text', () => {
  const adapter = helper.getProviderAdapter('omp');
  const features = adapter.detectCliFeatures('', '');
  assert.equal(features.versionMatches, false);
  assert.equal(features.supportsRpcMode, false);
  assert.equal(features.supportsConfig, false);
  assert.equal(features.unknown, true);
});

test('omp detectCliFeatures requires exact semver 17.2.1 and rejects 17.2.10', () => {
  const adapter = helper.getProviderAdapter('omp');
  assert.equal(adapter.detectCliFeatures('', '17.2.1').versionMatches, true);
  assert.equal(adapter.detectCliFeatures('', 'omp version 17.2.1').versionMatches, true);
  assert.equal(adapter.detectCliFeatures('', '17.2.10').versionMatches, false);
  assert.equal(adapter.detectCliFeatures('', '117.2.1').versionMatches, false);
  assert.equal(adapter.detectCliFeatures('', '17.2.2').versionMatches, false);
});

test('omp detectCliFeatures parses help evidence for every required and probed flag', () => {
  const adapter = helper.getProviderAdapter('omp');
  const help = [
    'Usage: omp [options] [command]',
    '  rpc',
    '  --config <path>',
    '  --model <selector>',
    '  --thinking <level>',
    '  --approval-mode <mode>',
    '  --no-title',
    '  --no-session',
    '  --session-dir <dir>',
    '  --resume [id]',
  ].join('\n');
  const features = adapter.detectCliFeatures(help, '17.2.1');
  assert.equal(features.versionMatches, true);
  assert.equal(features.supportsRpcMode, true);
  assert.equal(features.supportsConfig, true);
  assert.equal(features.supportsModel, true);
  assert.equal(features.supportsThinking, true);
  assert.equal(features.supportsApprovalMode, true);
  assert.equal(features.supportsNoTitle, true);
  assert.equal(features.supportsNoSession, true);
  assert.equal(features.supportsSessionDir, true);
  assert.equal(features.supportsResume, true);
});

test('omp parseEvent is a validating passthrough over already-normalized OutputEvent JSON', () => {
  const adapter = helper.getProviderAdapter('omp');
  const state = adapter.createParserState();
  assert.equal(adapter.parseEvent('not json', state), null);
  assert.equal(adapter.parseEvent('{"unterminated": ', state), null);
  assert.equal(adapter.parseEvent(JSON.stringify({ type: 'message_update' }), state), null);
  assert.deepEqual(adapter.parseEvent(JSON.stringify({ type: 'text', text: 'hi' }), state), {
    type: 'text',
    text: 'hi',
  });
});

test('omp classifyError marks cancellation, protocol/version/frame failures permanent, and rate limits retryable', () => {
  const adapter = helper.getProviderAdapter('omp');

  const cancelled = adapter.classifyError(new Error('cancelled: task aborted'));
  assert.equal(cancelled.retryable, false);
  assert.equal(cancelled.kind, 'cancelled');

  for (const message of ['rate limit exceeded', 'quota exceeded', 'service overloaded']) {
    assert.equal(adapter.classifyError(new Error(message)).retryable, true, message);
  }

  for (const message of [
    'unsupported-protocol: ready frame missing v2',
    'unsupported-limits: over cap',
    'malformed-response: bad ack',
    'unsafe-config: negotiate rejected',
    'unsupported-ui-method: extension_ui_request used unsupported method "foo"',
    'local-only-prompt: no agent turn',
    'invalid-chunk-metadata: bad chunk',
    'output-bound-exceeded: over cap',
    'run /login',
    'unknown option --bogus',
    'cannot find module omp',
  ]) {
    assert.equal(adapter.classifyError(new Error(message)).retryable, false, message);
  }
});

test('omp adapter credentialEnvKeys include the full v17.2.1 official host credential inventory', () => {
  const adapter = helper.getProviderAdapter('omp');
  const expected = [
    'AIMLAPI_API_KEY',
    'AI_GATEWAY_API_KEY',
    'ALIBABA_CODING_PLAN_API_KEY',
    'ALIBABA_TOKEN_PLAN_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_SEARCH_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_SECRET_ACCESS_KEY',
    'AZURE_OPENAI_API_KEY',
    'BAILIAN_TOKEN_PLAN_API_KEY',
    'BRAVE_API_KEY',
    'CEREBRAS_API_KEY',
    'CLAUDE_CODE_CLIENT_CERT',
    'CLAUDE_CODE_CLIENT_KEY',
    'CLOUDFLARE_AI_GATEWAY_API_KEY',
    'COPILOT_GITHUB_TOKEN',
    'CURSOR_ACCESS_TOKEN',
    'DEEPSEEK_API_KEY',
    'EXA_API_KEY',
    'FIREPASS_API_KEY',
    'FIREWORKS_API_KEY',
    'GEMINI_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_API_KEY',
    'GROQ_API_KEY',
    'HF_TOKEN',
    'HUGGINGFACE_HUB_TOKEN',
    'JINA_API_KEY',
    'KAGI_API_KEY',
    'KILO_API_KEY',
    'KIMI_SEARCH_API_KEY',
    'LITELLM_API_KEY',
    'LLAMA_CPP_API_KEY',
    'LM_STUDIO_API_KEY',
    'MINIMAX_API_KEY',
    'MINIMAX_CODE_API_KEY',
    'MINIMAX_CODE_CN_API_KEY',
    'MISTRAL_API_KEY',
    'MOONSHOT_API_KEY',
    'MOONSHOT_SEARCH_API_KEY',
    'NANO_GPT_API_KEY',
    'NOVITA_API_KEY',
    'NVIDIA_API_KEY',
    'OLLAMA_API_KEY',
    'OLLAMA_CLOUD_API_KEY',
    'OMP_AUTH_BROKER_TOKEN',
    'OPENAI_API_KEY',
    'OPENCODE_API_KEY',
    'OPENROUTER_API_KEY',
    'PARALLEL_API_KEY',
    'PERPLEXITY_API_KEY',
    'PERPLEXITY_COOKIES',
    'QIANFAN_API_KEY',
    'QWEN_OAUTH_TOKEN',
    'QWEN_PORTAL_API_KEY',
    'SEARXNG_BASIC_PASSWORD',
    'SEARXNG_TOKEN',
    'SILICONFLOW_API_KEY',
    'SILICONFLOW_CN_API_KEY',
    'SMITHERY_API_KEY',
    'SYNTHETIC_API_KEY',
    'TAVILY_API_KEY',
    'TOGETHER_API_KEY',
    'UMANS_AI_CODING_PLAN_API_KEY',
    'VENICE_API_KEY',
    'VLLM_API_KEY',
    'WAFER_SERVERLESS_API_KEY',
    'XAI_API_KEY',
    'XAI_OAUTH_TOKEN',
    'XIAOMI_API_KEY',
    'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    'ZAI_API_KEY',
    'ZENMUX_API_KEY',
    'ZHIPU_API_KEY',
  ];
  assert.deepEqual([...adapter.credentialEnvKeys].sort(), expected);
  assert.equal(new Set(adapter.credentialEnvKeys).size, adapter.credentialEnvKeys.length);
});

test('omp config overlay pins autoUpdate off plus todo/task/memory/advisor/async/bash.autoBackground safety settings', () => {
  const spec = buildCommand('prompt', { modelSpec: { model: 'm' } });
  const configIndex = spec.args.indexOf('--config');
  const overlayFile = spec.args[configIndex + 1];
  const overlayDir = path.dirname(overlayFile);
  const body = fs.readFileSync(overlayFile, 'utf8');
  fs.rmSync(overlayDir, { recursive: true, force: true });

  assert.notDeepEqual(body.trim().split('\n').slice(1).join('\n').trim(), '{}');
  for (const needle of [
    'autoUpdate: "off"',
    'todo:',
    'task:',
    'memory:',
    'memories:',
    'advisor:',
    'async:',
    'bash:',
    'autoBackground:',
  ]) {
    assert.ok(body.includes(needle), `overlay missing ${needle}`);
  }
});
