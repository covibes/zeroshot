const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const helper = require('../../lib/agent-cli-provider');

const FULL_FEATURES = {
  supportsModeJson: true,
  supportsPrint: true,
  supportsCwd: true,
  supportsAutoApprove: true,
  supportsModel: true,
  supportsThinking: true,
  supportsNoExtensions: true,
  supportsNoSkills: true,
  supportsNoRules: true,
  supportsNoTitle: true,
};

function buildCommand(context, options = {}) {
  return helper.buildProviderCommand('omp', context, options);
}

test('omp buildCommand emits exact argv for a fully-featured build', () => {
  const spec = buildCommand('prompt', {
    cwd: '/tmp/x',
    modelSpec: { level: 'level3', model: 'm', reasoningEffort: 'high' },
    cliFeatures: FULL_FEATURES,
  });

  assert.equal(spec.binary, 'omp');
  assert.deepEqual(spec.args, [
    '--mode',
    'json',
    '-p',
    '--cwd',
    '/tmp/x',
    '--auto-approve',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-title',
    '--model',
    'm',
    '--thinking',
    'high',
    'prompt',
  ]);
  assert.equal(spec.cwd, '/tmp/x');
});

test('omp buildCommand omits every optional flag explicitly reported unsupported', () => {
  const spec = buildCommand('prompt', {
    modelSpec: { level: 'level3', model: 'm', reasoningEffort: 'high' },
    cliFeatures: {
      ...FULL_FEATURES,
      supportsModel: false,
      supportsThinking: false,
      supportsNoExtensions: false,
      supportsNoSkills: false,
      supportsNoRules: false,
      supportsNoTitle: false,
    },
  });

  assert.deepEqual(spec.args, ['--mode', 'json', '-p', '--auto-approve', 'prompt']);
  assert.deepEqual(
    spec.warnings.map(({ code }) => code),
    ['omp-model-unsupported', 'omp-thinking-unsupported']
  );
});

for (const [flag, label] of [
  ['supportsModeJson', '--mode json'],
  ['supportsPrint', '-p/--print'],
  ['supportsCwd', '--cwd'],
  ['supportsAutoApprove', '--auto-approve'],
]) {
  test(`omp buildCommand fails closed when ${flag} is absent`, () => {
    assert.throws(
      () =>
        buildCommand('prompt', {
          cliFeatures: { ...FULL_FEATURES, [flag]: false },
        }),
      (error) => {
        assert.equal(error.name, 'ContractRequestError');
        assert.equal(error.code, 'unsupported-provider-cli');
        assert.equal(error.exitCode, 2);
        assert.ok(error.message.includes(label), error.message);
        return true;
      }
    );
  });
}

test('omp buildCommand always fails closed on continueSession regardless of cliFeatures', () => {
  for (const cliFeatures of [FULL_FEATURES, { ...FULL_FEATURES, supportsResume: true }]) {
    assert.throws(
      () => buildCommand('prompt', { continueSession: true, cliFeatures }),
      (error) => {
        assert.equal(error.name, 'ContractRequestError');
        assert.equal(error.field, 'options.continueSession');
        assert.equal(error.exitCode, 2);
        return true;
      }
    );
  }
});

test('omp buildCommand fails closed on resumeSessionId when supportsResume is not true', () => {
  for (const cliFeatures of [FULL_FEATURES, { ...FULL_FEATURES, supportsResume: false }]) {
    assert.throws(
      () => buildCommand('prompt', { resumeSessionId: 'session-123', cliFeatures }),
      (error) => {
        assert.equal(error.name, 'ContractRequestError');
        assert.equal(error.code, 'unsupported-provider-cli');
        assert.equal(error.field, 'options.resumeSessionId');
        assert.equal(error.exitCode, 2);
        return true;
      }
    );
  }
});

test('omp buildCommand passes --resume <id> immediately before the prompt when supported', () => {
  const spec = buildCommand('prompt', {
    resumeSessionId: 'session-123',
    cliFeatures: { ...FULL_FEATURES, supportsResume: true },
  });

  assert.deepEqual(spec.args.slice(-3), ['--resume', 'session-123', 'prompt']);
});

for (const [description, helpText, expected] of [
  ['empty help text', '', false],
  ['help text without --resume', '--mode json\n-p, --print', false],
  ['help text with --resume', '--resume <id>  Resume a session', true],
]) {
  test(`omp detectCliFeatures supportsResume: ${description}`, () => {
    const adapter = helper.getProviderAdapter('omp');
    assert.equal(adapter.detectCliFeatures(helpText).supportsResume, expected);
  });
}

const fixtureHeaderLine = fs
  .readFileSync(path.join(__dirname, '../fixtures/omp/text.jsonl'), 'utf8')
  .split('\n')[0];

for (const [description, line, expected] of [
  ['a valid session header', '{"type":"session","version":3,"id":"omp-1"}', 'omp-1'],
  ['a session frame missing id', '{"type":"session","version":3}', null],
  ['a session frame with an empty id', '{"type":"session","id":""}', null],
  ['a non-session frame carrying an id-like field', '{"type":"turn_start","id":"omp-1"}', null],
  ['malformed JSON', '{not-json', null],
  ['the real OMP text fixture header line', fixtureHeaderLine, 'omp-text'],
]) {
  test(`omp extractSessionId handles ${description}`, () => {
    const adapter = helper.getProviderAdapter('omp');
    assert.equal(adapter.extractSessionId(line), expected);
  });
}

test('omp parseEvent returns null for a malformed JSONL line without throwing', () => {
  const adapter = helper.getProviderAdapter('omp');
  const state = adapter.createParserState();
  assert.equal(adapter.parseEvent('not json', state), null);
  assert.equal(adapter.parseEvent('{"unterminated": ', state), null);
});

test('omp classifyError marks retryable vs permanent errors', () => {
  const adapter = helper.getProviderAdapter('omp');

  for (const message of ['rate limit exceeded', 'quota exceeded', 'service overloaded']) {
    assert.equal(adapter.classifyError(new Error(message)).retryable, true, message);
  }

  for (const message of [
    'authentication required: run /login',
    'unknown option --bogus',
    'cannot find module omp',
  ]) {
    assert.equal(adapter.classifyError(new Error(message)).retryable, false, message);
  }
});
