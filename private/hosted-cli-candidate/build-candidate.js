#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PRIVATE_MARKER } = require('./manifest');

const ROOT = path.resolve(__dirname, '../..');
const CANDIDATE_FILES = Object.freeze([
  'manifest.js',
  'readers.js',
  'credentials.js',
  'runtime-config.js',
  'orchestrator.js',
  'orchestrator-support.js',
  'queued-execution.js',
  'default-services.js',
  'default-capsule-services.js',
  'default-run-intent-services.js',
  'interrupt-signal.js',
  'run-intent.js',
  'run-intent-schema.js',
  'run-intent-http.js',
  'run-intent-observer.js',
  'target-services.js',
  'register.js',
  'register-support.js',
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

function parseOptionValues(argv) {
  const args = {};
  let valueFor;
  const names = Object.freeze({
    '--runtime-image-digest': 'runtimeImageDigest',
    '--out': 'output',
  });
  for (const arg of argv) {
    if (valueFor !== undefined) {
      args[valueFor] = arg;
      valueFor = undefined;
    } else if (names[arg]) {
      valueFor = names[arg];
    } else {
      throw new Error(`unknown build argument ${arg}`);
    }
  }
  if (valueFor !== undefined) throw new Error('build argument value is missing');
  return args;
}

function validateBuildArgs(args) {
  if (!/^sha256:[a-f0-9]{64}$/.test(args.runtimeImageDigest || '')) {
    throw new Error('--runtime-image-digest sha256:<64 lowercase hex> is required');
  }
}

function parseArgs(argv) {
  const args = parseOptionValues(argv);
  validateBuildArgs(args);
  return Object.freeze(args);
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

function writeCandidateFiles(stage, buildManifest) {
  const target = path.join(stage, 'lib/private-hosted-cli');
  fs.mkdirSync(target, { recursive: true });
  for (const file of CANDIDATE_FILES) {
    fs.copyFileSync(path.join(__dirname, file), path.join(target, file));
  }
  fs.writeFileSync(
    path.join(target, 'candidate-build.json'),
    `${JSON.stringify(buildManifest, null, 2)}\n`
  );
  fs.writeFileSync(path.join(stage, 'PRIVATE_HOSTED_CANDIDATE.txt'), `${PRIVATE_MARKER}\n`);

  const cliPath = path.join(stage, 'cli/index.js');
  const stableCli = fs.readFileSync(cliPath, 'utf8');
  const needle = '  program.parse();';
  if (stableCli.split(needle).length !== 2) throw new Error('stable CLI injection point changed');
  const registration =
    "  require('../lib/private-hosted-cli/register').registerPrivateHostedCandidate(" +
    'program, { loadSettings, mutateSettings });\n';
  fs.writeFileSync(cliPath, stableCli.replace(needle, `${registration}${needle}`));

  const scriptsPath = path.join(stage, 'scripts');
  const runtimeScripts = new Set(
    'check-path.js fix-node-pty-permissions.js omp postinstall.js'.split(' ')
  );
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
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const directory of GENERATED_OUTPUT_DIRS) {
    fs.rmSync(path.join(ROOT, directory), { recursive: true, force: true });
  }
  run('npm', ['run', 'build:agent-cli-provider']);
  run('npm', ['run', 'build:cluster']);
  run('npm', ['run', 'build:target']);

  const output =
    args.output === undefined
      ? fs.mkdtempSync(path.join(tmpdir(), 'zeroshot-private-hosted-candidate-'))
      : path.resolve(args.output);
  if (args.output !== undefined && fs.existsSync(output)) {
    throw new Error(`output path already exists: ${output}`);
  }
  const stage = path.join(output, 'staging');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });

  copyStablePackage(stage);
  const buildManifest = Object.freeze({
    privateMarker: PRIVATE_MARKER,
    runtimeImageDigest: args.runtimeImageDigest,
  });

  writeCandidateFiles(stage, buildManifest);
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
  process.stdout.write(`${JSON.stringify({ tarballPath, stage }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`candidate pack failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };
