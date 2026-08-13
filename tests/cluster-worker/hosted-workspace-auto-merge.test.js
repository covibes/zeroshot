'use strict';

const assert = require('node:assert/strict');
const {
  GitHubRequestError,
  mergePullRequest,
} = require('../../zeroshot-rust/hosted-node/workspace-delivery-github');

const HEAD = 'b'.repeat(40);
const MERGE = 'd'.repeat(40);
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
      review(branch, {
        state: 'closed',
        merged: true,
        merged_at: '2026-08-08T00:00:00Z',
        merge_commit_sha: MERGE,
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

    const receipt = await mergePullRequest({
      config: CONFIG,
      created: { ...review(branch), node_id: 'PR_node_123' },
      branch,
      headRevision: HEAD,
      request,
      graphql: autoMergeGraphql(branch),
      wait: () => Promise.resolve(),
    });

    assert.deepEqual(receipt, { disposition: 'merged', mergeRevision: MERGE });
    const updates = requests.filter(({ route }) => route.endsWith('/update-branch'));
    assert.equal(updates.length, 2, 'a stale guarded update is retried');
    assert.deepEqual(JSON.parse(updates[0].init.body), { expected_head_sha: HEAD });
  });

  it('never accepts an open PR alone', async () => {
    const branch = 'zeroshot/hosted-open-only';
    await assert.rejects(
      mergePullRequest({
        config: CONFIG,
        created: { ...review(branch), node_id: 'PR_node_123' },
        branch,
        headRevision: HEAD,
        request: () => {
          throw new GitHubRequestError(401);
        },
        graphql: autoMergeGraphql(branch),
      }),
      /GitHub rejected hosted delivery/
    );
  });
});
