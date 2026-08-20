'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const { classifyPaths } = require('../.github/ci-path-classifier');

const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;
const RELEASE_NEUTRAL_PATHS = new Set(['.dockerignore', 'AGENTS.md', 'README.md']);
const RELEASE_NEUTRAL_PREFIXES = ['.github/'];

function isReleaseNeutralPath(pathname) {
  if (RELEASE_NEUTRAL_PATHS.has(pathname)) return true;
  for (const prefix of RELEASE_NEUTRAL_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

function hasNodeReleasePath(paths) {
  const productPaths = paths.filter((pathname) => !isReleaseNeutralPath(pathname));
  return productPaths.length > 0 && classifyPaths(productPaths).node;
}

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
    const nodeRelevant = hasNodeReleasePath(pathsForCommit(commit.hash));
    if (!nodeRelevant && options.logger) {
      options.logger.log('Ignoring non-Node commit in Node release: %s', commit.hash);
    }
    return nodeRelevant;
  });
}

function hasNodeReleaseCommit(commits, options = {}) {
  return filterNodeCommits(commits, options).length > 0;
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

function commitHashesFromStdin() {
  return fs.readFileSync(0, 'utf8').split(/\s+/).filter(Boolean);
}

function main() {
  const commits = commitHashesFromStdin().map((hash) => ({ hash }));
  process.stdout.write(`node=${hasNodeReleaseCommit(commits)}\n`);
}

module.exports = {
  changedPathsForCommit,
  filterNodeCommits,
  hasNodeReleaseCommit,
  hasNodeReleasePath,
  nodeReleaseContext,
};

if (require.main === module) main();
