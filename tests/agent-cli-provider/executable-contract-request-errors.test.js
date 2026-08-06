const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  assertNoSecret,
  runExecutable,
  runProviderExecutable,
  runnerResult,
} = require('./executable-contract-helpers.cjs');

test('malformed JSON returns structured parse error envelope', () => {
  const response = runExecutable('{not json');

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'malformed-json');
});

test('unknown command returns structured command error envelope', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'unknown',
    provider: 'codex',
  });

  assert.equal(response.exitCode, 3);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'unknown-command');
});

test('unknown command redacts env-matched command in error envelope', () => {
  const secret = 'abc123-secret-token';
  const response = runExecutable({
    schemaVersion: 1,
    command: secret,
    provider: 'codex',
    env: {
      API_TOKEN: secret,
    },
  });

  assert.equal(response.exitCode, 3);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'unknown-command');
  assert.equal(response.envelope.command, '[REDACTED:API_TOKEN]');
  assertNoSecret(response.envelope, secret);
});

test('unknown provider returns structured provider error envelope', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'probe',
    provider: 'unknown',
  });

  assert.equal(response.exitCode, 4);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'unknown-provider');
  assert.equal(
    response.envelope.error.message,
    'Unknown provider: unknown. Valid: claude, codex, gateway, gemini, opencode, pi, omp, kiro, copilot'
  );
});

test('unknown provider redacts env-matched provider in error envelope', () => {
  const secret = 'abc123-secret-token';
  const response = runExecutable({
    schemaVersion: 1,
    command: 'probe',
    provider: secret,
    env: {
      API_TOKEN: secret,
    },
  });

  assert.equal(response.exitCode, 4);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'unknown-provider');
  assert.equal(response.envelope.provider, '[REDACTED:API_TOKEN]');
  assertNoSecret(response.envelope, secret);
});

test('missing required fields return structured validation error envelope', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'codex',
  });

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'missing-field');
  assert.equal(response.envelope.error.field, 'context');
});

test('build-command rejects caller-supplied provider command overrides', () => {
  for (const options of [{ command: '/bin/echo' }, { commandArgs: ['non-provider-executed'] }]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'build-command',
      provider: 'claude',
      context: 'hi',
      options,
    });

    assert.equal(response.exitCode, 2);
    assert.equal(response.envelope.ok, false);
    assert.equal(response.envelope.error.code, 'forbidden-field');
    assert.match(response.envelope.error.field, /^options\.command/);
  }
});

test('invoke rejects caller-supplied provider command overrides before runner execution', async () => {
  let runnerCalled = false;
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'claude',
      context: 'hi',
      options: {
        command: '/bin/echo',
        commandArgs: ['non-provider-executed'],
      },
    },
    {
      runner: () => {
        runnerCalled = true;
        return runnerResult();
      },
    }
  );

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'forbidden-field');
  assert.equal(response.envelope.error.field, 'options.command');
  assert.equal(runnerCalled, false);
});
