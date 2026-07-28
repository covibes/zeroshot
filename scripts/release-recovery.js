#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function parseReleaseTag(tag) {
  const match = String(tag || '').match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error('release_tag must match vX.Y.Z');
  return match[1];
}

function validateCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(String(commit || ''))) {
    throw new Error('release_commit must be a full lowercase commit SHA');
  }
  return commit;
}

function verifyImmutableSource(tag, commit) {
  run('git', ['show-ref', '--verify', `refs/tags/${tag}`]);
  const head = run('git', ['rev-parse', 'HEAD']);
  const tagCommit = run('git', ['rev-list', '-n', '1', `refs/tags/${tag}`]);
  if (head !== commit || tagCommit !== commit) {
    throw new Error('checkout, protected tag, and release_commit must reference the same commit');
  }
  run('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
}

function npmPackageMetadata(name, version) {
  const result = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', 'gitHead', 'dist.attestations', '--json'],
    { encoding: 'utf8' }
  );
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/\bE404\b|is not in this registry|No match found/i.test(result.stderr || '')) return null;
  throw new Error(`npm registry lookup failed: ${(result.stderr || result.stdout).trim()}`);
}

function verifyExistingNpmVersion(metadata, version, commit) {
  if (metadata.version !== version) {
    throw new Error(`npm returned ${metadata.version}; expected ${version}`);
  }
  if (metadata.gitHead !== commit) {
    throw new Error(`npm gitHead ${metadata.gitHead || '(missing)'} does not match ${commit}`);
  }
  if (!metadata['dist.attestations']?.provenance) {
    throw new Error('npm package exists without a provenance attestation');
  }
}

function recoverNpm(name, version, commit) {
  const existing = npmPackageMetadata(name, version);
  if (existing) {
    verifyExistingNpmVersion(existing, version, commit);
    console.log(`${name}@${version} already exists with matching provenance; nothing to recover`);
    return;
  }

  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
  run('npm', ['publish', '--access', 'public', '--provenance'], { stdio: 'inherit' });

  const published = npmPackageMetadata(name, version);
  if (!published) throw new Error(`${name}@${version} was not visible after publication`);
  verifyExistingNpmVersion(published, version, commit);
  console.log(`Recovered ${name}@${version}`);
}

function releaseExists(tag) {
  const result = spawnSync('gh', ['release', 'view', tag], { encoding: 'utf8' });
  if (result.status === 0) return true;
  if (/release not found|HTTP 404/i.test(`${result.stdout}\n${result.stderr}`)) return false;
  throw new Error(`GitHub Release lookup failed: ${(result.stderr || result.stdout).trim()}`);
}

function recoverGithubRelease(tag, commit, version) {
  if (releaseExists(tag)) {
    console.log(`GitHub Release ${tag} already exists; nothing to recover`);
    return;
  }

  const notesPath = path.join(process.cwd(), 'docs', 'releases', `${tag}.md`);
  const args = ['release', 'create', tag, '--verify-tag', '--target', commit, '--title', tag];
  if (fs.existsSync(notesPath)) {
    args.push('--notes-file', notesPath);
  } else {
    args.push('--generate-notes');
    const tags = run('git', [
      'tag',
      '--list',
      'v[0-9]*',
      '--merged',
      `${commit}^`,
      '--sort=-version:refname',
    ])
      .split(/\r?\n/)
      .filter(Boolean);
    if (tags[0]) args.push('--notes-start-tag', tags[0]);
  }

  run('gh', args, { stdio: 'inherit' });
  if (!releaseExists(tag)) throw new Error(`GitHub Release ${tag} was not created`);
  console.log(`Recovered GitHub Release ${tag} for ${version}`);
}

function main() {
  const action = process.env.RECOVERY_ACTION;
  if (!['recover-npm', 'recover-github-release'].includes(action)) {
    throw new Error('RECOVERY_ACTION must be recover-npm or recover-github-release');
  }

  const tag = process.env.RELEASE_TAG;
  const commit = validateCommit(process.env.RELEASE_COMMIT);
  const version = parseReleaseTag(tag);
  verifyImmutableSource(tag, commit);

  const packageJson = require('../package.json');
  if (action === 'recover-npm') {
    recoverNpm(packageJson.name, version, commit);
  } else {
    recoverGithubRelease(tag, commit, version);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release recovery failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  npmPackageMetadata,
  parseReleaseTag,
  releaseExists,
  validateCommit,
  verifyExistingNpmVersion,
};
