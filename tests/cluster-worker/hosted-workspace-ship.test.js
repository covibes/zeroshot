'use strict';

const assert = require('node:assert/strict');
const {
  createPullRequest,
  deterministicBranch,
  prepareWorkspace,
  shipWorkspace,
} = require('../../zeroshot-rust/hosted-node/workspace-ship');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const CONFIG = Object.freeze({
  repository: 'the-open-engine/zeroshot',
  baseRevision: BASE,
});

describe('private hosted Git delivery', () => {
  it('prepares a deterministic branch only from the exact clean default-base checkout', async () => {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      const command = args.join(' ');
      if (command === 'rev-parse HEAD' || command.includes('refs/remotes/origin/HEAD')) {
        return { stdout: `${BASE}\n` };
      }
      if (command === 'remote get-url origin') {
        return { stdout: 'https://github.com/the-open-engine/zeroshot.git\n' };
      }
      if (command === 'status --porcelain=v1 -z') return { stdout: '' };
      return { stdout: '' };
    };

    const branch = await prepareWorkspace(CONFIG, 'cluster-1', git);
    assert.equal(branch, deterministicBranch('cluster-1'));
    assert.deepEqual(calls.at(-2), ['switch', '--detach', BASE]);
    assert.deepEqual(calls.at(-1), ['switch', '--create', branch]);
  });

  it('commits one dirty tree, pushes its deterministic branch, and returns canonical review data', async () => {
    const branch = deterministicBranch('cluster-2');
    const calls = [];
    let headReads = 0;
    const git = (args, timeout) => {
      calls.push({ args, timeout });
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') {
        headReads += 1;
        return { stdout: `${headReads === 1 ? BASE : HEAD}\n` };
      }
      if (command === 'remote get-url origin') {
        return { stdout: 'https://github.com/the-open-engine/zeroshot.git\n' };
      }
      if (command === 'config --local --null --name-only --list') {
        return { stdout: 'core.repositoryformatversion\0remote.origin.url\0' };
      }
      if (command === 'status --porcelain=v1 -z') return { stdout: ' M source.js\0' };
      return { stdout: '' };
    };
    const createReview = (config, candidateBranch, headRevision) => {
      assert.equal(config, CONFIG);
      assert.equal(candidateBranch, branch);
      assert.equal(headRevision, HEAD);
      return 'https://github.com/the-open-engine/zeroshot/pull/123';
    };

    const receipt = await shipWorkspace(CONFIG, branch, {
      git,
      createPullRequest: createReview,
    });

    assert.deepEqual(receipt, {
      repository: CONFIG.repository,
      branch,
      headRevision: HEAD,
      pullRequestUrl: 'https://github.com/the-open-engine/zeroshot/pull/123',
    });
    const push = calls.find(({ args }) => args[0] === 'push');
    assert.deepEqual(push.args, [
      'push',
      '--porcelain',
      'https://github.com/the-open-engine/zeroshot',
      `HEAD:refs/heads/${branch}`,
    ]);
    assert.equal(push.timeout, 10 * 60 * 1000);
  });

  it('refuses provider-mutated remotes and URL rewrite configuration before push', async () => {
    const branch = deterministicBranch('cluster-unsafe');
    const git = (args) => {
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') return { stdout: `${BASE}\n` };
      if (command === 'status --porcelain=v1 -z') return { stdout: ' M source.js\0' };
      if (command === 'remote get-url origin') return { stdout: 'https://evil.example/repo\n' };
      if (command === 'config --local --null --name-only --list') {
        return { stdout: 'url.https://evil.example/.insteadof\0' };
      }
      throw new Error(`unexpected Git call: ${command}`);
    };
    await assert.rejects(shipWorkspace(CONFIG, branch, { git }), /repository authority/);
  });
  it('accepts only a pull request bound to the pushed branch and revisions', async () => {
    const branch = deterministicBranch('cluster-review');
    const response = {
      html_url: 'https://github.com/the-open-engine/zeroshot/pull/123',
      head: { ref: branch, sha: HEAD, repo: { full_name: CONFIG.repository } },
      base: { ref: 'main', sha: BASE, repo: { full_name: CONFIG.repository } },
    };
    const request = (_repository, requestPath) => {
      if (requestPath === '') return { default_branch: 'main' };
      if (requestPath === '/branches/main') return { commit: { sha: BASE } };
      return response;
    };
    assert.equal(await createPullRequest(CONFIG, branch, HEAD, request), response.html_url);
    await assert.rejects(
      createPullRequest(CONFIG, branch, HEAD, async (repository, requestPath) => {
        const value = await request(repository, requestPath);
        return requestPath === '/pulls'
          ? { ...value, head: { ...value.head, sha: 'c'.repeat(40) } }
          : value;
      }),
      /receipt is invalid/
    );
  });

  it('refuses review creation if the authoritative default base moved', async () => {
    const paths = [];
    const request = (_repository, path) => {
      paths.push(path);
      if (path === '') return { default_branch: 'main' };
      return { commit: { sha: 'c'.repeat(40) } };
    };

    await assert.rejects(
      createPullRequest(CONFIG, deterministicBranch('cluster-3'), HEAD, request),
      /base revision changed/
    );
    assert.deepEqual(paths, ['', '/branches/main']);
  });
});
