#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { releaseTypeForMessages } = require('./release-preflight');

const DEFAULT_ATTEMPTS = 24;
const DEFAULT_DELAY_MS = 5000;

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function packageName() {
  return require('../package.json').name;
}

function npmLatest(name) {
  return JSON.parse(run('npm', ['view', name, 'dist-tags.latest', '--json']));
}

function npmReleaseMetadata(name, version) {
  return JSON.parse(
    run('npm', ['view', `${name}@${version}`, 'version', 'gitHead', 'dist.attestations', '--json'])
  );
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}: ${body}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    request.on('error', reject);
  });
}

function provenanceStatement(attestations) {
  const provenance = attestations.attestations?.find(
    (attestation) => attestation.predicateType === 'https://slsa.dev/provenance/v1'
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  if (!payload) throw new Error('npm provenance statement is missing');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

function verifyProvenance(statement, expectedCommit) {
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== 'https://github.com/the-open-engine/zeroshot') {
    throw new Error(`unexpected provenance repository: ${workflow?.repository || '(missing)'}`);
  }
  if (workflow?.path !== '.github/workflows/release.yml') {
    throw new Error(`unexpected provenance workflow: ${workflow?.path || '(missing)'}`);
  }

  const resolved = statement.predicate?.buildDefinition?.resolvedDependencies || [];
  if (!resolved.some((dependency) => dependency.digest?.gitCommit === expectedCommit)) {
    throw new Error(`provenance does not resolve to release commit ${expectedCommit}`);
  }
}

function githubRelease(tag) {
  return JSON.parse(run('gh', ['release', 'view', tag, '--json', 'tagName,body,url,publishedAt']));
}

function verifyCuratedNotes(tag, release) {
  const notesPath = path.join(process.cwd(), 'docs', 'releases', `${tag}.md`);
  if (!fs.existsSync(notesPath)) return;
  const expected = fs.readFileSync(notesPath, 'utf8').trim();
  const actual = String(release.body || '').trim();
  if (actual !== expected) {
    throw new Error(`GitHub Release ${tag} does not match ${notesPath}`);
  }
}

function verifyInstalledCli(name, version) {
  const packageSpec = `${name}@${version}`;
  const reported = run('npm', [
    'exec',
    '--yes',
    `--package=${packageSpec}`,
    '--',
    'zeroshot',
    '--version',
  ]);
  if (!reported.split(/\s+/).includes(version)) {
    throw new Error(`installed CLI reported ${reported}; expected ${version}`);
  }
  run('npm', ['exec', '--yes', `--package=${packageSpec}`, '--', 'zeroshot', '--help']);
  run('npm', ['exec', '--yes', `--package=${packageSpec}`, '--', 'zeroshot', 'list']);
}

function tagsPointingAtHead() {
  run('git', ['fetch', '--tags', '--force']);
  return run('git', ['tag', '--points-at', 'HEAD', '--list', 'v[0-9]*'])
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function latestReachableReleaseTag() {
  return run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
}

function commitMessagesSince(tag) {
  const output = run('git', ['log', '--format=%B%x1e', `${tag}..HEAD`]);
  return output
    .split('\x1e')
    .map((message) => message.trim())
    .filter(Boolean);
}

function releaseTagParts(tag) {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

function compareReleaseTags(left, right) {
  const leftParts = releaseTagParts(left);
  const rightParts = releaseTagParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function latestReleaseTag(tags) {
  const releaseTags = tags.filter((tag) => releaseTagParts(tag));
  releaseTags.sort(compareReleaseTags);
  return releaseTags.at(-1) || null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForNpmLatest(name, expectedVersion, options = {}) {
  const attempts =
    options.attempts || Number(process.env.RELEASE_ASSERT_ATTEMPTS || DEFAULT_ATTEMPTS);
  const delayMs =
    options.delayMs || Number(process.env.RELEASE_ASSERT_DELAY_MS || DEFAULT_DELAY_MS);

  let latest = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = npmLatest(name);
    if (latest === expectedVersion) return latest;

    if (attempt < attempts) {
      console.log(
        `npm latest for ${name} is ${latest}; waiting for ${expectedVersion} (${attempt}/${attempts})`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`expected npm latest for ${name} to be ${expectedVersion}, got ${latest}`);
}

async function main() {
  const name = packageName();
  const headTags = tagsPointingAtHead();
  const expectedTag = latestReleaseTag(headTags);

  if (!expectedTag) {
    const previousTag = latestReachableReleaseTag();
    const releaseType = releaseTypeForMessages(commitMessagesSince(previousTag));
    if (!releaseType) {
      console.log('No release-worthy commits since the latest tag; no publication expected');
      return;
    }
    throw new Error('expected a vX.Y.Z release tag to point at HEAD after release');
  }

  console.log(`tags on HEAD: ${headTags.join(', ') || '(none)'}`);
  const expectedVersion = expectedTag.slice(1);
  const latest = await waitForNpmLatest(name, expectedVersion);

  console.log(`npm latest for ${name}: ${latest}`);

  const expectedCommit = run('git', ['rev-parse', 'HEAD']);
  const metadata = npmReleaseMetadata(name, expectedVersion);
  if (metadata.version !== expectedVersion) {
    throw new Error(`npm metadata returned ${metadata.version}; expected ${expectedVersion}`);
  }
  if (metadata.gitHead !== expectedCommit) {
    throw new Error(`npm gitHead ${metadata.gitHead || '(missing)'} does not match HEAD`);
  }

  const attestationUrl = metadata['dist.attestations']?.url;
  if (!attestationUrl) throw new Error('npm attestation URL is missing');
  const attestations = await httpsJson(attestationUrl);
  verifyProvenance(provenanceStatement(attestations), expectedCommit);

  const release = githubRelease(expectedTag);
  if (release.tagName !== expectedTag) {
    throw new Error(`GitHub Release tag ${release.tagName} does not match ${expectedTag}`);
  }
  verifyCuratedNotes(expectedTag, release);
  verifyInstalledCli(name, expectedVersion);

  console.log(`Release publication verified: ${name}@${latest}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release publication check failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  latestReleaseTag,
  latestReachableReleaseTag,
  npmReleaseMetadata,
  npmLatest,
  provenanceStatement,
  tagsPointingAtHead,
  verifyProvenance,
  waitForNpmLatest,
};
