'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function combineErrors(operationError, cleanupError) {
  if (operationError && cleanupError) {
    return new AggregateError(
      [operationError, cleanupError],
      'candidate workspace operation and cleanup both failed'
    );
  }
  return operationError || cleanupError;
}

function linkInstalledDependencies(repositoryRoot, sourceRoot) {
  const installedRoot = path.join(repositoryRoot, 'node_modules');
  const linkedRoot = path.join(sourceRoot, 'node_modules');
  fs.mkdirSync(linkedRoot);
  for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
    const installed = path.join(installedRoot, entry.name);
    if (!fs.statSync(installed).isDirectory()) continue;
    fs.symlinkSync(
      installed,
      path.join(linkedRoot, entry.name),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  }
}

function withCandidateSourceWorkspace(repositoryRoot, callback) {
  const sourceSha = git(repositoryRoot, ['rev-parse', 'HEAD']);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-candidate-source-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  let worktreeAdded = false;
  let operationError;
  let result;

  try {
    git(repositoryRoot, ['worktree', 'add', '--detach', sourceRoot, sourceSha]);
    worktreeAdded = true;
    linkInstalledDependencies(repositoryRoot, sourceRoot);
    const checkedOutSha = git(sourceRoot, ['rev-parse', 'HEAD']);
    if (checkedOutSha !== sourceSha) {
      throw new Error(`candidate workspace revision ${checkedOutSha} does not match ${sourceSha}`);
    }
    result = callback({ sourceRoot, sourceSha });
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  if (worktreeAdded) {
    try {
      git(repositoryRoot, ['worktree', 'remove', '--force', sourceRoot]);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!cleanupError) {
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }

  const error = combineErrors(operationError, cleanupError);
  if (error) throw error;
  return result;
}

module.exports = { withCandidateSourceWorkspace };
