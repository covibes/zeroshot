'use strict';

const assert = require('node:assert/strict');
const {
  createPullRequest,
  deterministicBranch,
  GitHubRequestError,
  prepareWorkspace,
  shipWorkspace,
} = require('../../zeroshot-rust/hosted-node/workspace-ship');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const CONFIG = Object.freeze({
  repository: 'the-open-engine/zeroshot',
  delivery: Object.freeze({
    version: 'zeroshot.delivery/v1',
    mode: 'pr',
    repository: 'the-open-engine/zeroshot',
    targetBranch: 'main',
    baseRevision: BASE,
  }),
});

function review(branch, baseRevision = TARGET) {
  return {
    number: 123,
    node_id: 'PR_node_123',
    state: 'open',
    html_url: 'https://github.com/the-open-engine/zeroshot/pull/123',
    head: { ref: branch, sha: HEAD, repo: { full_name: CONFIG.repository } },
    base: { ref: 'main', sha: baseRevision, repo: { full_name: CONFIG.repository } },
  };
}

function deliveryGit(calls, options = {}) {
  let headReads = 0;
  const fixedResponses = new Map([
    [
      'rev-parse refs/zeroshot/delivery-target',
      { stdout: `${options.targetRevision ?? TARGET}\n` },
    ],
    ['remote get-url origin', { stdout: 'https://github.com/the-open-engine/zeroshot.git\n' }],
    [
      'config --local --null --name-only --list',
      { stdout: 'core.repositoryformatversion\0remote.origin.url\0' },
    ],
    ['status --porcelain=v1 -z', { stdout: options.clean ? '' : ' M source.js\0' }],
  ]);
  return (args, timeout) => {
    calls.push({ args, timeout });
    const command = args.join(' ');
    if (command === 'rev-parse HEAD') {
      headReads += 1;
      return { stdout: `${headReads === 1 ? BASE : HEAD}\n` };
    }
    if (command.startsWith('merge-base --is-ancestor') && options.notAncestor) {
      throw new Error('not an ancestor');
    }
    return fixedResponses.get(command) ?? { stdout: '' };
  };
}

function shipConfig() {
  return { ...CONFIG, delivery: { ...CONFIG.delivery, mode: 'ship' } };
}

function shipDependencies(branch, overrides) {
  return {
    git: deliveryGit([]),
    createPullRequest: () => review(branch),
    ...overrides,
  };
}

function mergedReviewRequest(branch) {
  return (_repository, route) => {
    if (route.endsWith('/merge')) return { merged: true, sha: MERGE };
    return {
      ...review(branch),
      state: 'closed',
      merged: true,
      merged_at: '2026-08-08T00:00:00Z',
      merge_commit_sha: MERGE,
    };
  };
}

describe('private hosted Git delivery', () => {
  it('prepares a deterministic branch from the retained clean checkout', async () => {
    const calls = [];
    const git = deliveryGit(calls, { clean: true });
    const branch = await prepareWorkspace(CONFIG, 'cluster-1', git);
    assert.equal(branch, deterministicBranch('cluster-1'));
    assert.deepEqual(calls.at(-2).args, ['switch', '--detach', BASE]);
    assert.deepEqual(calls.at(-1).args, ['switch', '--create', branch]);
  });

  it('accepts a normally advanced target when the retained revision remains its ancestor', async () => {
    const branch = deterministicBranch('cluster-2');
    const calls = [];
    const receipt = await shipWorkspace(CONFIG, branch, {
      git: deliveryGit(calls, { targetRevision: MERGE }),
      createPullRequest: () => review(branch, TARGET),
    });
    assert.deepEqual(receipt, {
      ...CONFIG.delivery,
      disposition: 'pull_request_open',
      deliveryBranch: branch,
      headRevision: HEAD,
      pullRequestUrl: 'https://github.com/the-open-engine/zeroshot/pull/123',
    });
    assert.equal(
      calls.filter(({ args }) => args[0] === 'merge-base').length,
      2,
      'submission ancestry is checked before push and against the freshly fetched target'
    );
    assert.deepEqual(
      calls.filter(({ args }) => args[0] === 'merge-base').map(({ args }) => args.at(-1)),
      [MERGE, MERGE]
    );
  });

  it('fails both delivery modes when the provider made no workspace change', async () => {
    for (const mode of ['pr', 'ship']) {
      const config = { ...CONFIG, delivery: { ...CONFIG.delivery, mode } };
      await assert.rejects(
        shipWorkspace(config, deterministicBranch(`no-change-${mode}`), {
          git: deliveryGit([], { clean: true }),
        }),
        /without a workspace change/
      );
    }
  });

  it('rejects a retained revision that is not an ancestor of the current target', async () => {
    await assert.rejects(
      shipWorkspace(CONFIG, deterministicBranch('not-ancestor'), {
        git: deliveryGit([], { notAncestor: true }),
      }),
      /not an ancestor/
    );
  });
});

describe('private hosted pull request delivery', () => {
  it('binds the PR to the configured target branch instead of a mutable default lookup', async () => {
    const branch = deterministicBranch('cluster-review');
    const created = review(branch);
    let submitted;
    const result = await createPullRequest(CONFIG, branch, HEAD, (_repository, route, init) => {
      assert.equal(route, '/pulls');
      submitted = JSON.parse(init.body);
      return created;
    });
    assert.equal(result, created);
    assert.equal(submitted.base, 'main');
  });

  it('closes a created PR whose authority receipt is malformed', async () => {
    const branch = deterministicBranch('cluster-invalid');
    const requests = [];
    await assert.rejects(
      createPullRequest(CONFIG, branch, HEAD, (_repository, route, init) => {
        requests.push({ route, init });
        if (route === '/pulls/123') return { state: 'closed' };
        return { ...review(branch), html_url: 'not-a-pull-request-url' };
      }),
      /receipt is invalid/
    );
    assert.equal(requests.at(-1).route, '/pulls/123');
  });
});

describe('private hosted ship delivery', () => {
  it('succeeds only after an authoritative merge receipt', async () => {
    const branch = deterministicBranch('cluster-ship');
    const calls = [];
    const receipt = await shipWorkspace(
      shipConfig(),
      branch,
      shipDependencies(branch, {
        git: deliveryGit(calls, { targetRevision: MERGE }),
        github: mergedReviewRequest(branch),
      })
    );
    assert.equal(receipt.disposition, 'merged');
    assert.equal(receipt.mergeRevision, MERGE);
    assert.deepEqual(
      calls.filter(({ args }) => args[0] === 'merge-base').map(({ args }) => args.slice(-2)),
      [
        [BASE, MERGE],
        [BASE, MERGE],
        [BASE, MERGE],
        [MERGE, MERGE],
      ],
      'the authoritative merge revision is verified on a freshly fetched target'
    );
  });

  it('rejects a merge receipt that is absent from the post-merge target', async () => {
    const branch = deterministicBranch('cluster-ship-race');
    const git = deliveryGit([]);
    let ancestryChecks = 0;
    await assert.rejects(
      shipWorkspace(
        shipConfig(),
        branch,
        shipDependencies(branch, {
          git: (args, timeout) => {
            if (args[0] === 'merge-base' && ++ancestryChecks === 4) {
              return Promise.reject(new Error('not an ancestor'));
            }
            return git(args, timeout);
          },
          github: mergedReviewRequest(branch),
        })
      ),
      /merge revision is not on the delivery target/
    );
  });
});

describe('private hosted auto-merge delivery', () => {
  it('accepts policy-respecting merge-method auto-merge but never an open PR alone', async () => {
    const branch = deterministicBranch('cluster-auto-merge');
    const calls = [];
    const receipt = await shipWorkspace(
      shipConfig(),
      branch,
      shipDependencies(branch, {
        git: deliveryGit(calls),
        github: () => {
          throw new GitHubRequestError(405);
        },
        graphql: () => ({
          enablePullRequestAutoMerge: {
            pullRequest: {
              number: 123,
              baseRefName: 'main',
              headRefName: branch,
              headRefOid: HEAD,
              repository: { nameWithOwner: CONFIG.repository },
              autoMergeRequest: { enabledAt: '2026-08-08T00:00:00Z', mergeMethod: 'MERGE' },
            },
          },
        }),
      })
    );
    assert.equal(receipt.disposition, 'auto_merge_enabled');
    assert.equal(
      calls.filter(({ args }) => args[0] === 'merge-base').length,
      3,
      'the target is rechecked after authoritative auto-merge acceptance'
    );

    await assert.rejects(
      shipWorkspace(shipConfig(), deterministicBranch('cluster-open-only'), {
        git: deliveryGit([]),
        createPullRequest: () => review(deterministicBranch('cluster-open-only')),
        github: () => {
          throw new GitHubRequestError(401);
        },
      }),
      /GitHub rejected hosted delivery/
    );
  });
});
