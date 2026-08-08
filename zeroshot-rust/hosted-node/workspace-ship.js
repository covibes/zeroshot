'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixedGitArguments } = require('./workspace-bootstrap');

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const ASKPASS = '/opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js';
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

function commandEnvironment() {
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    PATH: process.env.PATH,
    GH_TOKEN: process.env.GH_TOKEN,
    GIT_ASKPASS: ASKPASS,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(args, timeout = COMMAND_TIMEOUT_MS) {
  return execFileAsync(GIT, fixedGitArguments(args), {
    cwd: '/workspace',
    encoding: 'utf8',
    env: commandEnvironment(),
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout,
    windowsHide: true,
  });
}

function deterministicBranch(clusterId) {
  const suffix = crypto.createHash('sha256').update(clusterId).digest('hex').slice(0, 20);
  return `zeroshot/hosted-${suffix}`;
}

async function prepareWorkspace(config, clusterId, gitCommand = git) {
  const expectedRemote = `https://github.com/${config.repository}`;
  const [{ stdout: head }, { stdout: remote }, { stdout: status }] = await Promise.all([
    gitCommand(['rev-parse', 'HEAD']),
    gitCommand(['remote', 'get-url', 'origin']),
    gitCommand(['status', '--porcelain=v1', '-z']),
  ]);
  if (
    head.trim() !== config.baseRevision ||
    ![expectedRemote, `${expectedRemote}.git`].includes(remote.trim()) ||
    status.length !== 0
  ) {
    throw new Error('Hosted workspace does not match fixed repository authority');
  }
  const branch = deterministicBranch(clusterId);
  await gitCommand(['switch', '--detach', config.baseRevision]);
  await gitCommand(['switch', '--create', branch]);
  return branch;
}

async function boundedJson(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_GITHUB_RESPONSE_BYTES) {
    throw new Error('GitHub returned an invalid hosted delivery response');
  }
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('GitHub returned an invalid hosted delivery response');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('GitHub returned an invalid hosted delivery response');
  }
  return document;
}

async function github(repository, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
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
  if (!response.ok) throw new Error('GitHub rejected hosted delivery');
  return boundedJson(response);
}

function repositoryDefaultBranch(repository) {
  const branch = repository?.default_branch;
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error('GitHub repository metadata is invalid');
  }
  return branch;
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

async function createPullRequest(config, branch, headRevision, request = github) {
  const repository = await request(config.repository, '');
  const defaultBranch = repositoryDefaultBranch(repository);
  const created = await request(config.repository, '/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: 'feat: complete hosted Zeroshot task',
      body: 'Created by the private Zeroshot hosted runtime.',
      head: branch,
      base: defaultBranch,
    }),
  });
  const expectedPrefix = `https://github.com/${config.repository}/pull/`;
  const number = pullRequestNumber(created.number);
  if (
    !number ||
    created.html_url !== `${expectedPrefix}${number}` ||
    created.head?.ref !== branch ||
    created.head?.sha !== headRevision ||
    created.head?.repo?.full_name !== config.repository ||
    created.base?.ref !== defaultBranch ||
    created.base?.sha !== config.baseRevision ||
    created.base?.repo?.full_name !== config.repository
  ) {
    return rejectPullRequestReceipt(config, number, request);
  }
  return created.html_url;
}

async function createReviewOrDeleteBranch({
  config,
  branch,
  headRevision,
  expectedRemote,
  createReview,
  gitCommand,
}) {
  try {
    return await createReview(config, branch, headRevision);
  } catch (error) {
    try {
      await gitCommand(
        ['push', '--porcelain', expectedRemote, `:refs/heads/${branch}`],
        PUSH_TIMEOUT_MS
      );
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Hosted delivery cleanup failed');
    }
    throw error;
  }
}

async function shipWorkspace(config, branch, dependencies = {}) {
  const gitCommand = dependencies.git || git;
  const createReview = dependencies.createPullRequest || createPullRequest;
  const expectedRemote = `https://github.com/${config.repository}`;
  const [{ stdout: baseHead }, { stdout: status }, { stdout: remote }, { stdout: configNames }] =
    await Promise.all([
      gitCommand(['rev-parse', 'HEAD']),
      gitCommand(['status', '--porcelain=v1', '-z']),
      gitCommand(['remote', 'get-url', 'origin']),
      gitCommand(['config', '--local', '--null', '--name-only', '--list']),
    ]);
  if (baseHead.trim() !== config.baseRevision) {
    throw new Error('Hosted provider changed Git history');
  }
  if (![expectedRemote, `${expectedRemote}.git`].includes(remote.trim())) {
    throw new Error('Hosted provider changed repository authority');
  }
  const unsafeConfig = configNames
    .split('\0')
    .filter(Boolean)
    .some((name) =>
      ['url.', 'http.', 'https.', 'credential.', 'core.hookspath', 'remote.origin.pushurl'].some(
        (prefix) => name.toLowerCase().startsWith(prefix)
      )
    );
  if (unsafeConfig) throw new Error('Hosted provider changed trusted Git configuration');
  if (status.length === 0) throw new Error('Hosted provider completed without a workspace change');
  await gitCommand(['add', '--all']);
  await gitCommand([
    '-c',
    'user.name=Zeroshot Hosted',
    '-c',
    'user.email=hosted@zeroshot.invalid',
    'commit',
    '--message',
    'feat: complete hosted Zeroshot task',
  ]);
  const { stdout: head } = await gitCommand(['rev-parse', 'HEAD']);
  const headRevision = head.trim();
  if (!/^[0-9a-f]{40}$/.test(headRevision) || headRevision === config.baseRevision) {
    throw new Error('Hosted Git result is invalid');
  }
  await gitCommand(
    ['push', '--porcelain', expectedRemote, `HEAD:refs/heads/${branch}`],
    PUSH_TIMEOUT_MS
  );
  const pullRequestUrl = await createReviewOrDeleteBranch({
    config,
    branch,
    headRevision,
    expectedRemote,
    createReview,
    gitCommand,
  });
  return Object.freeze({
    repository: config.repository,
    branch,
    headRevision,
    pullRequestUrl,
  });
}
module.exports = {
  createPullRequest,
  deterministicBranch,
  prepareWorkspace,
  shipWorkspace,
};
