#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { COMMAND_MANIFEST, FIXTURE_DIGEST, PRIVATE_MARKER } = require('./manifest');

const ROOT = path.resolve(__dirname, '../..');
const CANDIDATE_FILES = Object.freeze([
  'manifest.js',
  'readers.js',
  'credentials.js',
  'github-credential.js',
  'secret-input.js',
  'install-client.js',
  'install-protocol.js',
  'orchestrator.js',
  'orchestrator-support.js',
  'default-services.js',
  'target-services.js',
  'register.js',
]);
const PROTOCOL_FILES = Object.freeze([
  'src/cluster/generated/protocol.ts',
  'src/cluster/generated/protocol-schema.ts',
  'protocol/openengine-cluster/v1/schema.json',
  'protocol/openengine-cluster/v1/graph.schema.json',
]);
const GENERATED_OUTPUT_DIRS = Object.freeze([
  'lib/agent-cli-provider',
  'lib/cluster',
  'lib/hosted-session',
  'lib/hosted-target',
  'lib/target',
]);

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.trim();
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function fileDigest(file) {
  return sha256(fs.readFileSync(file));
}

function parseArgs(argv) {
  let runtimeImageDigest;
  let output;
  let valueFor;
  for (const arg of argv) {
    if (valueFor === 'runtime') {
      runtimeImageDigest = arg;
      valueFor = undefined;
    } else if (valueFor === 'output') {
      output = arg;
      valueFor = undefined;
    } else if (arg === '--runtime-image-digest') valueFor = 'runtime';
    else if (arg === '--out') valueFor = 'output';
    else throw new Error(`unknown build argument ${arg}`);
  }
  if (valueFor !== undefined) throw new Error('build argument value is missing');
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImageDigest || '')) {
    throw new Error('--runtime-image-digest sha256:<64 lowercase hex> is required');
  }
  return { runtimeImageDigest, output };
}

function assertCleanSource(allowGeneratedOutputs = false) {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  const generatedPrefixes = GENERATED_OUTPUT_DIRS.map((directory) => `?? ${directory}/`);
  const unexpected = status
    .split('\n')
    .filter(Boolean)
    .filter(
      (line) =>
        !(allowGeneratedOutputs && generatedPrefixes.some((prefix) => line.startsWith(prefix)))
    );
  if (unexpected.length > 0) {
    throw new Error('candidate source tree must be clean before immutable packing');
  }
}

function fixtureDigest() {
  const corpus = path.join(ROOT, 'tests/fixtures/zero-cloud-44');
  const http = path.join(corpus, 'contracts/http');
  const meta = JSON.parse(fs.readFileSync(path.join(http, 'hosted-target/META.json'), 'utf8'));
  const files = [
    ...meta.promoted_schemas.map((entry) => path.resolve(corpus, entry)),
    ...['valid', 'invalid'].flatMap((kind) =>
      fs
        .readdirSync(path.join(http, 'hosted-target/fixtures', kind))
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(http, 'hosted-target/fixtures', kind, name))
    ),
  ].sort((left, right) => path.relative(corpus, left).localeCompare(path.relative(corpus, right)));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const name = path.relative(corpus, file);
    const bytes = fs.readFileSync(file);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function copyStablePackage(stage) {
  const dryRun = JSON.parse(
    run('npm', ['pack', '--json', '--dry-run', '--ignore-scripts', '--foreground-scripts=false'])
  );
  const files = dryRun[0]?.files;
  if (!Array.isArray(files) || files.length === 0)
    throw new Error('npm dry-run returned no package files');
  for (const item of files) {
    const relative = item.path;
    if (
      typeof relative !== 'string' ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes('..')
    ) {
      throw new Error('npm dry-run returned an unsafe package path');
    }
    const source = path.join(ROOT, relative);
    const destination = path.join(stage, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
  }
}

function writeCandidateFiles(stage, immutable) {
  const target = path.join(stage, 'lib/private-hosted-cli');
  fs.mkdirSync(target, { recursive: true });
  for (const file of CANDIDATE_FILES) {
    fs.copyFileSync(path.join(__dirname, file), path.join(target, file));
  }
  fs.writeFileSync(
    path.join(target, 'candidate-build.json'),
    `${JSON.stringify(immutable, null, 2)}\n`
  );
  fs.writeFileSync(path.join(stage, 'PRIVATE_HOSTED_CANDIDATE.txt'), `${PRIVATE_MARKER}\n`);

  const cliPath = path.join(stage, 'cli/index.js');
  const stableCli = fs.readFileSync(cliPath, 'utf8');
  const needle = '  program.parse();';
  if (stableCli.split(needle).length !== 2) throw new Error('stable CLI injection point changed');
  const registration =
    "  require('../lib/private-hosted-cli/register').registerPrivateHostedCandidate(program, { loadSettings, mutateSettings });\n";
  fs.writeFileSync(cliPath, stableCli.replace(needle, `${registration}${needle}`));

  const scriptsPath = path.join(stage, 'scripts');
  const runtimeScripts = new Set(['check-path.js', 'fix-node-pty-permissions.js']);
  for (const entry of fs.readdirSync(scriptsPath)) {
    if (!runtimeScripts.has(entry)) {
      fs.rmSync(path.join(scriptsPath, entry), { recursive: true, force: true });
    }
  }

  const packagePath = path.join(stage, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.name = '@the-open-engine/zeroshot-private-hosted-candidate';
  pkg.private = true;
  pkg.description = `${PRIVATE_MARKER}: unpublished build-time-only candidate`;
  delete pkg.release;
  delete pkg.publishConfig;
  delete pkg.devDependencies;
  delete pkg['lint-staged'];
  pkg.scripts = pkg.scripts?.postinstall ? { postinstall: pkg.scripts.postinstall } : {};
  pkg.files = [...new Set([...(pkg.files || []), 'PRIVATE_HOSTED_CANDIDATE.txt'])];
  pkg.zeroshotPrivateCandidate = immutable;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertCleanSource(true);
  for (const directory of GENERATED_OUTPUT_DIRS) {
    fs.rmSync(path.join(ROOT, directory), { recursive: true, force: true });
  }
  run('npm', ['run', 'build:agent-cli-provider']);
  run('npm', ['run', 'build:cluster']);
  run('npm', ['run', 'build:target']);
  assertCleanSource(true);

  const sourceSha = run('git', ['rev-parse', 'HEAD']);
  const output = path.resolve(
    args.output ||
      path.join(os.tmpdir(), `zeroshot-private-hosted-candidate-${sourceSha.slice(0, 12)}`)
  );
  if (fs.existsSync(output)) throw new Error(`output path already exists: ${output}`);
  const stage = path.join(output, 'staging');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });

  const observedFixtureDigest = fixtureDigest();
  if (observedFixtureDigest !== FIXTURE_DIGEST)
    throw new Error('frozen Zero Cloud fixture digest mismatch');
  const commandManifestDigest = sha256(Buffer.from(`${JSON.stringify(COMMAND_MANIFEST)}\n`));
  const immutable = Object.freeze({
    privateMarker: PRIVATE_MARKER,
    sourceSha,
    lockfileDigest: fileDigest(path.join(ROOT, 'package-lock.json')),
    commandManifest: COMMAND_MANIFEST,
    commandManifestDigest,
    fixtureDigest: observedFixtureDigest,
    runtimeImageDigest: args.runtimeImageDigest,
    protocolDigests: Object.fromEntries(
      PROTOCOL_FILES.map((file) => [file, fileDigest(path.join(ROOT, file))])
    ),
  });

  copyStablePackage(stage);
  writeCandidateFiles(stage, immutable);
  const packed = JSON.parse(
    run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--foreground-scripts=false',
        '--pack-destination',
        output,
      ],
      stage
    )
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack did not report a candidate filename');
  const tarballPath = path.join(output, filename);
  const provenance = Object.freeze({
    ...immutable,
    tarball: filename,
    tarballDigest: fileDigest(tarballPath),
    stagingPath: stage,
    generatedAt: new Date().toISOString(),
  });
  const provenancePath = path.join(output, 'candidate-provenance.json');
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ tarballPath, provenancePath, stage, ...provenance }, null, 2)}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`candidate pack failed: ${error.message}\n`);
  process.exitCode = 1;
}
