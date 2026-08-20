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
const RUST_RELEASE_TAG_PREFIX = 'zeroshot-rust-v';
const COMMANDS = Object.freeze([
  'package',
  'manifest',
  'verify',
  'dry-run',
  'stage-version',
  'check-version',
  'check-repository',
  'print-version',
  'smoke',
  'smoke-archive',
  'publish-assets',
]);

function isVersionCharacter(character) {
  return (
    (character >= '0' && character <= '9') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '-'
  );
}

function normalizeVersion(tag) {
  const version =
    typeof tag === 'string' && tag.startsWith(RUST_RELEASE_TAG_PREFIX)
      ? tag.slice(RUST_RELEASE_TAG_PREFIX.length)
      : typeof tag === 'string' && tag.startsWith('v')
        ? tag.slice(1)
        : tag;
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
    throw new Error(
      `invalid Rust release version ${JSON.stringify(tag)}; expected X.Y.Z or ${RUST_RELEASE_TAG_PREFIX}X.Y.Z`
    );
  }
  return version;
}

function rustReleaseTag(version) {
  return `${RUST_RELEASE_TAG_PREFIX}${normalizeVersion(version)}`;
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
  verifyDistribution({ version, directory });
  return manifest;
}

function verifyDistribution({ version, directory }) {
  const expected = targets.map(({ target }) => archiveName(version, target));
  const manifest = parseChecksumManifest(
    fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8')
  );
  if (manifest.size !== expected.length || expected.some((filename) => !manifest.has(filename))) {
    throw new Error(
      `DISTRIBUTION_INCOMPLETE: SHA256SUMS must contain exactly ${expected.length} declared archives`
    );
  }
  for (const declaration of targets) {
    const filename = archiveName(version, declaration.target);
    const archive = fs.readFileSync(path.join(directory, filename));
    verifyChecksum(filename, archive, manifest);
    extractExecutable(archive, declaration.executable);
  }
  return true;
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

const STAGED_LOCK_DEPENDENCIES = Object.freeze(['windows-sys']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cargoLockPackages(cargoLock, packageName) {
  const tables = [];
  const marker = /^\[{1,2}[^\r\n]+\]{1,2}\r?$/gm;
  for (let match = marker.exec(cargoLock); match; match = marker.exec(cargoLock)) {
    tables.push({ header: match[0].trim(), start: match.index });
  }
  return tables.flatMap((table, index) => {
    if (table.header !== '[[package]]') return [];
    const text = cargoLock.slice(table.start, tables[index + 1]?.start ?? cargoLock.length);
    const name = text.match(/^name = "([^"]+)"\r?$/m)?.[1];
    const version = text.match(/^version = "([^"]+)"\r?$/m)?.[1];
    if (name !== packageName || !version) return [];
    return [
      {
        start: table.start,
        text,
        version,
        source: text.match(/^source = "([^"]+)"\r?$/m)?.[1],
      },
    ];
  });
}

function workspaceLockPackage(cargoLock) {
  const candidates = cargoLockPackages(cargoLock, 'zeroshot-rust').filter(
    (candidate) => candidate.source === undefined
  );
  if (candidates.length !== 1) {
    throw new Error(
      'RUST_VERSION_STAGE_FAILED: Cargo.lock needs exactly one source-less zeroshot-rust package'
    );
  }
  return candidates[0];
}

function workspaceDependencyRequirement(workspaceCargoToml, dependencyName) {
  const workspaceDependencies = workspaceCargoToml.match(
    /\[workspace\.dependencies\]([\s\S]*?)(?:\r?\n\[|$)/
  );
  const requirement =
    workspaceDependencies &&
    workspaceDependencies[1].match(
      new RegExp(`^${escapeRegExp(dependencyName)}\\s*=\\s*"([^"]+)"\\s*$`, 'm')
    );
  if (!requirement || !/^(\^|=)?\d+\.\d+\.\d+$/.test(requirement[1])) {
    throw new Error(
      `RUST_VERSION_STAGE_FAILED: workspace dependency ${dependencyName} has an unsupported version requirement`
    );
  }
  return requirement[1];
}

function parseCargoVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareCargoVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function cargoRequirementMatches(requirement, version) {
  const parsedVersion = parseCargoVersion(version);
  const match = /^(\^|=)?(\d+)\.(\d+)\.(\d+)$/.exec(requirement);
  if (!parsedVersion || !match) return false;
  const lower = match.slice(2).map(Number);
  if (match[1] === '=') return compareCargoVersions(parsedVersion, lower) === 0;
  const upper =
    lower[0] > 0
      ? [lower[0] + 1, 0, 0]
      : lower[1] > 0
        ? [0, lower[1] + 1, 0]
        : [0, 0, lower[2] + 1];
  return (
    compareCargoVersions(parsedVersion, lower) >= 0 &&
    compareCargoVersions(parsedVersion, upper) < 0
  );
}

function stagedLockDependencies(cargoLock, workspaceCargoToml) {
  return STAGED_LOCK_DEPENDENCIES.map((name) => {
    const requirement = workspaceDependencyRequirement(workspaceCargoToml, name);
    const candidates = cargoLockPackages(cargoLock, name);
    const satisfying = candidates.filter((candidate) =>
      cargoRequirementMatches(requirement, candidate.version)
    );
    if (satisfying.length !== 1) {
      const sourceAmbiguous =
        satisfying.length > 1 &&
        new Set(satisfying.map((candidate) => candidate.version)).size === 1;
      throw new Error(
        sourceAmbiguous
          ? `RUST_VERSION_STAGE_FAILED: Cargo.lock ${name} ${satisfying[0].version} has ambiguous sources`
          : `RUST_VERSION_STAGE_FAILED: Cargo.lock needs exactly one ${name} package satisfying ${requirement}`
      );
    }
    const selected = satisfying[0];
    return {
      name,
      requirement,
      version: selected.version,
      reference: candidates.length > 1 ? `${name} ${selected.version}` : name,
    };
  });
}

function stageCargoLock(cargoLock, version, workspaceCargoToml) {
  const targetPackage = workspaceLockPackage(cargoLock);
  let stagedPackage = targetPackage.text.replace(/^(version = ")[^"]+(")$/m, `$1${version}$2`);
  for (const dependency of stagedLockDependencies(cargoLock, workspaceCargoToml)) {
    const dependencyPattern = new RegExp(
      `^(\\s*")${escapeRegExp(dependency.name)}(?: [^"]+)?(",\\r?)$`,
      'm'
    );
    if (!dependencyPattern.test(stagedPackage)) {
      throw new Error(
        `RUST_VERSION_STAGE_FAILED: Cargo.lock zeroshot-rust entry has no ${dependency.name} dependency`
      );
    }
    stagedPackage = stagedPackage.replace(dependencyPattern, `$1${dependency.reference}$2`);
  }
  return (
    cargoLock.slice(0, targetPackage.start) +
    stagedPackage +
    cargoLock.slice(targetPackage.start + targetPackage.text.length)
  );
}

function verifyStagedCargoLock(cargoLock, version, workspaceCargoToml) {
  const targetPackage = workspaceLockPackage(cargoLock);
  if (targetPackage.version !== version) {
    throw new Error(
      `${VERSION_ERROR}: release tag version ${version} does not match Cargo.lock zeroshot-rust version ${targetPackage.version}`
    );
  }
  for (const dependency of stagedLockDependencies(cargoLock, workspaceCargoToml)) {
    const dependencyPattern = new RegExp(`^\\s*"${escapeRegExp(dependency.reference)}",\\r?$`, 'm');
    if (!dependencyPattern.test(targetPackage.text)) {
      throw new Error(
        `${VERSION_ERROR}: Cargo.lock zeroshot-rust dependency ${dependency.name} is not coupled to ${dependency.version}`
      );
    }
  }
}

function stageVersion(
  tag,
  cargoManifestPath = path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'),
  cargoLockPath = path.join(repositoryRoot, 'Cargo.lock'),
  workspaceManifestPath = path.join(repositoryRoot, 'Cargo.toml')
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
  const workspaceCargoToml = fs.readFileSync(workspaceManifestPath, 'utf8');
  const stagedLock = stageCargoLock(cargoLock, version, workspaceCargoToml);
  verifyStagedCargoLock(stagedLock, version, workspaceCargoToml);
  fs.writeFileSync(cargoManifestPath, stagedManifest);
  fs.writeFileSync(cargoLockPath, stagedLock);
  return { currentVersion, version };
}

function checkVersionCoupling(tag, cargoToml, cargoLock, workspaceCargoToml) {
  const useRepositoryFiles = cargoToml === undefined;
  const manifest =
    cargoToml ?? fs.readFileSync(path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'), 'utf8');
  const releaseVersion = normalizeVersion(tag);
  const manifestVersion = cargoVersion(manifest);
  if (releaseVersion !== manifestVersion) {
    throw new Error(
      `${VERSION_ERROR}: release tag version ${releaseVersion} does not match zeroshot-rust/Cargo.toml version ${manifestVersion}`
    );
  }
  const lock =
    cargoLock ??
    (useRepositoryFiles
      ? fs.readFileSync(path.join(repositoryRoot, 'Cargo.lock'), 'utf8')
      : undefined);
  if (lock !== undefined) {
    const workspace =
      workspaceCargoToml ?? fs.readFileSync(path.join(repositoryRoot, 'Cargo.toml'), 'utf8');
    verifyStagedCargoLock(lock, releaseVersion, workspace);
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

const RUST_DISTRIBUTION_INVOCATION =
  /(?:(?:\bnode\s+)|(?:^|[\s(]))["']?(?:\.\/)?scripts\/rust-distribution\.js["']?(?=$|[\s)`;&|])/;

const SCRIPT_INSTALL_CONTRACTS = Object.freeze([
  {
    jobName: 'rust-binaries',
    installName: 'Install pinned script dependencies',
    command: 'npm ci --ignore-scripts',
    checkoutRef: '${{ needs.plan.outputs.commit }}',
  },
  {
    jobName: 'rust-manifest',
    installName: 'Install pinned script dependencies',
    command: 'npm ci --ignore-scripts',
    checkoutRef: '${{ needs.plan.outputs.commit }}',
  },
  {
    jobName: 'rust-image-input',
    installName: 'Install pinned script dependencies',
    command: 'npm ci --ignore-scripts',
    checkoutRef: '${{ needs.plan.outputs.commit }}',
  },
  {
    jobName: 'rust-publish',
    installName: 'Install pinned script dependencies',
    command: 'npm ci --ignore-scripts',
    checkoutRef: '${{ needs.plan.outputs.commit }}',
  },
  {
    jobName: 'rust-shim-input',
    installName: 'Install pinned script dependencies',
    command: 'npm ci --ignore-scripts',
    checkoutRef: '${{ needs.plan.outputs.commit }}',
  },
]);

function invokesRustDistribution(step) {
  return typeof step.run === 'string' && RUST_DISTRIBUTION_INVOCATION.test(step.run);
}

function checkScriptInstall(job, { jobName, installName, command, checkoutRef }) {
  if (!job) failIntegrity(`release workflow has no ${jobName} job`);
  const install = findStep(job, installName);
  if (
    install.if !== undefined ||
    install['working-directory'] !== undefined ||
    install.run?.trim() !== command
  ) {
    failIntegrity(`${jobName} dependency install must execute at workspace root: ${command}`);
  }
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  if (
    !checkout ||
    checkout.if !== undefined ||
    checkout.with?.path !== undefined ||
    (checkout.with?.repository !== undefined &&
      checkout.with.repository !== '${{ github.repository }}') ||
    checkout.with?.ref !== checkoutRef
  ) {
    failIntegrity(`${jobName} must checkout expected current repository source at workspace root`);
  }
  const installIndex = job.steps.indexOf(install);
  const checkoutIndex = job.steps.indexOf(checkout);
  if (checkoutIndex >= installIndex) {
    failIntegrity(`${jobName} must checkout source before dependency installation`);
  }
  const nodeSetup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const nodeSetupIndex = job.steps.indexOf(nodeSetup);
  if (
    !nodeSetup ||
    nodeSetup.if !== undefined ||
    nodeSetup.uses !== 'actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903' ||
    String(nodeSetup.with?.['node-version']) !== '24' ||
    nodeSetup.with?.cache !== 'npm' ||
    nodeSetupIndex <= checkoutIndex ||
    nodeSetupIndex >= installIndex
  ) {
    failIntegrity(`${jobName} must enable pinned Node 24 npm cache before dependency installation`);
  }
  if (job.steps.slice(0, installIndex).some(invokesRustDistribution)) {
    failIntegrity(
      `${jobName} must install dependencies before every rust-distribution.js invocation`
    );
  }
}

function checkScriptInstalls(jobs) {
  for (const contract of SCRIPT_INSTALL_CONTRACTS) {
    checkScriptInstall(jobs[contract.jobName], contract);
  }
}

function checkLinuxCToolchain(job) {
  const linuxC = findStep(job, 'Install static Linux C toolchain');
  if (
    linuxC.if !== "runner.os == 'Linux'" ||
    linuxC.env?.C_COMPILER !== '${{ matrix.c-compiler }}' ||
    !linuxC.run?.includes('sudo apt-get install --yes musl-tools') ||
    !linuxC.run.includes('echo "CC=$C_COMPILER" >> "$GITHUB_ENV"') ||
    !linuxC.run.includes('echo "RUSTFLAGS=-C link-arg=-lgcc" >> "$GITHUB_ENV"')
  ) {
    failIntegrity('Linux release build does not use the matrix-selected static C toolchain');
  }
}

function checkMacCToolchain(job) {
  const macC = findStep(job, 'Verify bundled SQLite C toolchain');
  if (
    macC.if !== "runner.os == 'macOS'" ||
    macC.env?.C_COMPILER !== '${{ matrix.c-compiler }}' ||
    macC.run?.trim() !== 'command -v "$C_COMPILER"'
  ) {
    failIntegrity('macOS bundled-SQLite C compiler setup does not use the matrix mapping');
  }
}

function checkWindowsCToolchain(job) {
  const windowsC = findStep(job, 'Verify bundled SQLite MSVC toolchain');
  if (
    windowsC.if !== "runner.os == 'Windows'" ||
    !windowsC.run?.includes('Microsoft.VisualStudio.Component.VC.Tools.x86.x64')
  ) {
    failIntegrity('Windows bundled-SQLite MSVC setup is missing');
  }
}

function checkNativeCToolchains(job) {
  checkLinuxCToolchain(job);
  checkMacCToolchain(job);
  checkWindowsCToolchain(job);
}

function checkStaticLinuxBinary(job) {
  const step = findStep(job, 'Verify static Linux release binary');
  if (
    step.if !== "runner.os == 'Linux'" ||
    !step.run?.includes('readelf --program-headers "$BINARY_PATH"') ||
    !step.run.includes('Linux release binary has a dynamic interpreter')
  ) {
    failIntegrity('Linux release binary is not verified as statically portable');
  }
}

function checkBuildJob(jobs) {
  const job = jobs['rust-binaries'];
  if (!job) failIntegrity('release workflow has no rust-binaries job');
  exactJson('rust-binaries dependencies', ['plan'], [...(job.needs || [])].sort());
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
  checkNativeCToolchains(job);

  const stage = findStep(job, 'Stage explicit Rust package version');
  if (
    stage.if !== undefined ||
    stage.run?.trim() !== 'node scripts/rust-distribution.js stage-version --tag "$RELEASE_TAG"'
  ) {
    failIntegrity('explicit Rust version staging is missing before locked target builds');
  }
  const coupling = findStep(job, 'Verify staged Rust package version');
  if (
    coupling.if !== undefined ||
    coupling.run?.trim() !== 'node scripts/rust-distribution.js check-version --tag "$RELEASE_TAG"'
  ) {
    failIntegrity('staged Rust version verification is missing');
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
  checkStaticLinuxBinary(job);
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
  --archive "rust-release/zeroshot-rust-v\${{ needs.plan.outputs.version }}-\${{ matrix.target }}.tar.gz"`;
  if (archiveSmoke.if !== undefined || archiveSmoke.run?.trim() !== exactArchiveSmoke) {
    failIntegrity('archive smoke step must execute the extracted target binary exactly');
  }
  const upload = findStep(job, 'Upload target archive');
  if (
    upload.if !== undefined ||
    upload.uses !== 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' ||
    upload.with?.name !== 'zeroshot-rust-archive-${{ matrix.target }}' ||
    upload.with?.path !== 'rust-release/*.tar.gz' ||
    upload.with?.['if-no-files-found'] !== 'error'
  ) {
    failIntegrity('rust-binaries per-target archive upload name/path is incomplete');
  }
}

function checkManifestJob(jobs) {
  const job = jobs['rust-manifest'];
  if (!job) failIntegrity('release workflow has no rust-manifest job');
  exactJson('rust-manifest dependencies', ['plan', 'rust-binaries'], [...(job.needs || [])].sort());
  const manifest = findStep(job, 'Build and verify complete checksum manifest');
  if (
    manifest.run?.trim() !==
    'node scripts/rust-distribution.js manifest --version "$RELEASE_TAG" --dir rust-release'
  ) {
    failIntegrity('rust-manifest does not execute the deterministic manifest verifier');
  }
  const upload = findStep(job, 'Upload complete Rust distribution');
  if (
    upload.if !== undefined ||
    upload.uses !== 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' ||
    upload.with?.name !== 'zeroshot-rust-distribution-v${{ needs.plan.outputs.version }}' ||
    upload.with?.path?.trim() !== 'rust-release/*.tar.gz\nrust-release/SHA256SUMS'
  ) {
    failIntegrity('complete archive and SHA256SUMS upload is missing');
  }
}

function checkManualInputs(document, jobs) {
  const dispatch = document.on?.workflow_dispatch;
  exactJson(
    'Rust release actions',
    ['dry-run', 'release', 'publish-npm-shim'],
    dispatch?.inputs?.action?.options
  );
  if (!dispatch.inputs.version?.required || !dispatch.inputs.release_commit?.required) {
    failIntegrity('manual Rust release requires explicit version and commit inputs');
  }
  const verification = findStep(jobs.plan, 'Verify exact main commit and independent tag').run;
  for (const required of [
    'git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main',
    'release_tag="zeroshot-rust-v$RELEASE_VERSION"',
    '[[ "$tag_commit" == "$RELEASE_COMMIT" ]]',
    'has no successful CI / required check',
    'new Rust version $RELEASE_VERSION must be newer than $latest_version',
  ]) {
    if (!verification?.includes(required)) {
      failIntegrity(`Rust release plan is missing exact-source guard: ${required}`);
    }
  }
}

function checkCanonicalImageScript(script) {
  for (const required of [
    'version_ref="$RUST_IMAGE:$RELEASE_VERSION"',
    'commit_ref="$RUST_IMAGE:$RELEASE_COMMIT"',
    'immutable Rust image tags resolve to different images',
    'docker image tag "$canonical" "$version_ref"',
    'docker image tag "$canonical" "$commit_ref"',
    'docker image tag "$canonical" "$RUST_IMAGE:latest"',
  ]) {
    if (!script?.includes(required)) {
      failIntegrity(`GHCR publication is missing canonical image guard: ${required}`);
    }
  }
  if (
    !script?.includes('org.opencontainers.image.revision') ||
    !script.includes('if [[ "$PUBLISH_LATEST" == "true" ]]')
  ) {
    failIntegrity('GHCR publication does not source-verify tags and guard latest');
  }
}

function checkAnonymousImagePull(job) {
  const step = findStep(job, 'Verify anonymous image installation');
  if (
    !step.env?.DOCKER_CONFIG?.includes('zeroshot-rust-anonymous-docker') ||
    !step.run?.includes('docker pull "$RUST_IMAGE:$RELEASE_VERSION"')
  ) {
    failIntegrity('published target image is not verified through anonymous installation');
  }
}

function checkImageJobs(jobs) {
  const input = jobs['rust-image-input'];
  exactJson('rust-image-input dependencies', ['plan'], [...(input?.needs || [])].sort());
  const build = findStep(input, 'Build linux/amd64 target image');
  const expectedBuild = `docker build --platform linux/amd64 \\
  --build-arg "VCS_REF=$RELEASE_COMMIT" \\
  --build-arg "ZEROSHOT_RUST_VERSION=$RELEASE_VERSION" \\
  --file docker/zeroshot-rust-target/Dockerfile \\
  --tag "$RUST_IMAGE:$RELEASE_VERSION" .`;
  if (build.run?.trim() !== expectedBuild) {
    failIntegrity('target image does not build the public Rust target Dockerfile');
  }
  findStep(input, 'Save exact image publication input');
  findStep(input, 'Upload exact image publication input');
  if (input.permissions?.packages === 'write') {
    failIntegrity('image dry-run input job must not receive publication authority');
  }

  const publish = jobs['rust-image-publish'];
  exactJson(
    'rust-image-publish dependencies',
    ['plan', 'rust-image-input', 'rust-publish'],
    [...(publish?.needs || [])].sort()
  );
  if (
    publish.permissions?.packages !== 'write' ||
    !publish.if?.includes("inputs.action == 'release'")
  ) {
    failIntegrity('GHCR publication is not isolated to the release action');
  }
  checkCanonicalImageScript(findStep(publish, 'Publish source-verified image tags').run);
  checkAnonymousImagePull(publish);
}

function checkPublicationJobs(jobs) {
  const publish = jobs['rust-publish'];
  exactJson(
    'rust-publish dependencies',
    ['plan', 'rust-image-input', 'rust-manifest'],
    [...(publish?.needs || [])].sort()
  );
  if (!publish.if?.includes("inputs.action == 'release'")) {
    failIntegrity('GitHub publication is not isolated to the release action');
  }
  const create = findStep(publish, 'Create or verify independent GitHub Release');
  if (
    (create.run?.match(/--latest=false/g) || []).length !== 2 ||
    create.run.includes('--latest=true')
  ) {
    failIntegrity('Rust GitHub Release must not replace the Node release as Latest');
  }
  const assets = findStep(publish, 'Verify existing assets and upload only missing names');
  if (
    assets.run?.trim() !==
    'node scripts/rust-distribution.js publish-assets --tag "$RELEASE_TAG" --dir rust-release'
  ) {
    failIntegrity('GitHub Release assets are not verified and uploaded without overwrite');
  }

  const shimInput = jobs['rust-shim-input'];
  if (
    !shimInput.if?.includes("inputs.action == 'dry-run'") ||
    !shimInput.if.includes("inputs.action == 'publish-npm-shim'")
  ) {
    failIntegrity('npm shim input is not exercised by dry-run and explicit shim publication');
  }
  findStep(shimInput, 'Verify exact shim distribution inputs');
  findStep(shimInput, 'Pack exact npm shim publication input');
  const shimInstall = findStep(
    shimInput,
    'Install exact shim tarball against verified release inputs'
  ).run;
  if (
    !shimInstall?.includes(
      'npm install --ignore-scripts --prefix "$install_root" "${tarballs[0]}"'
    ) ||
    !shimInstall.includes('tarballs=(./shim-release/*.tgz)') ||
    !shimInstall.includes('$install_root/node_modules/.bin/zeroshot-rust')
  ) {
    failIntegrity('npm shim input is not installed and invoked from the exact packed tarball');
  }
  const shimDryRun = findStep(shimInput, 'Dry-run npm shim publication');
  if (shimDryRun.if !== "inputs.action == 'dry-run'") {
    failIntegrity('npm shim dry-run must not gate recoverable publication');
  }
  if (!shimDryRun.run?.includes('npm publish --dry-run --access public ./shim-release/*.tgz')) {
    failIntegrity('npm shim dry-run must publish the exact local tarball');
  }
  findStep(shimInput, 'Upload exact npm shim publication input');

  const shimPublish = jobs['rust-shim-publish'];
  if (
    !shimPublish.if?.includes("inputs.action == 'publish-npm-shim'") ||
    shimPublish.permissions?.['id-token'] !== 'write'
  ) {
    failIntegrity('npm shim publication is not a separate OIDC-authorized action');
  }
  const npmPublish = findStep(shimPublish, 'Idempotently publish standalone Rust shim package').run;
  if (
    !npmPublish?.includes('npm view "$package" version') ||
    !npmPublish.includes('npm view "$package" dist.integrity') ||
    !npmPublish.includes('npm publish --provenance --access public ./shim-release/*.tgz')
  ) {
    failIntegrity('npm shim publication is not idempotently recoverable');
  }
}

function checkNodeReleaseIndependence(document) {
  const workflow = JSON.stringify(document);
  for (const forbidden of [
    'rust-distribution.js',
    'recover-rust-distribution',
    'rust-binaries',
    'rust-manifest',
    'rust-publish',
  ]) {
    if (workflow.includes(forbidden))
      failIntegrity(`Node release retains Rust coupling: ${forbidden}`);
  }
  const jobs = document.jobs || {};
  const release = jobs.release;
  exactJson(
    'Node release dependencies',
    ['install-matrix', 'release-plan'],
    [...(release?.needs || [])].sort()
  );
  findStep(release, 'Run semantic-release');
  const relevance = findStep(jobs['node-relevance'], 'Classify unreleased Node history');
  if (
    !relevance.run?.includes('git rev-list --reverse') ||
    !relevance.run.includes('scripts/node-release-commits.js')
  ) {
    failIntegrity('Node release does not classify all history since the latest Node tag');
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

function hasValidSri(integrity) {
  if (typeof integrity !== 'string') return false;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) return false;
  const expectedBytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1]];
  const digest = Buffer.from(match[2], 'base64');
  return digest.length === expectedBytes && digest.toString('base64') === match[2];
}

function checkScriptDependencies(packageManifest, packageLock) {
  // js-yaml is a runtime dependency: lib/compose-utils.js requires it from the published package.
  const directSpec = packageManifest.dependencies?.['js-yaml'];
  if (typeof directSpec !== 'string' || directSpec.length === 0) {
    failIntegrity('rust-distribution.js requires a direct js-yaml dependency');
  }
  const lockSpec = packageLock.packages?.['']?.dependencies?.['js-yaml'];
  if (lockSpec !== directSpec) {
    failIntegrity('package-lock root js-yaml spec must match package.json');
  }
  const resolved = packageLock.packages?.['node_modules/js-yaml'];
  if (
    typeof resolved?.version !== 'string' ||
    resolved.version.trim().length === 0 ||
    typeof resolved.resolved !== 'string' ||
    resolved.resolved.trim().length === 0 ||
    !hasValidSri(resolved.integrity)
  ) {
    failIntegrity('package-lock must contain an integrity-pinned resolved js-yaml package');
  }
}

function checkRepository(
  rustWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'release-rust.yml'),
    'utf8'
  ),
  nodeWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
    'utf8'
  ),
  shimTargets = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'npm', 'zeroshot-rust', 'targets.json'), 'utf8')
  ),
  packageManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')),
  packageLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'))
) {
  let document;
  let nodeDocument;
  try {
    document = jsYaml.load(rustWorkflow);
    nodeDocument = jsYaml.load(nodeWorkflow);
  } catch (error) {
    failIntegrity(`release workflow is invalid YAML: ${error.message}`);
  }
  if (!document?.jobs || !nodeDocument?.jobs) failIntegrity('release workflow has no jobs');
  checkScriptInstalls(document.jobs);
  checkBuildJob(document.jobs);
  checkManifestJob(document.jobs);
  checkManualInputs(document, document.jobs);
  checkImageJobs(document.jobs);
  checkPublicationJobs(document.jobs);
  checkNodeReleaseIndependence(nodeDocument);
  checkShimTargets(shimTargets);
  checkScriptDependencies(packageManifest, packageLock);
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
  if (command === 'verify') {
    verifyDistribution({ version: argument('version'), directory: argument('dir') });
    process.stdout.write(`verified ${targets.length} existing archives and SHA256SUMS\n`);
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
    smokeExecutable(binaryPath, 'RUST_BINARY_SMOKE_FAILED');
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
      smokeExecutable(binaryPath, 'RUST_ARCHIVE_SMOKE_FAILED');
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
  throw new Error(`usage: rust-distribution.js <${COMMANDS.join('|')}>`);
}

function smokeExecutable(
  binaryPath,
  failureCode,
  expectedVersion = cargoVersion(
    fs.readFileSync(path.join(repositoryRoot, 'zeroshot-rust', 'Cargo.toml'), 'utf8')
  )
) {
  const result = childProcess.spawnSync(binaryPath, ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`${failureCode}: status=${result.status} signal=${result.signal || 'none'}`);
  }
  const expected = `zeroshot-rust ${expectedVersion}\n`;
  if (result.stdout !== expected) {
    throw new Error(
      `${failureCode}: expected ${JSON.stringify(expected.trim())}, received ${JSON.stringify(result.stdout.trim())}`
    );
  }
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
  rustReleaseTag,
  sha256,
  smokeExecutable,
  targetForHost,
  stageVersion,
  targets,
  verifyChecksum,
  verifyDistribution,
};
