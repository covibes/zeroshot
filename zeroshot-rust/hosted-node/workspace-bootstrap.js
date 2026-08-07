'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const GIT = '/usr/bin/git';
const ASKPASS = '/opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js';
const WORKSPACE = '/workspace';
const WORKER_UID = 10002;
const WORKER_GID = 10002;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function gitEnvironment(gitToken, environment = process.env) {
  return {
    GH_TOKEN: gitToken,
    GIT_ASKPASS: ASKPASS,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/tmp/zeroshot-oecp',
    PATH: environment.PATH,
  };
}

function fixedGitArguments(args) {
  return [
    '-c',
    'credential.helper=',
    '-c',
    `core.askPass=${ASKPASS}`,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.proxy=',
    '-c',
    'https.proxy=',
    ...args,
  ];
}

function runGit(args, gitToken, execute = execFileAsync) {
  return execute(GIT, fixedGitArguments(args), {
    cwd: '/',
    encoding: 'utf8',
    env: gitEnvironment(gitToken),
    gid: WORKER_GID,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    uid: WORKER_UID,
    windowsHide: true,
  });
}

function verifyEmptyWorkspace(workspace = WORKSPACE) {
  const metadata = fs.lstatSync(workspace);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    fs.readdirSync(workspace).length !== 0
  ) {
    throw new Error('Hosted workspace is not an empty fixed directory');
  }
}

async function cloneFixedRepository(config, dependencies = {}) {
  const workspace = dependencies.workspace || WORKSPACE;
  const execute = dependencies.execute || execFileAsync;
  const gitToken = config.workerEnvironment.GH_TOKEN;
  verifyEmptyWorkspace(workspace);
  const remote = `https://github.com/${config.repository}.git`;
  await runGit(
    ['clone', '--no-checkout', '--origin', 'origin', remote, workspace],
    gitToken,
    execute
  );
  await runGit(['-C', workspace, 'checkout', '--detach', config.baseRevision], gitToken, execute);
  const [{ stdout: head }, { stdout: origin }, { stdout: status }] = await Promise.all([
    runGit(['-C', workspace, 'rev-parse', 'HEAD'], gitToken, execute),
    runGit(['-C', workspace, 'remote', 'get-url', 'origin'], gitToken, execute),
    runGit(['-C', workspace, 'status', '--porcelain=v1', '-z'], gitToken, execute),
  ]);
  if (head.trim() !== config.baseRevision || origin.trim() !== remote || status.length !== 0) {
    throw new Error('Hosted workspace clone does not match fixed repository authority');
  }
}

module.exports = {
  cloneFixedRepository,
  fixedGitArguments,
  gitEnvironment,
  verifyEmptyWorkspace,
};
