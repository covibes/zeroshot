#!/usr/bin/env node

const { isUtf8 } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TYPESCRIPT_AUTHORITIES = [
  'tsconfig.agent-cli-provider.json',
  'tsconfig.cluster.json',
  'tsconfig.hosted-session.json',
  'tsconfig.hosted-target.json',
  'tsconfig.target.json',
];

const DEFAULT_CHECKS = [
  'typescript.syntax',
  'typescript.types',
  'typescript.import-graph',
  'typescript.dead-code',
  'typescript.function-metrics',
  'typescript.relevant-tests',
  'typescript.file-length',
  'rust.source-hygiene',
  'rust.fmt',
  'rust.cargo-check',
  'rust.clippy',
  'rust.rustdoc',
  'rust.import-graph',
  'rust.dead-code',
  'rust.graph-signals',
  'rust.file-length',
  'rust.function-metrics',
  'clone.duplication',
].join(',');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'buffer',
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
  });
  if (result.error) throw result.error;
  return result;
}

function git(repo, args, options = {}) {
  const result = run('git', args, {
    cwd: repo,
    encoding: options.encoding ?? 'buffer',
    env: options.env,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function withoutGitLocalEnv(repo) {
  const names = git(repo, ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const env = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

function valueOption(argv, index) {
  const arg = argv[index];
  for (const key of ['base', 'checks']) {
    const flag = `--${key}`;
    if (arg === flag) return { key, value: argv[index + 1], consumed: 1 };
    if (arg.startsWith(`${flag}=`)) return { key, value: arg.slice(flag.length + 1), consumed: 0 };
  }
  return null;
}

function parseArgs(argv) {
  const options = { base: 'HEAD', checks: DEFAULT_CHECKS, staged: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--staged') {
      options.staged = true;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      index += 1;
      continue;
    }
    const option = valueOption(argv, index);
    if (!option) throw new Error(`Unsupported Opcore introduced-check argument: ${arg}`);
    options[option.key] = option.value;
    index += option.consumed + 1;
  }
  if (!options.base) throw new Error('--base requires a Git revision');
  if (options.staged && options.base !== 'HEAD') {
    throw new Error('--staged cannot be combined with a non-HEAD --base');
  }
  return options;
}

function nulTokens(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter((token) => token.length > 0);
}

function parseChanges(repo, options) {
  const args = options.staged
    ? ['diff', '--cached', '--name-status', '-z', '--find-renames', 'HEAD', '--']
    : ['diff', '--name-status', '-z', '--find-renames', options.base, '--'];
  const tokens = nulTokens(git(repo, args));
  const changes = [];

  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      changes.push({ kind, oldPath: tokens[index++], path: tokens[index++] });
    } else if ('AMDT'.includes(kind)) {
      changes.push({ kind, path: tokens[index++] });
    } else {
      throw new Error(`Unsupported Git change status: ${status}`);
    }
  }

  if (!options.staged) {
    for (const untrackedPath of nulTokens(
      git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
    )) {
      changes.push({ kind: 'A', path: untrackedPath });
    }
  }

  const byPath = new Map();
  for (const change of changes) byPath.set(change.path, change);
  return [...byPath.values()];
}

function safePath(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Changed path escapes repository root: ${relativePath}`);
  }
  return absolute;
}

function readAfter(repo, change, staged) {
  let content;
  if (staged) {
    content = git(repo, ['show', `:${change.path}`]);
  } else {
    const absolute = safePath(repo, change.path);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Opcore introduced gate supports regular changed files only: ${change.path}`);
    }
    content = fs.readFileSync(absolute);
  }
  return isUtf8(content) && !content.includes(0) ? content.toString('utf8') : null;
}

function copyPolicy(repo, baseline) {
  const source = path.join(repo, '.opcore', 'config');
  if (!fs.existsSync(source)) return;
  const target = path.join(baseline, '.opcore', 'config');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function linkDependencies(repo, baseline) {
  const source = path.join(repo, 'node_modules');
  const target = path.join(baseline, 'node_modules');
  if (fs.existsSync(source) && !fs.existsSync(target)) fs.symlinkSync(source, target, 'dir');
}

function normalizeBaselineRename(baseline, change) {
  if (change.kind !== 'R') return;
  const source = safePath(baseline, change.oldPath);
  const target = safePath(baseline, change.path);
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
}
function applyBaselineDeletion(baseline, change) {
  if (change.kind !== 'D') return;
  fs.rmSync(safePath(baseline, change.path), { recursive: true, force: true });
}

function createRequest(repo, baseline, changes, options) {
  const overlays = [];
  const files = [];
  for (const change of changes) {
    normalizeBaselineRename(baseline, change);
    applyBaselineDeletion(baseline, change);
    if (change.kind === 'D') {
      continue;
    }
    const content = readAfter(repo, change, options.staged);
    if (content === null) continue;
    overlays.push({ action: 'write', path: change.path, content });
    files.push(change.path);
  }
  for (const authority of TYPESCRIPT_AUTHORITIES) {
    if (fs.existsSync(safePath(baseline, authority))) files.push(authority);
  }

  return {
    requestId: `zeroshot-opcore-introduced-${process.pid}`,
    repo: { repoRoot: baseline },
    scope: { kind: 'files', files: [...new Set(files)] },
    graph: { mode: 'optional', provider: 'opcore-graph' },
    overlays,
    ...(options.checks ? { checks: options.checks.split(',').filter(Boolean) } : {}),
    reportMode: 'introduced',
  };
}

function runOpcoreDirect(repo, args, env = process.env) {
  const entrypoint = require.resolve('opcore');
  return run(process.execPath, [entrypoint, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...env,
      PATH: `${path.join(repo, 'node_modules', '.bin')}${path.delimiter}${env.PATH || ''}`,
    },
  });
}

function emit(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  git(repo, ['rev-parse', '--verify', `${options.base}^{commit}`]);
  const changes = parseChanges(repo, options);
  if (changes.length === 0) {
    emit(runOpcoreDirect(repo, ['check', '--changed', '--json']));
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opcore-baseline-'));
  const baseline = path.join(tempRoot, 'repo');
  try {
    const baselineEnv = withoutGitLocalEnv(repo);
    git(repo, ['clone', '--quiet', '--shared', '--no-checkout', repo, baseline], {
      env: baselineEnv,
    });
    git(baseline, ['checkout', '--quiet', '--detach', options.base], {
      env: baselineEnv,
    });
    linkDependencies(repo, baseline);
    copyPolicy(repo, baseline);
    const request = createRequest(repo, baseline, changes, options);
    if (request.overlays.length === 0) {
      emit(runOpcoreDirect(repo, ['check', '--changed', '--json']));
      return;
    }
    const requestPath = path.join(tempRoot, 'validation-request.json');
    fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
    emit(
      runOpcoreDirect(
        baseline,
        ['validate', 'hypothetical', '--request-file', requestPath, '--json'],
        baselineEnv
      )
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
