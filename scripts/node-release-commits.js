'use strict';

const childProcess = require('node:child_process');
const { classifyPaths } = require('../.github/ci-path-classifier');

const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;

function changedPathsForCommit(hash, options = {}) {
  if (!COMMIT_HASH.test(String(hash))) {
    throw new Error(`invalid commit hash for Node release classification: ${hash}`);
  }
  const runGit = options.runGit || childProcess.execFileSync;
  const output = runGit(
    'git',
    ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', hash],
    { cwd: options.cwd || process.cwd(), encoding: 'utf8' }
  );
  return String(output).split('\0').filter(Boolean);
}

function filterNodeCommits(commits, options = {}) {
  const pathsForCommit = options.pathsForCommit || ((hash) => changedPathsForCommit(hash, options));
  return commits.filter((commit) => {
    // Missing identity cannot be classified safely, so retain the commit.
    if (!commit.hash) return true;
    const nodeRelevant = classifyPaths(pathsForCommit(commit.hash)).node;
    if (!nodeRelevant && options.logger) {
      options.logger.log('Ignoring Rust-only commit in Node release: %s', commit.hash);
    }
    return nodeRelevant;
  });
}

function nodeReleaseContext(context, options = {}) {
  return {
    ...context,
    commits: filterNodeCommits(context.commits || [], {
      cwd: context.cwd,
      logger: context.logger,
      pathsForCommit: options.pathsForCommit,
    }),
  };
}

module.exports = { changedPathsForCommit, filterNodeCommits, nodeReleaseContext };
