const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  assertNoSecret,
  runProviderExecutable,
  runnerResult,
} = require('./executable-contract-helpers.cjs');

test('invoke rejects caller-supplied executable-resolution env before runner execution', async () => {
  for (const key of ['PATH', 'Path', 'path', 'PATHEXT']) {
    let runnerCalled = false;
    const response = await runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'codex',
        context: 'hi',
        env: {
          [key]: '/tmp/malicious-provider-bin',
        },
        options: {
          cliFeatures: {
            supportsSkipGitRepoCheck: false,
          },
        },
      },
      {
        runner: () => {
          runnerCalled = true;
          return runnerResult({ stdout: 'MALICIOUS-CODEX-RAN' });
        },
      }
    );

    assert.equal(response.exitCode, 2);
    assert.equal(response.envelope.ok, false);
    assert.equal(response.envelope.command, 'invoke');
    assert.equal(response.envelope.provider, 'codex');
    assert.equal(response.envelope.error.code, 'forbidden-field');
    assert.equal(response.envelope.error.field, `env.${key}`);
    assert.equal(runnerCalled, false);
    assertNoSecret(response.envelope, '/tmp/malicious-provider-bin');
  }
});

test('invoke rejects caller-supplied executable-resolution authEnv before runner execution', async () => {
  let runnerCalled = false;
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'claude',
      context: 'hi',
      options: {
        authEnv: {
          PATH: '/tmp/malicious-provider-bin',
        },
      },
    },
    {
      runner: () => {
        runnerCalled = true;
        return runnerResult({ stdout: 'MALICIOUS-CLAUDE-RAN' });
      },
    }
  );

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.command, 'invoke');
  assert.equal(response.envelope.provider, 'claude');
  assert.equal(response.envelope.error.code, 'forbidden-field');
  assert.equal(response.envelope.error.field, 'options.authEnv.PATH');
  assert.equal(runnerCalled, false);
  assertNoSecret(response.envelope, '/tmp/malicious-provider-bin');
});

test('invoke rejects caller-supplied process-control env before runner execution', async () => {
  const cases = [
    ['NODE_OPTIONS', '--require /tmp/pwn.cjs'],
    ['NODE_PATH', '/tmp/pwn-node-path'],
    ['LD_PRELOAD', '/tmp/pwn.so'],
    ['DYLD_INSERT_LIBRARIES', '/tmp/pwn.dylib'],
  ];

  for (const [key, value] of cases) {
    let runnerCalled = false;
    const response = await runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'codex',
        context: 'hi',
        env: {
          [key]: value,
        },
      },
      {
        runner: () => {
          runnerCalled = true;
          return runnerResult({ stdout: 'MALICIOUS-PROVIDER-RAN' });
        },
      }
    );

    assert.equal(response.exitCode, 2);
    assert.equal(response.envelope.ok, false);
    assert.equal(response.envelope.command, 'invoke');
    assert.equal(response.envelope.provider, 'codex');
    assert.equal(response.envelope.error.code, 'forbidden-field');
    assert.equal(response.envelope.error.field, `env.${key}`);
    assert.equal(runnerCalled, false);
    assertNoSecret(response.envelope, value);
  }
});

test('invoke rejects caller-supplied process-control authEnv before runner execution', async () => {
  let runnerCalled = false;
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'claude',
      context: 'hi',
      options: {
        authEnv: {
          NODE_OPTIONS: '--require /tmp/pwn.cjs',
        },
      },
    },
    {
      runner: () => {
        runnerCalled = true;
        return runnerResult({ stdout: 'MALICIOUS-CLAUDE-RAN' });
      },
    }
  );

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.command, 'invoke');
  assert.equal(response.envelope.provider, 'claude');
  assert.equal(response.envelope.error.code, 'forbidden-field');
  assert.equal(response.envelope.error.field, 'options.authEnv.NODE_OPTIONS');
  assert.equal(runnerCalled, false);
  assertNoSecret(response.envelope, '--require /tmp/pwn.cjs');
});

test('invoke rejects caller-supplied gateway runner env overrides before runner execution', async () => {
  let runnerCalled = false;
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'gateway',
      context: 'hi',
      env: {
        zeroshot_gateway_request: '{"context":"pwn"}',
      },
      options: {
        gateway: {
          baseUrl: 'http://127.0.0.1:11434',
          apiKey: 'gateway-secret-token',
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: ['.'],
            commands: ['node'],
          },
        },
      },
    },
    {
      runner: () => {
        runnerCalled = true;
        return runnerResult({ stdout: 'MALICIOUS-GATEWAY-RAN' });
      },
    }
  );

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.command, 'invoke');
  assert.equal(response.envelope.provider, 'gateway');
  assert.equal(response.envelope.error.code, 'forbidden-field');
  assert.equal(response.envelope.error.field, 'env.zeroshot_gateway_request');
  assert.equal(runnerCalled, false);
});

test('build-command keeps a trusted direct gateway key bound to its configured transport', () => {
  const helper = require('../../lib/agent-cli-provider');
  const settings = {
    providerSettings: {
      gateway: {
        baseUrl: 'https://trusted.example/api/v1',
        apiKey: 'trusted-settings-key',
        model: 'trusted/test-model',
        toolPolicy: { roots: ['.'], commands: [] },
      },
    },
  };

  assert.throws(
    () =>
      helper.prepareSingleAgentProviderCommand(
        {
          context: 'Edit the target file.',
          provider: 'gateway',
          options: { cwd: '/tmp', gateway: { baseUrl: 'https://attacker.example/api/v1' } },
        },
        settings
      ),
    /transport cannot override credential settings/
  );
});
