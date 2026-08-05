'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = 'docker/zeroshot-oecp/build-manifest.json';
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const NULL_SHA_PATTERN = /^(?:0{40}|0{64})$/u;

function commitSha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} is not a commit SHA`);
  }
  return value;
}

function comparisonForEvent(eventName, event, fallbackHead) {
  if (eventName === 'workflow_dispatch') {
    return { forced: true, reason: 'manual workflow dispatch' };
  }
  if (eventName === 'pull_request') {
    return {
      base: commitSha(event.pull_request?.base?.sha, 'pull request base'),
      head: commitSha(event.pull_request?.head?.sha, 'pull request head'),
      mergeBase: true,
    };
  }
  if (eventName === 'merge_group') {
    return {
      base: commitSha(event.merge_group?.base_sha, 'merge group base'),
      head: commitSha(event.merge_group?.head_sha, 'merge group head'),
    };
  }
  if (eventName === 'push') {
    const head = commitSha(event.after || fallbackHead, 'push head');
    if (typeof event.before === 'string' && NULL_SHA_PATTERN.test(event.before)) {
      return { forced: true, reason: 'push has no base commit' };
    }
    return { base: commitSha(event.before, 'push base'), head };
  }
  throw new Error(`Unsupported GitHub event: ${eventName}`);
}

function manifestInputs(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
  if (!manifest.inputs || typeof manifest.inputs !== 'object' || Array.isArray(manifest.inputs)) {
    throw new Error('Hosted OECP build manifest has no input map');
  }
  const inputs = Object.keys(manifest.inputs);
  if (inputs.length === 0 || inputs.some((input) => !input || path.isAbsolute(input))) {
    throw new Error('Hosted OECP build manifest has an invalid input map');
  }
  return inputs;
}

function successful(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function runGit(runner, args, options) {
  try {
    return runner('git', args, options);
  } catch {
    return null;
  }
}

function commitAvailable(sha, root, runner) {
  return successful(
    runGit(runner, ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' })
  );
}

function materializeCommit(sha, root, runner) {
  if (commitAvailable(sha, root, runner)) return true;
  const fetched = runGit(
    runner,
    ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', sha],
    { cwd: root, stdio: 'ignore' }
  );
  return successful(fetched) && commitAvailable(sha, root, runner);
}

function comparisonChanges(comparison, root = ROOT, runner = spawnSync) {
  const base = commitSha(comparison.base, 'comparison base');
  const head = commitSha(comparison.head, 'comparison head');
  if (!materializeCommit(base, root, runner)) {
    return { forced: true, reason: 'base commit is unavailable' };
  }
  if (!materializeCommit(head, root, runner)) {
    return { forced: true, reason: 'head commit is unavailable' };
  }

  const range = `${base}${comparison.mergeBase ? '...' : '..'}${head}`;
  const result = runGit(runner, ['diff', '--no-renames', '--name-only', '-z', range, '--'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!successful(result) || typeof result.stdout !== 'string') {
    return { forced: true, reason: 'commit comparison failed' };
  }
  return { changed: result.stdout.split('\0').filter(Boolean) };
}

function matchesInput(changedPath, input) {
  return changedPath === input || changedPath.startsWith(`${input}/`);
}

function relevantPaths(changed, inputs) {
  const watched = [MANIFEST_PATH, ...inputs];
  return changed.filter((changedPath) => watched.some((input) => matchesInput(changedPath, input)));
}

function writeResult(outputPath, relevant) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  fs.appendFileSync(outputPath, `relevant=${relevant ? 'true' : 'false'}\n`, 'utf8');
}

function main(environment = process.env) {
  const eventName = environment.GITHUB_EVENT_NAME;
  const event = JSON.parse(fs.readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
  const comparison = comparisonForEvent(eventName, event, environment.GITHUB_SHA);
  if (comparison.forced) {
    writeResult(environment.GITHUB_OUTPUT, true);
    process.stdout.write(
      `${JSON.stringify({ event: eventName, relevant: true, reason: comparison.reason })}\n`
    );
    return;
  }

  const changes = comparisonChanges(comparison);
  if (changes.forced) {
    writeResult(environment.GITHUB_OUTPUT, true);
    process.stdout.write(
      `${JSON.stringify({ event: eventName, relevant: true, reason: changes.reason })}\n`
    );
    return;
  }

  const changed = changes.changed;
  const matched = changed.includes(MANIFEST_PATH)
    ? [MANIFEST_PATH]
    : relevantPaths(changed, manifestInputs());
  const relevant = matched.length > 0;
  writeResult(environment.GITHUB_OUTPUT, relevant);
  process.stdout.write(
    `${JSON.stringify({
      event: eventName,
      base: comparison.base,
      head: comparison.head,
      changedPathCount: changed.length,
      matchedPaths: matched,
      relevant,
    })}\n`
  );
}

if (require.main === module) main();

module.exports = {
  MANIFEST_PATH,
  comparisonForEvent,
  comparisonChanges,
  relevantPaths,
};
