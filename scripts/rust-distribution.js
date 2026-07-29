#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jsYaml = require('js-yaml');
const zlib = require('zlib');

const repositoryRoot = path.resolve(__dirname, '..');
const targetManifestPath = path.join(repositoryRoot, 'distribution', 'zeroshot-rust-targets.json');
const targets = Object.freeze(JSON.parse(fs.readFileSync(targetManifestPath, 'utf8')));
const VERSION_ERROR = 'RUST_VERSION_MISMATCH';

function isVersionCharacter(character) {
  return (
    (character >= '0' && character <= '9') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '-'
  );
}

function normalizeVersion(tag) {
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : tag;
  const prereleaseStart = typeof version === 'string' ? version.indexOf('-') : -1;
  const core = prereleaseStart === -1 ? version : version.slice(0, prereleaseStart);
  const prerelease = prereleaseStart === -1 ? '' : version.slice(prereleaseStart + 1);
  const coreParts = typeof core === 'string' ? core.split('.') : [];
  const validCore = coreParts.length === 3 && coreParts.every((part) => part && /^\d+$/.test(part));
  const validPrerelease =
    !prerelease ||
    prerelease
      .split('.')
      .every((part) => part && [...part].every((character) => isVersionCharacter(character)));
  if (!validCore || !validPrerelease) {
    throw new Error(`invalid release tag ${JSON.stringify(tag)}; expected vX.Y.Z`);
  }
  return version;
}

function archiveName(version, target) {
  return `zeroshot-rust-v${normalizeVersion(version)}-${target}.tar.gz`;
}

function targetForHost(platform, arch) {
  const found = targets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch
  );
  if (!found) {
    throw new Error(
      `UNSUPPORTED_ZEROSHOT_RUST_HOST: no prebuilt binary for ${platform}/${arch}; supported hosts: ${targets
        .map((candidate) => `${candidate.platform}/${candidate.arch}`)
        .join(', ')}`
    );
  }
  return found;
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0';
  buffer.write(encoded, offset, length, 'ascii');
}

function tarEntry(name, contents, mode = 0o755) {
  if (Buffer.byteLength(name) > 100) throw new Error(`archive entry name is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(
    header,
    148,
    8,
    [...header].reduce((sum, byte) => sum + byte, 0)
  );
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function createArchive(binary, executable) {
  const tar = Buffer.concat([tarEntry(executable, binary), Buffer.alloc(1024)]);
  return zlib.gzipSync(tar, { level: 9, mtime: 0 });
}

function extractExecutable(archive, expectedName) {
  const tar = zlib.gunzipSync(archive);
  const name = tar.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const sizeText = tar.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
  if (name !== expectedName || !/^[0-7]+$/.test(sizeText)) {
    throw new Error(`ARCHIVE_INVALID: expected sole executable ${expectedName}`);
  }
  const size = Number.parseInt(sizeText, 8);
  const end = 512 + size;
  if (end > tar.length) throw new Error('ARCHIVE_INVALID: truncated executable');
  const nextHeader = 512 + Math.ceil(size / 512) * 512;
  if (!tar.subarray(nextHeader).every((byte) => byte === 0)) {
    throw new Error('ARCHIVE_INVALID: archive contains unexpected entries');
  }
  return Buffer.from(tar.subarray(512, end));
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function parseChecksumManifest(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    if (checksums.has(match[2])) throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function verifyChecksum(filename, contents, manifest) {
  const checksums = manifest instanceof Map ? manifest : parseChecksumManifest(manifest);
  const expected = checksums.get(filename);
  if (!expected) throw new Error(`CHECKSUM_MISSING: SHA256SUMS has no entry for ${filename}`);
  const actual = sha256(contents);
  if (actual !== expected) {
    throw new Error(`CHECKSUM_MISMATCH: ${filename} expected ${expected} but received ${actual}`);
  }
  return true;
}

function packageTarget({ target, version, binaryPath, outputDirectory }) {
  const declaration = targets.find((candidate) => candidate.target === target);
  if (!declaration) throw new Error(`undeclared Rust release target: ${target}`);
  const binary = fs.readFileSync(binaryPath);
  const filename = archiveName(version, target);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, filename),
    createArchive(binary, declaration.executable)
  );
  return filename;
}

function createManifest({ version, directory }) {
  const entries = targets.map(({ target }) => {
    const filename = archiveName(version, target);
    const contents = fs.readFileSync(path.join(directory, filename));
    return `${sha256(contents)}  ${filename}`;
  });
  const manifest = `${entries.join('\n')}\n`;
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), manifest);
  const parsed = parseChecksumManifest(manifest);
  for (const { target } of targets) {
    const filename = archiveName(version, target);
    verifyChecksum(filename, fs.readFileSync(path.join(directory, filename)), parsed);
  }
  return manifest;
}

function runGh(args) {
  return childProcess.execFileSync('gh', args, { encoding: 'utf8' });
}

function publishAssets({ tag, directory, invokeGh = runGh }) {
  const names = [...targets.map(({ target }) => archiveName(tag, target)), 'SHA256SUMS'];
  const localAssets = new Map(
    names.map((name) => [name, fs.readFileSync(path.join(directory, name))])
  );
  const release = JSON.parse(invokeGh(['release', 'view', tag, '--json', 'assets']));
  const existingNames = release.assets.map(({ name }) => name);
  if (new Set(existingNames).size !== existingNames.length) {
    throw new Error('RELEASE_ASSET_CONFLICT: GitHub Release contains duplicate asset names');
  }

  const existingRequired = names.filter((name) => existingNames.includes(name));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-rust-assets-'));
  try {
    for (const name of existingRequired) {
      invokeGh(['release', 'download', tag, '--pattern', name, '--dir', temporary]);
      const published = fs.readFileSync(path.join(temporary, name));
      if (!published.equals(localAssets.get(name))) {
        throw new Error(`RELEASE_ASSET_CONFLICT: existing ${name} differs from verified artifact`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const missing = names.filter((name) => !existingNames.includes(name));
  for (const name of missing) {
    invokeGh(['release', 'upload', tag, path.join(directory, name)]);
  }
  return { existing: existingRequired, uploaded: missing };
}

function cargoVersion(cargoToml) {
  const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  const version = packageSection && packageSection[1].match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!version) throw new Error('zeroshot-rust/Cargo.toml has no package version');
  return version[1];
}

function stageVersion(
  tag,
  cargoManifestPath = path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'),
  cargoLockPath = path.join(repositoryRoot, 'Cargo.lock')
) {
  const version = normalizeVersion(tag);
  const cargoToml = fs.readFileSync(cargoManifestPath, 'utf8');
  const currentVersion = cargoVersion(cargoToml);
  const stagedManifest = cargoToml.replace(
    /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`
  );
  if (cargoVersion(stagedManifest) !== version) {
    throw new Error('RUST_VERSION_STAGE_FAILED: Cargo.toml package version was not updated');
  }

  const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const lockPattern = /(\[\[package\]\]\r?\nname = "zeroshot-rust"\r?\nversion = ")[^"]+(")/;
  if (!lockPattern.test(cargoLock)) {
    throw new Error('RUST_VERSION_STAGE_FAILED: Cargo.lock has no zeroshot-rust package entry');
  }
  const stagedLock = cargoLock.replace(lockPattern, `$1${version}$2`);
  fs.writeFileSync(cargoManifestPath, stagedManifest);
  fs.writeFileSync(cargoLockPath, stagedLock);
  return { currentVersion, version };
}

function checkVersionCoupling(
  tag,
  cargoToml = fs.readFileSync(path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'), 'utf8')
) {
  const releaseVersion = normalizeVersion(tag);
  const manifestVersion = cargoVersion(cargoToml);
  if (releaseVersion !== manifestVersion) {
    throw new Error(
      `${VERSION_ERROR}: release tag version ${releaseVersion} does not match zeroshot-rust/Cargo.toml version ${manifestVersion}`
    );
  }
  return releaseVersion;
}

function failIntegrity(message) {
  throw new Error(`RUST_DISTRIBUTION_INTEGRITY: ${message}`);
}

function exactJson(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    failIntegrity(
      `${label} differs from the authoritative declaration: expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`
    );
  }
}

function findStep(job, name) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) failIntegrity(`job is missing enabled step ${name}`);
  if (step.if === false || step.if === '${{ false }}') {
    failIntegrity(`step ${name} is disabled`);
  }
  return step;
}

function checkScriptInstall(job, jobName) {
  const install = findStep(job, 'Install pinned script dependencies');
  if (install.if !== undefined || install.run?.trim() !== 'npm ci --ignore-scripts') {
    failIntegrity(`${jobName} must install pinned script dependencies without lifecycle scripts`);
  }
  if (
    job.steps.some(
      (step, index) =>
        index < job.steps.indexOf(install) &&
        step.run?.includes('node scripts/rust-distribution.js')
    )
  ) {
    failIntegrity(`${jobName} must install pinned script dependencies before every invocation`);
  }
}

function checkBuildJob(jobs) {
  const job = jobs['rust-binaries'];
  if (!job) failIntegrity('release workflow has no rust-binaries job');
  exactJson(
    'rust-binaries dependencies',
    ['dry-run', 'release-plan', 'rust-recovery-plan'],
    [...(job.needs || [])].sort()
  );
  const expectedMatrix = targets.map(({ target, runner, executable, cCompiler }) => ({
    target,
    runner,
    executable,
    'c-compiler': cCompiler,
  }));
  exactJson('rust-binaries matrix rows', expectedMatrix, job.strategy?.matrix?.include);

  const setup = findStep(job, 'Setup Rust 1.97.0 target');
  if (
    setup.uses !== 'dtolnay/rust-toolchain@stable' ||
    setup.with?.toolchain !== '1.97.0' ||
    setup.with?.targets !== '${{ matrix.target }}'
  ) {
    failIntegrity('Rust target toolchain setup does not install the declared matrix target');
  }
  const unixC = findStep(job, 'Verify bundled SQLite C toolchain');
  if (
    unixC.if !== "runner.os != 'Windows'" ||
    unixC.env?.C_COMPILER !== '${{ matrix.c-compiler }}' ||
    unixC.run?.trim() !== 'command -v "$C_COMPILER"'
  ) {
    failIntegrity('Unix bundled-SQLite C compiler setup does not use the matrix mapping');
  }
  const windowsC = findStep(job, 'Verify bundled SQLite MSVC toolchain');
  if (
    windowsC.if !== "runner.os == 'Windows'" ||
    !windowsC.run?.includes('Microsoft.VisualStudio.Component.VC.Tools.x86.x64')
  ) {
    failIntegrity('Windows bundled-SQLite MSVC setup is missing');
  }

  checkScriptInstall(job, 'rust-binaries');

  const stage = findStep(job, 'Stage planned Rust package version');
  if (
    stage.if !== undefined ||
    stage.run?.trim() !== 'node scripts/rust-distribution.js stage-version --tag "$RELEASE_TAG"'
  ) {
    failIntegrity('planned Rust version staging is missing before locked target builds');
  }
  const coupling = findStep(job, 'Verify Rust and release tag versions are coupled');
  if (
    coupling.if !== undefined ||
    coupling.run?.trim() !== 'node scripts/rust-distribution.js check-version --tag "$RELEASE_TAG"'
  ) {
    failIntegrity('staged Rust version coupling verification is missing');
  }

  const build = findStep(job, 'Build standalone Rust release binary');
  const exactBuild =
    'cargo build --release --locked -p zeroshot-rust --bin zeroshot-rust --target ${{ matrix.target }}';
  if (
    build.if !== undefined ||
    build.run?.trim() !== exactBuild ||
    job.steps.indexOf(stage) > job.steps.indexOf(build) ||
    job.steps.indexOf(coupling) > job.steps.indexOf(build)
  ) {
    failIntegrity(`rust-binaries build step must execute exactly: ${exactBuild}`);
  }
  const nativeSmoke = findStep(job, 'Run standalone Rust release binary');
  if (
    nativeSmoke.if !== undefined ||
    nativeSmoke.run?.trim() !== 'node scripts/rust-distribution.js smoke --binary "$BINARY_PATH"'
  ) {
    failIntegrity('native Rust executable smoke step must execute the built binary exactly');
  }
  findStep(job, 'Package target archive');
  const archiveSmoke = findStep(job, 'Run executable extracted from target archive');
  const exactArchiveSmoke = `node scripts/rust-distribution.js smoke-archive \\
  --target "\${{ matrix.target }}" \\
  --archive "rust-release/zeroshot-rust-\${RELEASE_TAG}-\${{ matrix.target }}.tar.gz"`;
  if (archiveSmoke.if !== undefined || archiveSmoke.run?.trim() !== exactArchiveSmoke) {
    failIntegrity('archive smoke step must execute the extracted target binary exactly');
  }
  const upload = findStep(job, 'Upload target archive');
  if (
    upload.if !== undefined ||
    upload.uses !== 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' ||
    upload.with?.name !== 'zeroshot-rust-${{ matrix.target }}' ||
    upload.with?.path !== 'rust-release/*.tar.gz' ||
    upload.with?.['if-no-files-found'] !== 'error'
  ) {
    failIntegrity('rust-binaries per-target archive upload name/path is incomplete');
  }
}

function checkManifestJob(jobs) {
  const job = jobs['rust-manifest'];
  if (!job) failIntegrity('release workflow has no rust-manifest job');
  exactJson(
    'rust-manifest dependencies',
    ['dry-run', 'release-plan', 'rust-binaries', 'rust-recovery-plan'],
    [...(job.needs || [])].sort()
  );
  checkScriptInstall(job, 'rust-manifest');
  const manifest = findStep(job, 'Build and verify complete checksum manifest');
  if (
    manifest.run?.trim() !==
    'node scripts/rust-distribution.js manifest --version "$RELEASE_TAG" --dir rust-release'
  ) {
    failIntegrity('rust-manifest does not execute the deterministic manifest verifier');
  }
  const upload = findStep(job, 'Upload complete dry-run distribution');
  if (
    upload.if !== undefined ||
    upload.uses !== 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' ||
    upload.with?.name !== 'zeroshot-rust-${{ env.RELEASE_TAG }}' ||
    upload.with?.path?.trim() !== 'rust-release/*.tar.gz\nrust-release/SHA256SUMS'
  ) {
    failIntegrity('complete archive and SHA256SUMS upload is missing');
  }
}

function checkPublicationJobs(document, jobs) {
  const release = jobs.release;
  exactJson(
    'release dependencies',
    ['install-matrix', 'release-plan', 'rust-manifest'],
    [...(release?.needs || [])].sort()
  );
  if (!release.if?.includes("vars.RELEASE_AUTOMATION_ENABLED == 'true'")) {
    failIntegrity('release publication is not guarded by RELEASE_AUTOMATION_ENABLED');
  }
  const semantic = findStep(release, 'Run semantic-release');
  if (!semantic.run?.split(/\r?\n/).some((line) => line.trim() === 'npx semantic-release')) {
    failIntegrity('release job does not execute semantic-release');
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    if (jobName === 'release') continue;
    if (
      job.steps?.some((step) =>
        step.run?.split(/\r?\n/).some((line) => line.trim() === 'npx semantic-release')
      )
    ) {
      failIntegrity(`semantic-release runs before artifacts in ${jobName}`);
    }
  }

  if (
    !document.on?.workflow_dispatch?.inputs?.action?.options?.includes('recover-rust-distribution')
  ) {
    failIntegrity('workflow_dispatch has no recover-rust-distribution action');
  }
  const recovery = jobs['rust-recovery-plan'];
  const immutable = findStep(recovery, 'Verify immutable matching release tag');
  const recoveryLines = immutable.run?.split(/\r?\n/).map((line) => line.trim()) || [];
  if (
    !recoveryLines.includes('tag_commit="$(git rev-parse "${RELEASE_TAG}^{commit}")"') ||
    !recoveryLines.includes('if ! git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main; then')
  ) {
    failIntegrity('Rust recovery does not execute immutable tag and main ancestry verification');
  }
  const publish = jobs['rust-publish'];
  exactJson(
    'rust-publish dependencies',
    ['release', 'rust-manifest', 'rust-recovery-plan'],
    [...(publish?.needs || [])].sort()
  );
  checkScriptInstall(publish, 'rust-publish');
  if (!publish.if?.includes("inputs.action == 'recover-rust-distribution'")) {
    failIntegrity('post-tag Rust publication is not recoverable');
  }
  const assets = findStep(publish, 'Verify existing assets and upload only missing names');
  if (
    assets.if !== undefined ||
    assets.run?.trim() !==
      'node scripts/rust-distribution.js publish-assets --tag "$RELEASE_TAG" --dir rust-release'
  ) {
    failIntegrity('GitHub Release assets are not verified and uploaded without overwrite');
  }
  const npmPublish = findStep(publish, 'Idempotently publish standalone Rust shim package').run;
  if (!npmPublish?.includes('npm view "$package" version') || !npmPublish.includes('npm publish')) {
    failIntegrity('shim publication is not idempotently recoverable');
  }
}

function checkShimTargets(shimTargets) {
  const projected = targets
    .map(({ platform, arch, target, executable }) => ({ platform, arch, target, executable }))
    .sort((left, right) =>
      `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`)
    );
  const actual = [...shimTargets].sort((left, right) =>
    `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`)
  );
  exactJson('npm shim host mapping', projected, actual);
}

function checkScriptDependencies(packageManifest) {
  if (!Object.hasOwn(packageManifest.devDependencies || {}, 'js-yaml')) {
    failIntegrity('rust-distribution.js requires a direct js-yaml devDependency');
  }
}

function checkRepository(
  workflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
    'utf8'
  ),
  shimTargets = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'npm', 'zeroshot-rust', 'targets.json'), 'utf8')
  ),
  packageManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  )
) {
  let document;
  try {
    document = jsYaml.load(workflow);
  } catch (error) {
    failIntegrity(`release workflow is invalid YAML: ${error.message}`);
  }
  if (!document?.jobs) failIntegrity('release workflow has no jobs');
  checkBuildJob(document.jobs);
  checkManifestJob(document.jobs);
  checkPublicationJobs(document, document.jobs);
  checkShimTargets(shimTargets);
  checkScriptDependencies(packageManifest);
  return true;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing --${name}`);
  return process.argv[index + 1];
}

function run() {
  const command = process.argv[2];
  if (command === 'package') {
    const filename = packageTarget({
      target: argument('target'),
      version: argument('version'),
      binaryPath: argument('binary'),
      outputDirectory: argument('out'),
    });
    process.stdout.write(`${filename}\n`);
    return;
  }
  if (command === 'manifest') {
    createManifest({ version: argument('version'), directory: argument('dir') });
    process.stdout.write(`verified ${targets.length} archives and SHA256SUMS\n`);
    return;
  }
  if (command === 'dry-run') {
    const version = argument('version');
    const binaryPath = argument('binary');
    const outputDirectory = argument('out');
    for (const { target } of targets)
      packageTarget({ target, version, binaryPath, outputDirectory });
    createManifest({ version, directory: outputDirectory });
    process.stdout.write(`dry-run produced and verified ${targets.length} archives\n`);
    return;
  }
  if (command === 'stage-version') {
    const staged = stageVersion(argument('tag'));
    process.stdout.write(
      `staged Rust package version ${staged.currentVersion} -> ${staged.version}\n`
    );
    return;
  }
  if (command === 'check-version') {
    const version = checkVersionCoupling(argument('tag'));
    process.stdout.write(`Rust package version matches release tag: ${version}\n`);
    return;
  }
  if (command === 'print-version') {
    process.stdout.write(
      `${cargoVersion(fs.readFileSync(path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'), 'utf8'))}\n`
    );
    return;
  }
  if (command === 'smoke') {
    const binaryPath = path.resolve(argument('binary'));
    const result = childProcess.spawnSync(binaryPath, [], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) {
      throw new Error(
        `RUST_BINARY_SMOKE_FAILED: status=${result.status} signal=${result.signal || 'none'}`
      );
    }
    process.stdout.write(`Rust release executable exited 0: ${binaryPath}\n`);
    return;
  }
  if (command === 'smoke-archive') {
    const target = argument('target');
    const declaration = targets.find((candidate) => candidate.target === target);
    if (!declaration) throw new Error(`undeclared Rust release target: ${target}`);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-rust-smoke-'));
    const binaryPath = path.join(directory, declaration.executable);
    try {
      const executable = extractExecutable(
        fs.readFileSync(argument('archive')),
        declaration.executable
      );
      fs.writeFileSync(binaryPath, executable, { mode: 0o755 });
      const result = childProcess.spawnSync(binaryPath, [], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.signal || result.status !== 0) {
        throw new Error(
          `RUST_ARCHIVE_SMOKE_FAILED: status=${result.status} signal=${result.signal || 'none'}`
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write(`Rust release archive executable exited 0: ${target}\n`);
    return;
  }
  if (command === 'publish-assets') {
    const result = publishAssets({ tag: argument('tag'), directory: argument('dir') });
    process.stdout.write(
      `verified ${result.existing.length} existing assets and uploaded ${result.uploaded.length} missing assets\n`
    );
    return;
  }
  if (command === 'check-repository') {
    checkRepository();
    process.stdout.write(
      `Rust distribution workflow declares ${targets.length} complete targets\n`
    );
    return;
  }
  throw new Error(
    'usage: rust-distribution.js <package|manifest|dry-run|stage-version|check-version|check-repository|print-version|smoke|smoke-archive|publish-assets>'
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  VERSION_ERROR,
  archiveName,
  checkRepository,
  checkVersionCoupling,
  createArchive,
  createManifest,
  extractExecutable,
  cargoVersion,
  publishAssets,
  normalizeVersion,
  packageTarget,
  parseChecksumManifest,
  sha256,
  targetForHost,
  stageVersion,
  targets,
  verifyChecksum,
};
