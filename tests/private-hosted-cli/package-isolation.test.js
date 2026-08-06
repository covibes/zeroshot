'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { describe, it } = require('node:test');
const { COMMAND_MANIFEST, PRIVATE_MARKER } = require('../../private/hosted-cli-candidate/manifest');
const { parseArgs } = require('../../private/hosted-cli-candidate/build-candidate');

const ROOT = path.resolve(__dirname, '../..');
const CANDIDATE_PACKAGE_PATH = 'node_modules/@the-open-engine/zeroshot-private-hosted-candidate';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
}

function buildCandidate(output, runtimeImageDigest) {
  const built = run(process.execPath, [
    'private/hosted-cli-candidate/build-candidate.js',
    '--runtime-image-digest',
    runtimeImageDigest,
    '--repository',
    'the-open-engine/zeroshot',
    '--provider',
    'codex',
    '--model-level',
    'level2',
    '--out',
    output,
  ]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  return JSON.parse(built.stdout);
}

function assertCandidateOutput(candidate, output, runtimeImageDigest) {
  assert.deepEqual(candidate, {
    tarballPath: path.join(
      output,
      'the-open-engine-zeroshot-private-hosted-candidate-0.0.0-development.tgz'
    ),
    stage: path.join(output, 'staging'),
  });
  assert.equal(fs.existsSync(candidate.tarballPath), true);
  const configuration = path.join(
    candidate.stage,
    'lib',
    'private-hosted-cli',
    'candidate-build.json'
  );
  const configured = JSON.parse(fs.readFileSync(configuration, 'utf8'));
  assert.equal(configured.privateMarker, PRIVATE_MARKER);
  assert.equal(configured.runtimeImageDigest, runtimeImageDigest);
}

function installCandidate(temporaryRoot, tarballPath) {
  const installation = path.join(temporaryRoot, 'installation');
  const installed = run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--omit=optional',
      '--prefix',
      installation,
      tarballPath,
    ],
    {
      timeout: 120_000,
      env: {
        ...process.env,
        CI: '1',
        HOME: temporaryRoot,
        USERPROFILE: temporaryRoot,
      },
    }
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  return installation;
}

function assertCandidateLaunches(temporaryRoot, installation) {
  const executable = path.join(installation, CANDIDATE_PACKAGE_PATH, 'cli', 'index.js');
  const launched = run(process.execPath, [executable, '--help'], {
    cwd: installation,
    env: {
      ...process.env,
      CI: '1',
      HOME: temporaryRoot,
      NO_UPDATE_NOTIFIER: '1',
      USERPROFILE: temporaryRoot,
    },
  });
  assert.equal(launched.status, 0, launched.stderr || launched.stdout);
  assert.match(launched.stdout, /\btarget\b/);
  assert.match(launched.stdout, /\bcapsule\b/);
}

function assertPackedCandidateBuildsInstallsAndLaunches() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-candidate-installation-'));
  try {
    const output = path.join(temporaryRoot, 'candidate');
    const runtimeImageDigest = `sha256:${'a'.repeat(64)}`;
    const candidate = buildCandidate(output, runtimeImageDigest);
    assertCandidateOutput(candidate, output, runtimeImageDigest);
    const installation = installCandidate(temporaryRoot, candidate.tarballPath);
    assertCandidateLaunches(temporaryRoot, installation);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertNormalPackExcludesCandidate() {
  const result = run('npm', [
    'pack',
    '--json',
    '--dry-run',
    '--ignore-scripts',
    '--foreground-scripts=false',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout)[0];
  const paths = packed.files.map((file) => file.path);
  assert.equal(
    paths.some((file) => file.startsWith('private/')),
    false
  );
  assert.equal(
    paths.some((file) => file.startsWith('tests/private-hosted-cli/')),
    false
  );
  assert.equal(paths.includes('PRIVATE_HOSTED_CANDIDATE.txt'), false);
  assert.equal(paths.includes('npm-shrinkwrap.json'), true);
  assert.equal(JSON.stringify(packed).includes(PRIVATE_MARKER), false);
}

function assertStableEntrypointExcludesPrivateRegistration() {
  const stable = fs.readFileSync(path.join(ROOT, 'cli/index.js'), 'utf8');
  assert.equal(stable.includes('registerPrivateHostedCandidate'), false);
  for (const command of COMMAND_MANIFEST) {
    assert.equal(stable.includes(command), false, `stable CLI leaked ${command}`);
  }
}

function assertNormalCliRejectsHostedRoots() {
  for (const argv of [
    ['target', 'list'],
    ['capsule', 'create', '--target', 'prod'],
  ]) {
    const result = run(process.execPath, ['cli/index.js', ...argv], {
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', CI: '1' },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unknown command/);
  }
}

function assertCandidateBuilderCannotPublish() {
  const builder = fs.readFileSync(
    path.join(ROOT, 'private/hosted-cli-candidate/build-candidate.js'),
    'utf8'
  );
  assert.equal(/semantic-release|npm\s+publish|git\s+tag|gh\s+release/.test(builder), false);
  assert.match(builder, /pkg\.private = true/);
  assert.match(builder, /delete pkg\.publishConfig/);
  assert.match(builder, /run-intent\.js/);
}

function assertRequiredBuildArguments() {
  const runtimeImageDigest = `sha256:${'a'.repeat(64)}`;
  const parsed = parseArgs([
    '--runtime-image-digest',
    runtimeImageDigest,
    '--repository',
    'owner/repository',
    '--provider',
    'codex',
    '--model-level',
    'level2',
  ]);
  assert.deepEqual(parsed, {
    runtimeImageDigest,
    repository: 'owner/repository',
    provider: 'codex',
    modelLevel: 'level2',
  });
  assert.equal(Object.isFrozen(parsed), true);

  const prefix = ['--runtime-image-digest', runtimeImageDigest, '--repository', 'owner/repository'];
  assert.throws(() => parseArgs([...prefix, '--provider', 'gateway', '--model-level', 'level2']));
  assert.throws(() => parseArgs([...prefix, '--provider', 'codex', '--model-level', 'level3']));
  assert.throws(
    () =>
      parseArgs([
        ...prefix.slice(0, -1),
        'Owner/repository',
        '--provider',
        'codex',
        '--model-level',
        'level2',
      ]),
    /lowercase/
  );
  assert.throws(() => parseArgs(prefix), /provider/);
}

function registerPackageIsolationTests() {
  it(
    'keeps every candidate source and marker out of normal npm pack',
    assertNormalPackExcludesCandidate
  );
  it(
    'leaves the checked-in stable entrypoint without private registration',
    assertStableEntrypointExcludesPrivateRegistration
  );
  it(
    'normal real CLI rejects hosted roots and does not reinterpret them as local run input',
    assertNormalCliRejectsHostedRoots
  );
  it(
    'candidate build code contains no publication or release invocation',
    assertCandidateBuilderCannotPublish
  );
  it(
    'builds, installs, and launches the packed candidate',
    { timeout: 180_000 },
    assertPackedCandidateBuildsInstallsAndLaunches
  );
  it('requires the runtime image and fixed hosted selection', assertRequiredBuildArguments);
}

describe('stable/candidate package isolation', registerPackageIsolationTests);
