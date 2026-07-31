const assert = require('node:assert/strict');
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

test('omp buildCommand fails closed on resume/continue session control', () => {
  assert.throws(
    () =>
      buildCommand('prompt', {
        resumeSessionId: 'session-123',
        cliFeatures: FULL_FEATURES,
      }),
    (error) => {
      assert.equal(error.name, 'ContractRequestError');
      assert.equal(error.field, 'options.resumeSessionId');
      assert.equal(error.exitCode, 2);
      return true;
    }
  );

  assert.throws(
    () =>
      buildCommand('prompt', {
        continueSession: true,
        cliFeatures: FULL_FEATURES,
      }),
    (error) => {
      assert.equal(error.name, 'ContractRequestError');
      assert.equal(error.field, 'options.continueSession');
      assert.equal(error.exitCode, 2);
      return true;
    }
  );
});

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
