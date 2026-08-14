'use strict';

const assert = require('node:assert/strict');
const {
  createHostedClusterEngineAdapter,
  validateRequestAuthority,
  withholdGitCredentials,
} = require('../../zeroshot-rust/hosted-node/engine-adapter');
const { deterministicBranch } = require('../../zeroshot-rust/hosted-node/workspace-ship');

const CONFIG = Object.freeze({
  repository: 'the-open-engine/zeroshot',
  baseRevision: 'a'.repeat(40),
  delivery: Object.freeze({
    version: 'zeroshot.delivery/v1',
    mode: 'pr',
    repository: 'the-open-engine/zeroshot',
    targetBranch: 'main',
    baseRevision: 'a'.repeat(40),
  }),
  executable: 'codex',
  provider: 'azure-openai',
  runtimeEnvironment: Object.freeze({ FUTURE_PROVIDER_TOKEN: 'provider-canary' }),
  settings: Object.freeze({ defaultProvider: 'codex' }),
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

function profile() {
  return Object.freeze({
    plan: Object.freeze({ isolation: 'worktree', delivery: 'none', autoMerge: false }),
    deployment: Object.freeze({ prepared: true }),
    provider: Object.freeze({
      config: Object.freeze({ agents: [] }),
      validateConfig: true,
      providerOverride: 'codex',
    }),
    bounds: Object.freeze({ shutdownMs: 1000 }),
  });
}

function installGitTokens(ghToken, githubToken) {
  const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_TOKEN = ghToken;
  process.env.GITHUB_TOKEN = githubToken;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function runsInnerClusterAndDeliversAfterCleanup() {
  const restoreTokens = installGitTokens('git-canary', 'github-canary');
  const events = [];
  const calls = [];
  let emit;
  const inner = {
    start(options) {
      calls.push(['start', options]);
      assert.equal(process.env.GH_TOKEN, undefined);
      assert.equal(process.env.GITHUB_TOKEN, undefined);
      emit = options.onEvent;
      emit({ type: 'running' });
      return { clusterId: options.clusterId, artifactsStaged: true };
    },
    status: () => ({ clusterId: 'cluster-1', state: 'running' }),
    stop() {
      calls.push(['stop']);
      assert.equal(process.env.GH_TOKEN, undefined);
      return { effective: true };
    },
    waitForCleanup() {
      calls.push(['cleanup']);
    },
    close() {},
  };
  const adapter = createHostedClusterEngineAdapter(CONFIG, {
    requireHostedEnvironment() {},
    createEngine: () => inner,
    prepareWorkspace() {
      calls.push(['prepare']);
      assert.equal(process.env.GH_TOKEN, 'git-canary');
      return 'zeroshot/hosted-branch';
    },
    shipWorkspace(_config, branch) {
      calls.push(['ship']);
      assert.equal(branch, 'zeroshot/hosted-branch');
      assert.equal(process.env.GH_TOKEN, 'git-canary');
      assert.equal(process.env.GITHUB_TOKEN, 'github-canary');
      return {
        disposition: 'pull_request_open',
        repository: CONFIG.repository,
        deliveryBranch: branch,
        headRevision: 'b'.repeat(40),
        pullRequestUrl: 'https://github.com/the-open-engine/zeroshot/pull/1',
      };
    },
  });
  try {
    await adapter.start({
      request: request(),
      profile: profile(),
      clusterId: 'cluster-1',
      onEvent: (event) => events.push(event),
    });
    const started = calls.find(([name]) => name === 'start')[1];
    assert.equal(started.profile.deployment.preparedWorktree.path, '/workspace');
    assert.equal(started.profile.deployment.preparedWorktree.branch, 'zeroshot/hosted-branch');
    assert.equal(started.profile.deployment.preparedWorktree.baseSha, CONFIG.baseRevision);
    assert.equal(started.profile.plan.delivery, 'none');
    emit({ type: 'complete', summary: 'inner complete' });
    await adapter.waitForCleanup();
    assert.deepEqual(
      calls.map(([name]) => name),
      ['prepare', 'start', 'stop', 'cleanup', 'ship']
    );
    assert.deepEqual(events, [
      { type: 'running' },
      {
        type: 'complete',
        result: {
          summary: 'Hosted worker completed pull_request_open',
          status: 'succeeded',
          artifacts: [],
          repository: CONFIG.repository,
          branch: 'zeroshot/hosted-branch',
          headRevision: 'b'.repeat(40),
          pullRequestUrl: 'https://github.com/the-open-engine/zeroshot/pull/1',
        },
      },
    ]);
  } finally {
    restoreTokens();
  }
}

async function hydratesPrivateIssueBeforeWithholdingCredentials() {
  const restoreTokens = installGitTokens('git-canary', 'github-canary');
  const calls = [];
  const issueRequest = {
    ...request(),
    source: 'issue',
    issue: 'https://github.com/the-open-engine/zeroshot/issues/42',
    prompt: null,
  };
  const hydrated = { ...issueRequest, source: 'prompt', issue: null, prompt: '# Issue 42' };
  const inner = {
    start(options) {
      calls.push(['start', options.request]);
      assert.equal(process.env.GH_TOKEN, undefined);
      assert.deepEqual(options.request, hydrated);
      return { clusterId: options.clusterId, artifactsStaged: true };
    },
    status: () => ({ clusterId: 'cluster-issue', state: 'running' }),
    stop: () => ({ effective: true }),
    waitForCleanup() {},
    close() {},
  };
  const adapter = createHostedClusterEngineAdapter(CONFIG, {
    requireHostedEnvironment() {},
    createEngine: () => inner,
    hydrateIssueRequest(config, incoming) {
      calls.push(['hydrate']);
      assert.equal(config, CONFIG);
      assert.equal(incoming, issueRequest);
      assert.equal(process.env.GH_TOKEN, 'git-canary');
      return hydrated;
    },
    prepareWorkspace() {
      calls.push(['prepare']);
      assert.equal(process.env.GH_TOKEN, 'git-canary');
      return 'zeroshot/hosted-issue';
    },
  });
  try {
    await adapter.start({
      request: issueRequest,
      profile: profile(),
      clusterId: 'cluster-issue',
      onEvent() {},
    });
    assert.deepEqual(
      calls.map(([name]) => name),
      ['hydrate', 'prepare', 'start']
    );
  } finally {
    restoreTokens();
  }
}

function withholdsCredentialsUntilRestored() {
  const restoreTokens = installGitTokens('gh', 'github');
  try {
    const restore = withholdGitCredentials();
    assert.equal(process.env.GH_TOKEN, undefined);
    assert.equal(process.env.GITHUB_TOKEN, undefined);
    restore();
    assert.equal(process.env.GH_TOKEN, 'gh');
    assert.equal(process.env.GITHUB_TOKEN, 'github');
  } finally {
    restoreTokens();
  }
}

function rejectsAuthorityMismatches() {
  for (const [patch, code] of [
    [{ repository: 'other/repository' }, 'HOSTED_REPOSITORY_MISMATCH'],
    [{ provider: 'claude' }, 'HOSTED_PROVIDER_MISMATCH'],
  ]) {
    assert.throws(
      () => validateRequestAuthority(CONFIG, { ...request(), ...patch }),
      (error) => error.code === code
    );
  }
}

function derivesOpaqueStableBranch() {
  const branch = deterministicBranch('cluster:hosted-1');
  assert.equal(branch, deterministicBranch('cluster:hosted-1'));
  assert.match(branch, /^zeroshot\/hosted-[0-9a-f]{20}$/);
  assert.doesNotMatch(branch, /canary|cluster/);
}

describe('hosted opaque cluster adapter', () => {
  it(
    'runs the current Node engine in the prepared workspace and delivers only after cleanup',
    runsInnerClusterAndDeliversAfterCleanup
  );
  it('withholds both Git credentials until explicitly restored', withholdsCredentialsUntilRestored);
  it(
    'hydrates private issue input before withholding Git credentials from providers',
    hydratesPrivateIssueBeforeWithholdingCredentials
  );
  it('rejects repository and runtime provider authority mismatches', rejectsAuthorityMismatches);
  it('derives a stable opaque branch', derivesOpaqueStableBranch);
});
