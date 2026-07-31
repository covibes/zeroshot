/**
 * Provider helper command builder tests.
 */

const assert = require('assert');
const fs = require('fs');
const helper = require('../lib/agent-cli-provider');

const createdTempFiles = new Set();

afterEach(() => {
  for (const file of createdTempFiles) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // best-effort test cleanup
    }
  }
  createdTempFiles.clear();
});

function buildCommand(provider, context, options = {}) {
  const spec = helper.buildProviderCommand(provider, context, options);
  for (const file of spec.cleanup || []) createdTempFiles.add(file);
  return spec;
}

describe('Codex provider helper builder', function () {
  it('resumes an explicit session without cwd-wide continuation', function () {
    const resumed = buildCommand('codex', 'test context', {
      resumeSessionId: 'session-123',
      cwd: '/tmp/project',
    });
    assert.deepStrictEqual(resumed.args.slice(0, 2), ['exec', 'resume']);
    assert.deepStrictEqual(resumed.args.slice(-2), ['session-123', 'test context']);
    assert.ok(!resumed.args.includes('-C'));

    const continued = buildCommand('codex', 'test context', {
      continueSession: true,
    });
    assert.ok(!continued.args.includes('--continue'));
    assert.ok(continued.warnings.some((warning) => warning.code === 'unsupported-session-control'));
  });

  it('fails closed when the installed Codex CLI cannot resume', function () {
    assert.throws(
      () =>
        buildCommand('codex', 'delta-only context', {
          resumeSessionId: 'session-123',
          cliFeatures: { supportsResume: false },
        }),
      /cannot safely run continuation context/
    );
  });

  it('keeps absent and disabled web search byte-compatible', function () {
    const absent = buildCommand('codex', 'test context', {
      outputFormat: 'json',
      cliFeatures: { supportsJson: true },
    });
    const disabled = buildCommand('codex', 'test context', {
      outputFormat: 'json',
      webSearch: false,
      cliFeatures: { supportsJson: true },
    });

    assert.deepStrictEqual(disabled.args, absent.args);
    assert.deepStrictEqual(disabled.env, absent.env);
  });

  it('adds the canonical web-search config before fresh and resumed prompts', function () {
    const fresh = buildCommand('codex', 'fresh context', {
      webSearch: true,
      cliFeatures: { supportsWebSearch: true },
    });
    assert.deepStrictEqual(fresh.args.slice(0, 3), [
      'exec',
      '--config',
      'web_search="live"',
    ]);
    assert.strictEqual(fresh.args.includes('--search'), false);

    const resumed = buildCommand('codex', 'resume context', {
      resumeSessionId: 'session-123',
      webSearch: true,
      cliFeatures: { supportsResume: true, supportsWebSearch: true },
    });
    assert.deepStrictEqual(resumed.args.slice(0, 4), [
      'exec',
      '--config',
      'web_search="live"',
      'resume',
    ]);
    assert.deepStrictEqual(resumed.args.slice(-2), ['session-123', 'resume context']);
  });

  it('fails closed when web-search support is not attested', function () {
    assert.throws(
      () =>
        buildCommand('codex', 'test context', {
          webSearch: true,
          cliFeatures: { supportsWebSearch: false },
        }),
      (error) =>
        error.code === 'unsupported-capability' &&
        /version >= 0\.146\.0/.test(error.message)
    );
  });

  it('passes --output-schema when CLI supports it', function () {
    const result = buildCommand('codex', 'test context', {
      jsonSchema: { type: 'object', properties: { foo: { type: 'string' } } },
      cliFeatures: { supportsOutputSchema: true, supportsJson: true },
    });

    assert.ok(result.args.includes('--output-schema'));
    assert.ok(!result.args[result.args.length - 1].includes('OUTPUT FORMAT'));
    assert.strictEqual(result.cleanupMetadata.length, 1);
  });

  it('injects schema into context when CLI does not support --output-schema', function () {
    const schema = { type: 'object', properties: { foo: { type: 'string' } } };
    const result = buildCommand('codex', 'test context', {
      jsonSchema: schema,
      cliFeatures: { supportsOutputSchema: false, supportsJson: true },
    });

    assert.ok(!result.args.includes('--output-schema'));
    const finalContext = result.args[result.args.length - 1];
    assert.ok(finalContext.includes('## OUTPUT FORMAT (CRITICAL - REQUIRED)'));
    assert.ok(finalContext.includes('You MUST respond with a JSON object'));
    assert.ok(finalContext.includes('"foo"'));
  });

  it('does not inject schema when no jsonSchema is provided', function () {
    const result = buildCommand('codex', 'test context', {
      cliFeatures: { supportsOutputSchema: false, supportsJson: true },
    });

    const finalContext = result.args[result.args.length - 1];
    assert.strictEqual(finalContext, 'test context');
    assert.ok(!finalContext.includes('OUTPUT FORMAT'));
  });

  it('handles string jsonSchema', function () {
    const schemaStr = '{"type":"object","properties":{"bar":{"type":"number"}}}';
    const result = buildCommand('codex', 'test context', {
      jsonSchema: schemaStr,
      cliFeatures: { supportsOutputSchema: false, supportsJson: true },
    });

    const finalContext = result.args[result.args.length - 1];
    assert.ok(finalContext.includes('## OUTPUT FORMAT'));
    assert.ok(finalContext.includes('"bar"'));
  });

  it('includes --json flag when outputFormat is json', function () {
    const result = buildCommand('codex', 'test', {
      outputFormat: 'json',
      cliFeatures: { supportsJson: true },
    });

    assert.ok(result.args.includes('--json'));
  });

  it('includes --json flag when outputFormat is stream-json', function () {
    const result = buildCommand('codex', 'test', {
      outputFormat: 'stream-json',
      cliFeatures: { supportsJson: true },
    });

    assert.ok(result.args.includes('--json'));
  });
});

describe('Gemini provider helper builder', function () {
  it('warns when unsupported session control options are ignored', function () {
    const resumed = buildCommand('gemini', 'test context', {
      resumeSessionId: 'session-123',
    });
    assert.ok(!resumed.args.includes('--resume'));
    assert.ok(
      resumed.warnings.some(
        (warning) =>
          warning.code === 'unsupported-session-control' &&
          warning.message ===
            'Provider gemini does not support resume/continue session control; ignoring.'
      )
    );

    const continued = buildCommand('gemini', 'test context', {
      continueSession: true,
    });
    assert.ok(!continued.args.includes('--continue'));
    assert.ok(continued.warnings.some((warning) => warning.code === 'unsupported-session-control'));
  });

  it('always injects schema into context', function () {
    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    const result = buildCommand('gemini', 'test prompt', {
      jsonSchema: schema,
      cliFeatures: { supportsStreamJson: true },
    });

    const pIndex = result.args.indexOf('-p');
    const finalContext = result.args[pIndex + 1];

    assert.ok(finalContext.includes('## OUTPUT FORMAT (CRITICAL - REQUIRED)'));
    assert.ok(finalContext.includes('You MUST respond with a JSON object'));
    assert.ok(finalContext.includes('"result"'));
  });

  it('does not inject schema when no jsonSchema is provided', function () {
    const result = buildCommand('gemini', 'test prompt', {
      cliFeatures: { supportsStreamJson: true },
    });

    const pIndex = result.args.indexOf('-p');
    const finalContext = result.args[pIndex + 1];

    assert.strictEqual(finalContext, 'test prompt');
    assert.ok(!finalContext.includes('OUTPUT FORMAT'));
  });

  it('includes --output-format stream-json when supported', function () {
    const result = buildCommand('gemini', 'test', {
      outputFormat: 'json',
      cliFeatures: { supportsStreamJson: true },
    });

    assert.ok(result.args.includes('--output-format'));
    assert.ok(result.args.includes('stream-json'));
  });

  it('marks headless workspaces trusted for noninteractive Gemini runs', function () {
    const result = buildCommand('gemini', 'test', {
      cwd: '/tmp/project',
    });

    assert.strictEqual(result.env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
  });
});

describe('Opencode provider helper builder', function () {
  it('uses explicit-session precedence for native resume controls', function () {
    const resumed = buildCommand('opencode', 'test context', {
      resumeSessionId: 'session-123',
      continueSession: true,
      cliFeatures: { supportsResume: true },
    });
    assert.deepStrictEqual(resumed.args.slice(-3), [
      '--session',
      'session-123',
      'test context',
    ]);
    assert.strictEqual(resumed.args.includes('--continue'), false);

    const continued = buildCommand('opencode', 'test context', {
      continueSession: true,
      cliFeatures: { supportsResume: true },
    });
    assert.deepStrictEqual(continued.args.slice(-2), ['--continue', 'test context']);

    assert.throws(
      () =>
        buildCommand('opencode', 'test context', {
          resumeSessionId: 'session-123',
          cliFeatures: { supportsResume: false },
        }),
      /cannot safely run continuation context/
    );
  });

  it('extracts the OpenCode session ID used by resume commands', function () {
    assert.strictEqual(
      helper.extractProviderSessionId(
        'opencode',
        '{"type":"step_start","sessionID":"session-123","part":{}}'
      ),
      'session-123'
    );
  });

  it('keeps disabled search unchanged and enables EXA for fresh and resumed commands', function () {
    const absent = buildCommand('opencode', 'test context');
    const disabled = buildCommand('opencode', 'test context', { webSearch: false });
    assert.deepStrictEqual(disabled.args, absent.args);
    assert.deepStrictEqual(disabled.env, absent.env);

    const fresh = buildCommand('opencode', 'test context', {
      webSearch: true,
      cliFeatures: { supportsWebSearch: true },
    });
    assert.deepStrictEqual(fresh.env, { OPENCODE_ENABLE_EXA: '1' });

    const resumed = buildCommand('opencode', 'test context', {
      resumeSessionId: 'session-123',
      webSearch: true,
      cliFeatures: { supportsResume: true, supportsWebSearch: true },
    });
    assert.deepStrictEqual(resumed.args.slice(-3), ['--session', 'session-123', 'test context']);
    assert.deepStrictEqual(resumed.env, { OPENCODE_ENABLE_EXA: '1' });

    const continued = buildCommand('opencode', 'test context', {
      continueSession: true,
      webSearch: true,
      cliFeatures: { supportsResume: true, supportsWebSearch: true },
    });
    assert.deepStrictEqual(continued.args.slice(-2), ['--continue', 'test context']);
    assert.deepStrictEqual(continued.env, { OPENCODE_ENABLE_EXA: '1' });
  });

  it('fails closed when the OpenCode version is not attested', function () {
    assert.throws(
      () =>
        buildCommand('opencode', 'test context', {
          webSearch: true,
          cliFeatures: { supportsWebSearch: false },
        }),
      (error) =>
        error.code === 'unsupported-capability' &&
        /version >= 1\.0\.137/.test(error.message)
    );
  });

  it('injects schema into context when jsonSchema is provided', function () {
    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    const result = buildCommand('opencode', 'test prompt', {
      jsonSchema: schema,
      cliFeatures: { supportsJson: true },
    });

    const finalContext = result.args[result.args.length - 1];
    assert.ok(finalContext.includes('## OUTPUT FORMAT (CRITICAL - REQUIRED)'));
    assert.ok(finalContext.includes('You MUST respond with a JSON object'));
    assert.ok(finalContext.includes('"result"'));
  });

  it('includes --format json when outputFormat is json or stream-json', function () {
    const result = buildCommand('opencode', 'test', {
      outputFormat: 'json',
      cliFeatures: { supportsJson: true },
    });

    assert.ok(result.args.includes('--format'));
    assert.ok(result.args.includes('json'));
  });

  it('includes model and variant when provided', function () {
    const result = buildCommand('opencode', 'test', {
      modelSpec: { model: 'opencode/glm-4.7-free', reasoningEffort: 'high' },
      cliFeatures: { supportsJson: true, supportsVariant: true },
    });

    assert.ok(result.args.includes('--model'));
    assert.ok(result.args.includes('opencode/glm-4.7-free'));
    assert.ok(result.args.includes('--variant'));
    assert.ok(result.args.includes('high'));
  });

  it('prefers --dir over --cwd when opencode supports both', function () {
    const result = buildCommand('opencode', 'test', {
      cwd: '/tmp/worktree',
      cliFeatures: { supportsDir: true, supportsCwd: true },
    });

    assert.ok(result.args.includes('--dir'));
    assert.ok(!result.args.includes('--cwd'));
    assert.deepStrictEqual(result.args.slice(1, 3), ['--dir', '/tmp/worktree']);
  });

  it('falls back to --cwd when opencode does not support --dir', function () {
    const result = buildCommand('opencode', 'test', {
      cwd: '/tmp/worktree',
      cliFeatures: { supportsDir: false, supportsCwd: true },
    });

    assert.ok(!result.args.includes('--dir'));
    assert.ok(result.args.includes('--cwd'));
    assert.deepStrictEqual(result.args.slice(1, 3), ['--cwd', '/tmp/worktree']);
  });

  it('sets commandSpec.cwd even when neither --dir nor --cwd flag is supported', function () {
    const result = buildCommand('opencode', 'test prompt', {
      cwd: '/worktrees/spinning-cosmos-71',
      cliFeatures: { supportsDir: false, supportsCwd: false },
    });

    assert.strictEqual(result.cwd, '/worktrees/spinning-cosmos-71');
    assert.ok(!result.args.includes('--dir'));
    assert.ok(!result.args.includes('--cwd'));
  });

  it('detects worktree flags from opencode help text', function () {
    const { opencodeAdapter } = require('../lib/agent-cli-provider/adapters/opencode');
    const dirFeatures = opencodeAdapter.detectCliFeatures(
      'Usage: opencode run [options]\n  --dir  Working directory\n  --model  Model to use\n'
    );
    const cwdFeatures = opencodeAdapter.detectCliFeatures(
      'Usage: opencode run [options]\n  --cwd  Working directory\n'
    );

    assert.strictEqual(dirFeatures.supportsDir, true);
    assert.strictEqual(dirFeatures.supportsCwd, false);
    assert.strictEqual(cwdFeatures.supportsDir, false);
    assert.strictEqual(cwdFeatures.supportsCwd, true);
  });
});

describe('Pi provider helper builder', function () {
  it('fails closed when resume or continue session control is requested', function () {
    assert.throws(
      () =>
        buildCommand('pi', 'test context', {
          resumeSessionId: 'session-123',
        }),
      /does not support resume\/continue session control/
    );

    assert.throws(
      () =>
        buildCommand('pi', 'test context', {
          continueSession: true,
        }),
      /does not support resume\/continue session control/
    );
  });
});

describe('Copilot provider helper builder', function () {
  it('emits auto-approve flags when autoApprove is requested', function () {
    const spec = buildCommand('copilot', 'test context', {
      autoApprove: true,
    });
    assert.ok(spec.args.includes('--allow-all'));
    assert.ok(spec.args.includes('--no-ask-user'));
  });

  it('warns and ignores unsupported session control instead of failing closed', function () {
    const resumed = buildCommand('copilot', 'test context', {
      resumeSessionId: 'session-123',
    });
    assert.ok(!resumed.args.includes('--resume'));
    assert.ok(resumed.warnings.some((warning) => warning.code === 'unsupported-session-control'));
  });
});

describe('Claude provider helper builder', function () {
  const originalEnv = process.env.ZEROSHOT_CLAUDE_COMMAND;

  afterEach(function () {
    if (originalEnv === undefined) {
      delete process.env.ZEROSHOT_CLAUDE_COMMAND;
    } else {
      process.env.ZEROSHOT_CLAUDE_COMMAND = originalEnv;
    }
  });

  it('passes --json-schema when CLI supports it', function () {
    const schema = { type: 'object', properties: { foo: { type: 'string' } } };
    const result = buildCommand('claude', 'test context', {
      jsonSchema: schema,
      outputFormat: 'json',
      cliFeatures: { supportsJsonSchema: true },
    });

    assert.ok(result.args.includes('--json-schema'));
  });

  it('does not pass --json-schema when outputFormat is not json', function () {
    const schema = { type: 'object', properties: { foo: { type: 'string' } } };
    const result = buildCommand('claude', 'test context', {
      jsonSchema: schema,
      outputFormat: 'stream-json',
      cliFeatures: { supportsJsonSchema: true },
    });

    assert.ok(!result.args.includes('--json-schema'));
  });

  it('does not pass --json-schema when CLI does not support it', function () {
    const schema = { type: 'object', properties: { foo: { type: 'string' } } };
    const result = buildCommand('claude', 'test context', {
      jsonSchema: schema,
      outputFormat: 'json',
      cliFeatures: { supportsJsonSchema: false },
    });

    assert.ok(!result.args.includes('--json-schema'));
  });

  it('passes model value through without alias normalization', function () {
    const result = buildCommand('claude', 'test context', {
      modelSpec: { model: 'opus-4.6' },
      cliFeatures: { supportsModel: true },
    });

    const modelFlagIndex = result.args.indexOf('--model');
    assert.ok(modelFlagIndex >= 0);
    assert.strictEqual(result.args[modelFlagIndex + 1], 'opus-4.6');
  });

  it('adds Claude resume and continue args before the prompt', function () {
    const resumed = buildCommand('claude', 'test context', {
      resumeSessionId: 'session-123',
    });
    assert.deepStrictEqual(resumed.args.slice(-3), ['--resume', 'session-123', 'test context']);

    const continued = buildCommand('claude', 'test context', {
      continueSession: true,
    });
    assert.deepStrictEqual(continued.args.slice(-2), ['--continue', 'test context']);
  });

  it('fails closed when the installed Claude CLI cannot resume', function () {
    assert.throws(
      () =>
        buildCommand('claude', 'delta-only context', {
          resumeSessionId: 'session-123',
          cliFeatures: { supportsResume: false },
        }),
      /cannot safely run continuation context/
    );
  });

  it('honors configured Claude executable selection inside the helper', function () {
    process.env.ZEROSHOT_CLAUDE_COMMAND = 'ccr code';
    const result = buildCommand('claude', 'test context');

    assert.strictEqual(result.binary, 'ccr');
    assert.deepStrictEqual(result.args.slice(0, 3), ['code', '--print', '--input-format']);
  });
});

describe('Provider helper builder regressions', function () {
  it('Codex planner schema is injected when native schema support is unavailable', function () {
    const plannerSchema = {
      type: 'object',
      properties: {
        plan: { type: 'string' },
        summary: { type: 'string' },
        filesAffected: { type: 'array', items: { type: 'string' } },
      },
      required: ['plan', 'summary'],
    };

    const result = buildCommand('codex', 'Create a plan for implementing feature X', {
      jsonSchema: plannerSchema,
      outputFormat: 'json',
      cliFeatures: { supportsOutputSchema: false, supportsJson: true },
    });

    const finalContext = result.args[result.args.length - 1];

    assert.ok(finalContext.includes('OUTPUT FORMAT'));
    assert.ok(finalContext.includes('ONLY valid JSON'));
    assert.ok(finalContext.includes('"plan"'));
    assert.ok(finalContext.includes('"summary"'));
  });

  it('Gemini conductor schema is injected', function () {
    const conductorSchema = {
      type: 'object',
      properties: {
        complexity: { type: 'string', enum: ['TRIVIAL', 'SIMPLE', 'STANDARD', 'CRITICAL'] },
        taskType: { type: 'string', enum: ['INQUIRY', 'TASK', 'DEBUG'] },
        reasoning: { type: 'string' },
      },
      required: ['complexity', 'taskType', 'reasoning'],
    };

    const result = buildCommand('gemini', 'Classify this task', {
      jsonSchema: conductorSchema,
      outputFormat: 'json',
      cliFeatures: { supportsStreamJson: true },
    });

    const pIndex = result.args.indexOf('-p');
    const finalContext = result.args[pIndex + 1];

    assert.ok(finalContext.includes('OUTPUT FORMAT'));
    assert.ok(finalContext.includes('"complexity"'));
    assert.ok(finalContext.includes('"taskType"'));
  });
});
