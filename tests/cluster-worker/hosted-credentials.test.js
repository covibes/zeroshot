'use strict';

const assert = require('node:assert/strict');
const {
  CREDENTIALS_ENV,
  HostedConfigError,
  installHostedWorkerConfiguration,
  loadHostedWorkerConfiguration,
} = require('../../zeroshot-rust/hosted-node/hosted-config');
const { credentialEnvKeysForProvider } = require('../../lib/agent-cli-provider/provider-registry');

const SELECTORS = Object.freeze({
  ZEROSHOT_HOSTED_REPOSITORY: 'the-open-engine/zeroshot',
  ZEROSHOT_HOSTED_BASE_REVISION: 'a'.repeat(40),
  ZEROSHOT_HOSTED_MODEL_LEVEL: 'level2',
});

function environment(provider, credentials) {
  return {
    ...SELECTORS,
    ZEROSHOT_HOSTED_PROVIDER: provider,
    [CREDENTIALS_ENV]: typeof credentials === 'string' ? credentials : JSON.stringify(credentials),
  };
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof HostedConfigError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('hosted worker credential boundary', () => {
  for (const [provider, expectedCredentials] of [
    ['claude', { ANTHROPIC_API_KEY: 'anthropic-canary' }],
    ['codex', { OPENAI_API_KEY: 'openai-canary' }],
    ['omp', { ANTHROPIC_API_KEY: 'anthropic-canary', OPENAI_API_KEY: 'openai-canary' }],
  ]) {
    it(`routes only registry-declared ${provider} credentials`, () => {
      for (const key of Object.keys(expectedCredentials)) {
        assert.ok(credentialEnvKeysForProvider(provider).includes(key));
      }
      const config = loadHostedWorkerConfiguration(
        environment(provider, {
          GH_TOKEN: 'git-canary',
          ANTHROPIC_API_KEY: 'anthropic-canary',
          OPENAI_API_KEY: 'openai-canary',
          ZEROSHOT_GATEWAY_API_KEY: 'gateway-canary',
        })
      );
      assert.equal(config.provider, provider);
      assert.deepEqual(config.workerEnvironment, {
        GH_TOKEN: 'git-canary',
        ...expectedCredentials,
      });
      assert.equal(Object.hasOwn(config.workerEnvironment, CREDENTIALS_ENV), false);
    });
  }

  it('rejects registry gateway without trusted nonsecret settings', () => {
    assert.deepEqual(credentialEnvKeysForProvider('gateway'), ['ZEROSHOT_GATEWAY_API_KEY']);
    expectCode('HOSTED_PROVIDER_CREDENTIAL_UNSUPPORTED', () =>
      loadHostedWorkerConfiguration(
        environment('gateway', {
          GH_TOKEN: 'git-canary',
          ZEROSHOT_GATEWAY_API_KEY: 'gateway-canary',
        })
      )
    );
  });

  it('removes the bundle and unrelated credentials before provider launch', () => {
    const workerEnvironment = environment('codex', {
      GH_TOKEN: 'git-canary',
      ANTHROPIC_API_KEY: 'other-canary',
      OPENAI_API_KEY: 'openai-canary',
    });
    workerEnvironment.ANTHROPIC_API_KEY = 'inherited-canary';
    const configuration = installHostedWorkerConfiguration(workerEnvironment);
    assert.deepEqual(configuration.workerEnvironment, {
      GH_TOKEN: 'git-canary',
      OPENAI_API_KEY: 'openai-canary',
    });
    assert.equal(Object.hasOwn(workerEnvironment, CREDENTIALS_ENV), false);
    assert.equal(Object.hasOwn(workerEnvironment, 'ANTHROPIC_API_KEY'), false);
    assert.equal(workerEnvironment.GH_TOKEN, 'git-canary');
    assert.equal(workerEnvironment.OPENAI_API_KEY, 'openai-canary');
  });

  it('rejects missing, malformed, duplicate, unknown, empty, and oversized credentials', () => {
    const missing = environment('codex', { GH_TOKEN: 'git', OPENAI_API_KEY: 'provider' });
    delete missing[CREDENTIALS_ENV];
    expectCode('HOSTED_CREDENTIALS_MISSING', () => loadHostedWorkerConfiguration(missing));

    for (const encoded of [
      '[]',
      '{"GH_TOKEN":"git","OPENAI_API_KEY":false}',
      '{"GH_TOKEN":"git","GH_TOKEN":"again","OPENAI_API_KEY":"provider"}',
      '{"GH_TOKEN":"git","UNKNOWN_SECRET":"canary","OPENAI_API_KEY":"provider"}',
      '{"GH_TOKEN":"","OPENAI_API_KEY":"provider"}',
      JSON.stringify({ GH_TOKEN: 'git', OPENAI_API_KEY: 'x'.repeat(16 * 1024 + 1) }),
      `{"GH_TOKEN":"git","OPENAI_API_KEY":"provider","padding":"${'x'.repeat(64 * 1024)}"}`,
    ]) {
      expectCode('HOSTED_CREDENTIALS_INVALID', () =>
        loadHostedWorkerConfiguration(environment('codex', encoded))
      );
    }
  });

  it('uses closed missing and unsupported provider credential failures without canary disclosure', () => {
    for (const [provider, credentials, code] of [
      ['codex', { OPENAI_API_KEY: 'provider-canary' }, 'HOSTED_GIT_CREDENTIAL_MISSING'],
      [
        'codex',
        { GH_TOKEN: 'git-canary', ANTHROPIC_API_KEY: 'other-canary' },
        'HOSTED_PROVIDER_CREDENTIAL_MISSING',
      ],
      ['pi', { GH_TOKEN: 'git-canary' }, 'HOSTED_PROVIDER_CREDENTIAL_UNSUPPORTED'],
    ]) {
      assert.throws(
        () => loadHostedWorkerConfiguration(environment(provider, credentials)),
        (error) => {
          assert.equal(error.code, code);
          const rendered = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
          assert.doesNotMatch(rendered, /canary|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
          return true;
        }
      );
    }
  });

  it('rejects malformed fixed selectors and provider aliases before returning configuration', () => {
    for (const patch of [
      { ZEROSHOT_HOSTED_REPOSITORY: 'Owner/Repo' },
      { ZEROSHOT_HOSTED_REPOSITORY: 'github.com/owner/repo' },
      { ZEROSHOT_HOSTED_BASE_REVISION: 'abc123' },
      { ZEROSHOT_HOSTED_PROVIDER: 'openai' },
      { ZEROSHOT_HOSTED_MODEL_LEVEL: 'level4' },
    ]) {
      expectCode('HOSTED_CONFIGURATION_INVALID', () =>
        loadHostedWorkerConfiguration({
          ...environment('codex', { GH_TOKEN: 'git', OPENAI_API_KEY: 'provider' }),
          ...patch,
        })
      );
    }
  });
});
