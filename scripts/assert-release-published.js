#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { releaseTypeForMessages } = require('./release-preflight');

const DEFAULT_ATTEMPTS = 24;
const DEFAULT_DELAY_MS = 5000;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
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

function verifyInstalledCli(name, version, options = {}) {
  const packageSpec = `${name}@${version}`;
  const execute = options.execute || run;
  const makeTempRoot =
    options.makeTempRoot ||
    (() => fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-release-cli-')));
  const removeTempRoot =
    options.removeTempRoot ||
    ((root) => {
      fs.rmSync(root, { recursive: true, force: true });
    });
  const platform = options.platform || process.platform;
  const prefix = makeTempRoot();

  try {
    execute('npm', [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      packageSpec,
    ]);

    const executable = path.join(
      prefix,
      platform === 'win32' ? 'zeroshot.cmd' : 'bin',
      ...(platform === 'win32' ? [] : ['zeroshot'])
    );
    const isolatedEnv = {
      ...process.env,
      HOME: prefix,
      USERPROFILE: prefix,
    };
    const reported = execute(executable, ['--version'], { env: isolatedEnv });
    if (!reported.split(/\s+/).includes(version)) {
      throw new Error(`installed CLI reported ${reported}; expected ${version}`);
    }
    execute(executable, ['--help'], { env: isolatedEnv });
    execute(executable, ['list'], { env: isolatedEnv });
  } finally {
    removeTempRoot(prefix);
  }
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

function nextRetryDelay(attempt, attempts, delayMs, options) {
  if (attempt >= attempts) return null;
  if (options.deadline === undefined) return delayMs;

  const now = options.now || Date.now;
  const remainingMs = options.deadline - now();
  if (remainingMs <= 0) return null;
  return Math.min(delayMs, remainingMs);
}

async function waitForNpmLatest(name, expectedVersion, options = {}) {
  const attempts =
    options.attempts || Number(process.env.RELEASE_ASSERT_ATTEMPTS || DEFAULT_ATTEMPTS);
  const delayMs =
    options.delayMs || Number(process.env.RELEASE_ASSERT_DELAY_MS || DEFAULT_DELAY_MS);
  const wait = options.sleep || sleep;

  let latest = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = npmLatest(name);
    if (latest === expectedVersion) return latest;

    const retryDelay = nextRetryDelay(attempt, attempts, delayMs, options);
    if (retryDelay !== null) {
      console.log(
        `npm latest for ${name} is ${latest}; waiting for ${expectedVersion} (${attempt}/${attempts})`
      );
      await wait(retryDelay);
    } else {
      break;
    }
  }

  throw new Error(`expected npm latest for ${name} to be ${expectedVersion}, got ${latest}`);
}

async function waitForPublishedArtifact(label, check, options = {}) {
  const attempts =
    options.attempts || Number(process.env.RELEASE_ASSERT_ATTEMPTS || DEFAULT_ATTEMPTS);
  const delayMs =
    options.delayMs || Number(process.env.RELEASE_ASSERT_DELAY_MS || DEFAULT_DELAY_MS);
  const wait = options.sleep || sleep;
  let lastError = null;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsMade = attempt;
    try {
      return await check();
    } catch (error) {
      lastError = error;
      const retryDelay = nextRetryDelay(attempt, attempts, delayMs, options);
      if (retryDelay !== null) {
        console.log(
          `${label} is not ready: ${error.message}; retrying (${attempt}/${attempts})`
        );
        await wait(retryDelay);
      } else {
        break;
      }
    }
  }

  throw new Error(
    `${label} did not become ready after ${attemptsMade} attempts: ${lastError?.message || 'unknown error'}`
  );
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
  const retryAttempts = Number(process.env.RELEASE_ASSERT_ATTEMPTS || DEFAULT_ATTEMPTS);
  const retryDelayMs = Number(process.env.RELEASE_ASSERT_DELAY_MS || DEFAULT_DELAY_MS);
  const retryOptions = {
    attempts: retryAttempts,
    delayMs: retryDelayMs,
    deadline: Date.now() + retryAttempts * retryDelayMs,
  };
  const latest = await waitForNpmLatest(name, expectedVersion, retryOptions);

  console.log(`npm latest for ${name}: ${latest}`);

  const expectedCommit = run('git', ['rev-parse', 'HEAD']);
  const metadata = await waitForPublishedArtifact(
    'npm release metadata',
    () => {
      const result = npmReleaseMetadata(name, expectedVersion);
      if (result.version !== expectedVersion) {
        throw new Error(`npm metadata returned ${result.version}; expected ${expectedVersion}`);
      }
      if (result.gitHead !== expectedCommit) {
        throw new Error(`npm gitHead ${result.gitHead || '(missing)'} does not match HEAD`);
      }
      if (!result['dist.attestations']?.url) {
        throw new Error('npm attestation URL is missing');
      }
      return result;
    },
    retryOptions
  );

  await waitForPublishedArtifact(
    'npm provenance',
    async () => {
      const attestations = await httpsJson(metadata['dist.attestations'].url);
      verifyProvenance(provenanceStatement(attestations), expectedCommit);
    },
    retryOptions
  );

  await waitForPublishedArtifact(
    'GitHub Release',
    () => {
      const release = githubRelease(expectedTag);
      if (release.tagName !== expectedTag) {
        throw new Error(`GitHub Release tag ${release.tagName} does not match ${expectedTag}`);
      }
      verifyCuratedNotes(expectedTag, release);
    },
    retryOptions
  );

  await waitForPublishedArtifact(
    'installed CLI',
    () => verifyInstalledCli(name, expectedVersion),
    retryOptions
  );

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
  verifyInstalledCli,
  verifyProvenance,
  waitForNpmLatest,
  waitForPublishedArtifact,
};
