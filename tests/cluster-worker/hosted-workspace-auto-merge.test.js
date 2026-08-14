'use strict';

const assert = require('node:assert/strict');
const {
  GitHubGraphqlError,
  GitHubRequestError,
  mergePullRequest,
} = require('../../zeroshot-rust/hosted-node/workspace-delivery-github');

const HEAD = 'b'.repeat(40);
const MERGE = 'd'.repeat(40);
const MERGED_RECEIPT = Object.freeze({ disposition: 'merged', mergeRevision: MERGE });
const UPDATED_HEAD = 'e'.repeat(40);
const REPOSITORY = 'the-open-engine/zeroshot';
const CONFIG = Object.freeze({
  repository: REPOSITORY,
  delivery: Object.freeze({ targetBranch: 'main' }),
});

function review(branch, overrides = {}) {
  return {
    number: 123,
    state: 'open',
    head: { ref: branch, sha: HEAD, repo: { full_name: REPOSITORY } },
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

function autoMergeGraphql(branch) {
  return () => ({
    enablePullRequestAutoMerge: {
      pullRequest: {
        number: 123,
        baseRefName: 'main',
        headRefName: branch,
        headRefOid: HEAD,
        repository: { nameWithOwner: REPOSITORY },
        autoMergeRequest: { enabledAt: '2026-08-08T00:00:00Z', mergeMethod: 'MERGE' },
      },
    },
  });
}

function mergedReview(branch, overrides = {}) {
  return review(branch, {
    state: 'closed',
    merged: true,
    merged_at: '2026-08-08T00:00:00Z',
    merge_commit_sha: MERGE,
    ...overrides,
  });
}

function deliveryOptions(branch, overrides) {
  return {
    config: CONFIG,
    created: { ...review(branch), node_id: 'PR_node_123' },
    branch,
    headRevision: HEAD,
    wait: () => Promise.resolve(),
    ...overrides,
  };
}

describe('private hosted auto-merge delivery', () => {
  it('updates a concurrently-behind branch and succeeds only after authoritative merge', async () => {
    const branch = 'zeroshot/hosted-auto-merge';
    const requests = [];
    const reviews = [
      review(branch, { mergeable_state: 'behind' }),
      review(branch, { mergeable_state: 'behind' }),
      review(branch, {
        head: { ref: branch, sha: UPDATED_HEAD, repo: { full_name: REPOSITORY } },
        mergeable_state: 'clean',
      }),
      mergedReview(branch, {
        head: { ref: branch, sha: UPDATED_HEAD, repo: { full_name: REPOSITORY } },
      }),
    ];
    const request = (_repository, route, init) => {
      requests.push({ route, init });
      if (route.endsWith('/merge')) throw new GitHubRequestError(405);
      const updates = requests.filter(({ route: value }) => value.endsWith('/update-branch'));
      if (route.endsWith('/update-branch') && updates.length === 1) {
        throw new GitHubRequestError(422);
      }
      if (route.endsWith('/update-branch')) return { message: 'Updating pull request branch.' };
      return reviews.shift();
    };

    const receipt = await mergePullRequest(
      deliveryOptions(branch, {
        request,
        graphql: autoMergeGraphql(branch),
      })
    );

    assert.deepEqual(receipt, MERGED_RECEIPT);
    const updates = requests.filter(({ route }) => route.endsWith('/update-branch'));
    assert.equal(updates.length, 2, 'a stale guarded update is retried');
    assert.deepEqual(JSON.parse(updates[0].init.body), { expected_head_sha: HEAD });
  });

  it('never accepts an open PR alone', async () => {
    const branch = 'zeroshot/hosted-open-only';
    await assert.rejects(
      mergePullRequest(
        deliveryOptions(branch, {
          request: () => {
            throw new GitHubRequestError(401);
          },
          graphql: autoMergeGraphql(branch),
        })
      ),
      /GitHub rejected hosted delivery/
    );
  });
});

describe('private hosted auto-merge resilience', () => {
  it('retries a transient auto-merge mutation only after reconciling GitHub state', async () => {
    const branch = 'zeroshot/hosted-retry-auto-merge';
    let graphqlAttempts = 0;
    const reviews = [
      review(branch, { mergeable_state: 'blocked', auto_merge: null }),
      review(branch, { mergeable_state: 'blocked' }),
      mergedReview(branch),
    ];
    const request = (_repository, route) => {
      if (route.endsWith('/merge')) throw new GitHubRequestError(405);
      return reviews.shift();
    };
    const graphql = () => {
      graphqlAttempts += 1;
      if (graphqlAttempts === 1) throw new GitHubGraphqlError();
      return autoMergeGraphql(branch)();
    };

    const receipt = await mergePullRequest(
      deliveryOptions(branch, {
        request,
        graphql,
      })
    );

    assert.equal(graphqlAttempts, 2);
    assert.deepEqual(receipt, MERGED_RECEIPT);
  });

  it('accepts reconciled auto-merge authority after a lost mutation response', async () => {
    const branch = 'zeroshot/hosted-reconciled-auto-merge';
    let graphqlAttempts = 0;
    const reviews = [
      review(branch, {
        mergeable_state: 'blocked',
        auto_merge: { merge_method: 'merge' },
      }),
      mergedReview(branch),
    ];
    const request = (_repository, route) => {
      if (route.endsWith('/merge')) throw new GitHubRequestError(405);
      return reviews.shift();
    };

    const receipt = await mergePullRequest(
      deliveryOptions(branch, {
        request,
        graphql: () => {
          graphqlAttempts += 1;
          throw new TypeError('response lost');
        },
      })
    );

    assert.equal(graphqlAttempts, 1);
    assert.deepEqual(receipt, MERGED_RECEIPT);
  });
});

describe('private hosted auto-merge paired failures', () => {
  it('bounds transient mutation and reconciliation failures together', async () => {
    const branch = 'zeroshot/hosted-retry-reconciliation';
    let graphqlAttempts = 0;
    let reviewAttempts = 0;
    const request = (_repository, route) => {
      if (route.endsWith('/merge')) throw new GitHubRequestError(405);
      reviewAttempts += 1;
      if (reviewAttempts === 1) throw new GitHubRequestError(502);
      return review(branch, { mergeable_state: 'blocked', auto_merge: null });
    };

    await assert.rejects(
      mergePullRequest(
        deliveryOptions(branch, {
          request,
          graphql: () => {
            graphqlAttempts += 1;
            throw new GitHubGraphqlError();
          },
          enableAttempts: 2,
        })
      ),
      /did not enable hosted auto-merge after bounded retries/
    );

    assert.equal(graphqlAttempts, 2);
    assert.equal(reviewAttempts, 2);
  });
});
