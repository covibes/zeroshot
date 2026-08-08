'use strict';

const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024;

class GitHubRequestError extends Error {
  constructor(status) {
    super('GitHub rejected hosted delivery');
    this.name = 'GitHubRequestError';
    this.status = status;
  }
}

async function boundedJson(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_GITHUB_RESPONSE_BYTES) {
    throw new Error('GitHub returned an invalid hosted delivery response');
  }
  try {
    const document = JSON.parse(bytes.toString('utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error();
    return document;
  } catch {
    throw new Error('GitHub returned an invalid hosted delivery response');
  }
}

async function github(repository, route, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    ...init,
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'zeroshot-private-hosted-runtime',
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new GitHubRequestError(response.status);
  return boundedJson(response);
}

async function githubGraphql(query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'zeroshot-private-hosted-runtime',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new GitHubRequestError(response.status);
  const document = await boundedJson(response);
  if (Array.isArray(document.errors) && document.errors.length > 0) {
    throw new Error('GitHub rejected hosted auto-merge');
  }
  return document.data;
}

function pullRequestNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
}

async function rejectPullRequestReceipt(config, number, request) {
  if (number) {
    await request(config.repository, `/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }
  throw new Error('GitHub pull request receipt is invalid');
}

function validPullRequest({ config, created, branch, headRevision, number }) {
  const expectedPrefix = `https://github.com/${config.repository}/pull/`;
  return (
    number &&
    created.html_url === `${expectedPrefix}${number}` &&
    created.state === 'open' &&
    created.head?.ref === branch &&
    created.head?.sha === headRevision &&
    created.head?.repo?.full_name === config.repository &&
    created.base?.ref === config.delivery.targetBranch &&
    /^[0-9a-f]{40}$/.test(created.base?.sha) &&
    created.base?.repo?.full_name === config.repository
  );
}

async function createPullRequest(config, branch, headRevision, request = github) {
  const created = await request(config.repository, '/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: 'feat: complete hosted Zeroshot task',
      body: 'Created by the private Zeroshot hosted runtime.',
      head: branch,
      base: config.delivery.targetBranch,
    }),
  });
  const number = pullRequestNumber(created.number);
  if (!validPullRequest({ config, created, branch, headRevision, number })) {
    return rejectPullRequestReceipt(config, number, request);
  }
  return created;
}

function validMergedReview({ config, review, branch, headRevision, mergeRevision }) {
  return (
    review.state === 'closed' &&
    review.merged === true &&
    review.merged_at &&
    review.merge_commit_sha === mergeRevision &&
    review.head?.ref === branch &&
    review.head?.sha === headRevision &&
    review.base?.ref === config.delivery.targetBranch &&
    review.base?.repo?.full_name === config.repository
  );
}

async function mergePullRequest(options) {
  const { config, created, headRevision, request } = options;
  try {
    const merged = await request(config.repository, `/pulls/${created.number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        sha: headRevision,
        merge_method: 'merge',
        commit_title: 'feat: complete hosted Zeroshot task',
      }),
    });
    if (merged.merged !== true || !/^[0-9a-f]{40}$/.test(merged.sha)) {
      throw new Error('GitHub merge receipt is invalid');
    }
    const review = await request(config.repository, `/pulls/${created.number}`);
    if (!validMergedReview({ ...options, review, mergeRevision: merged.sha })) {
      throw new Error('GitHub merge verification failed');
    }
    return { disposition: 'merged', mergeRevision: merged.sha };
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 405) throw error;
  }
  return enableAutoMerge(options);
}

async function enableAutoMerge({ config, created, branch, headRevision, graphql }) {
  if (typeof created.node_id !== 'string' || !created.node_id) {
    throw new Error('GitHub pull request omitted its node identity');
  }
  const query = [
    'mutation Enable($id:ID!){enablePullRequestAutoMerge(',
    'input:{pullRequestId:$id,mergeMethod:MERGE}){pullRequest{number baseRefName ',
    'headRefName headRefOid repository{nameWithOwner} ',
    'autoMergeRequest{enabledAt mergeMethod}}}}',
  ].join('');
  const data = await graphql(query, { id: created.node_id });
  const review = data?.enablePullRequestAutoMerge?.pullRequest;
  if (
    review?.number !== created.number ||
    review.repository?.nameWithOwner !== config.repository ||
    review.baseRefName !== config.delivery.targetBranch ||
    review.headRefName !== branch ||
    review.headRefOid !== headRevision ||
    review.autoMergeRequest?.mergeMethod !== 'MERGE' ||
    typeof review.autoMergeRequest?.enabledAt !== 'string'
  ) {
    throw new Error('GitHub auto-merge verification failed');
  }
  return { disposition: 'auto_merge_enabled' };
}

module.exports = {
  createPullRequest,
  github,
  githubGraphql,
  GitHubRequestError,
  mergePullRequest,
};
