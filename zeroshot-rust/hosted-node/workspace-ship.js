'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { normalizeDeliveryResult } = require('../../lib/delivery-contract');
const { fixedGitArguments } = require('./workspace-bootstrap');
const {
  createPullRequest,
  github,
  githubGraphql,
  GitHubRequestError,
  mergePullRequest,
} = require('./workspace-delivery-github');

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const ASKPASS = '/opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js';
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
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
    head.trim() !== config.delivery.baseRevision ||
    ![expectedRemote, `${expectedRemote}.git`].includes(remote.trim()) ||
    status.length !== 0
  ) {
    throw new Error('Hosted workspace does not match fixed repository authority');
  }
  const branch = deterministicBranch(clusterId);
  await gitCommand(['switch', '--detach', config.delivery.baseRevision]);
  await gitCommand(['switch', '--create', branch]);
  return branch;
}

async function createReviewOrDeleteBranch(options) {
  try {
    return await options.createReview(options.config, options.branch, options.headRevision);
  } catch (error) {
    try {
      await options.gitCommand(
        ['push', '--porcelain', options.expectedRemote, `:refs/heads/${options.branch}`],
        PUSH_TIMEOUT_MS
      );
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Hosted delivery cleanup failed');
    }
    throw error;
  }
}

async function requireBaseAncestor(config, gitCommand, expectedRemote) {
  await gitCommand(
    [
      'fetch',
      '--no-tags',
      expectedRemote,
      `refs/heads/${config.delivery.targetBranch}:refs/zeroshot/delivery-target`,
    ],
    PUSH_TIMEOUT_MS
  );
  const { stdout } = await gitCommand(['rev-parse', 'refs/zeroshot/delivery-target']);
  try {
    await gitCommand(['merge-base', '--is-ancestor', config.delivery.baseRevision, stdout.trim()]);
  } catch {
    throw new Error('Hosted submission revision is not an ancestor of the delivery target');
  }
  return stdout.trim();
}

async function requireDeliveredRevision(targetRevision, mergeRevision, gitCommand) {
  try {
    await gitCommand(['merge-base', '--is-ancestor', mergeRevision, targetRevision]);
  } catch {
    throw new Error('Hosted merge revision is not on the delivery target');
  }
}

function unsafeGitConfiguration(configNames) {
  return configNames
    .split('\0')
    .filter(Boolean)
    .some((name) =>
      ['url.', 'http.', 'https.', 'credential.', 'core.hookspath', 'remote.origin.pushurl'].some(
        (prefix) => name.toLowerCase().startsWith(prefix)
      )
    );
}

async function verifyDirtyWorkspace(config, gitCommand, expectedRemote) {
  const [{ stdout: baseHead }, { stdout: status }, { stdout: remote }, { stdout: names }] =
    await Promise.all([
      gitCommand(['rev-parse', 'HEAD']),
      gitCommand(['status', '--porcelain=v1', '-z']),
      gitCommand(['remote', 'get-url', 'origin']),
      gitCommand(['config', '--local', '--null', '--name-only', '--list']),
    ]);
  if (baseHead.trim() !== config.delivery.baseRevision) {
    throw new Error('Hosted provider changed Git history');
  }
  if (![expectedRemote, `${expectedRemote}.git`].includes(remote.trim())) {
    throw new Error('Hosted provider changed repository authority');
  }
  if (unsafeGitConfiguration(names)) {
    throw new Error('Hosted provider changed trusted Git configuration');
  }
  if (status.length === 0) throw new Error('Hosted provider completed without a workspace change');
}

async function commitAndPush(config, branch, gitCommand, expectedRemote) {
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
  const { stdout } = await gitCommand(['rev-parse', 'HEAD']);
  const headRevision = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(headRevision) || headRevision === config.delivery.baseRevision) {
    throw new Error('Hosted Git result is invalid');
  }
  await gitCommand(
    ['push', '--porcelain', expectedRemote, `HEAD:refs/heads/${branch}`],
    PUSH_TIMEOUT_MS
  );
  return headRevision;
}

async function shipWorkspace(config, branch, dependencies = {}) {
  const gitCommand = dependencies.git || git;
  const request = dependencies.github || github;
  const graphql = dependencies.graphql || githubGraphql;
  const createReview =
    dependencies.createPullRequest ||
    ((authority, deliveryBranch, head) =>
      createPullRequest(authority, deliveryBranch, head, request));
  const expectedRemote = `https://github.com/${config.repository}`;
  await verifyDirtyWorkspace(config, gitCommand, expectedRemote);
  await requireBaseAncestor(config, gitCommand, expectedRemote);
  const headRevision = await commitAndPush(config, branch, gitCommand, expectedRemote);
  const created = await createReviewOrDeleteBranch({
    config,
    branch,
    headRevision,
    expectedRemote,
    createReview,
    gitCommand,
  });
  await requireBaseAncestor(config, gitCommand, expectedRemote);
  const outcome =
    config.delivery.mode === 'pr'
      ? { disposition: 'pull_request_open' }
      : await mergePullRequest({ config, created, branch, headRevision, request, graphql });
  if (config.delivery.mode === 'ship') {
    const targetRevision = await requireBaseAncestor(config, gitCommand, expectedRemote);
    if (outcome.disposition === 'merged') {
      await requireDeliveredRevision(targetRevision, outcome.mergeRevision, gitCommand);
    }
  }
  return normalizeDeliveryResult({
    ...config.delivery,
    deliveryBranch: branch,
    headRevision,
    pullRequestUrl: created.html_url,
    ...outcome,
  });
}

module.exports = {
  createPullRequest,
  deterministicBranch,
  GitHubRequestError,
  prepareWorkspace,
  shipWorkspace,
};
