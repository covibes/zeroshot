'use strict';

const assert = require('node:assert/strict');
const {
  providerInvocation,
  validateRequestAuthority,
  withoutGitCredential,
} = require('../../zeroshot-rust/hosted-node/engine-adapter');
const { deterministicBranch } = require('../../zeroshot-rust/hosted-node/workspace-ship');

const CONFIG = Object.freeze({
  repository: 'the-open-engine/zeroshot',
  baseRevision: 'a'.repeat(40),
  executable: 'codex',
  provider: 'azure-openai',
  model: 'future/model',
  runtimeEnvironment: Object.freeze({
    FUTURE_PROVIDER_TOKEN: 'provider-canary',
  }),
  settings: Object.freeze({ defaultProvider: 'future-provider' }),
});

function request() {
  return {
    source: 'prompt',
    prompt: 'complete the task',
    artifacts: [],
    isolationProfile: 'isolation.prepared-worktree@1',
    providerProfile: 'provider.hosted-direct@1',
    repository: CONFIG.repository,
    provider: CONFIG.provider,
    modelLevel: 'level3',
  };
}

describe('hosted direct provider adapter', () => {
  it('constructs one provider-neutral invocation from the resolved runtime', () => {
    const invocation = providerInvocation(CONFIG, request());
    assert.equal(invocation.provider, 'codex');
    assert.deepEqual(invocation.options, {
      authEnv: {
        FUTURE_PROVIDER_TOKEN: 'provider-canary',
      },
      autoApprove: true,
      cwd: '/workspace',
      executionContext: 'docker',
      modelSpec: { model: 'future/model' },
    });
    assert.equal(Object.hasOwn(invocation, 'env'), false);
    assert.equal(Object.hasOwn(invocation, 'model'), false);
    assert.equal(Object.hasOwn(invocation.options.authEnv, 'GH_TOKEN'), false);
    assert.equal(
      Object.hasOwn(invocation.options.authEnv, 'ZEROSHOT_HOSTED_CREDENTIALS_JSON'),
      false
    );
    assert.equal(Object.hasOwn(invocation.options.authEnv, 'OPENAI_API_KEY'), false);
  });

  it('keeps built-in provider and executable selection unchanged', () => {
    const config = { ...CONFIG, executable: 'claude', provider: 'claude' };
    assert.equal(providerInvocation(config, { ...request(), provider: 'claude' }).provider, 'claude');
  });

  it('withholds the Git credential from the provider process and restores it for delivery', async () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'git-canary';
    try {
      assert.equal(await withoutGitCredential(() => process.env.GH_TOKEN), undefined);
      assert.equal(process.env.GH_TOKEN, 'git-canary');
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });

  it('rejects repository and runtime provider authority mismatches with closed codes', () => {
    for (const [patch, code] of [
      [{ repository: 'other/repository' }, 'HOSTED_REPOSITORY_MISMATCH'],
      [{ provider: 'claude' }, 'HOSTED_PROVIDER_MISMATCH'],
    ]) {
      assert.throws(
        () => validateRequestAuthority(CONFIG, { ...request(), ...patch }),
        (error) => error.code === code
      );
    }
  });

  it('derives a stable branch without embedding request or credential material', () => {
    const branch = deterministicBranch('cluster:hosted-1');
    assert.equal(branch, deterministicBranch('cluster:hosted-1'));
    assert.match(branch, /^zeroshot\/hosted-[0-9a-f]{20}$/);
    assert.doesNotMatch(branch, /canary|cluster/);
  });
});
