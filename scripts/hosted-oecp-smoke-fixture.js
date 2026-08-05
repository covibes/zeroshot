#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE_REVISION = 'a'.repeat(40);
const HEAD_REVISION = 'b'.repeat(40);
const REPOSITORY = 'the-open-engine/zeroshot-smoke';
const REMOTE = `https://github.com/${REPOSITORY}.git`;
const WORKSPACE = '/workspace';
const MODE_FILE = '/tmp/zeroshot-oecp-certification-mode';
const COMMIT_MARKER = path.join(WORKSPACE, '.git', 'certification-commit');
const OUTPUT_FILE = path.join(WORKSPACE, 'hosted-smoke-output.txt');

function certificationMode() {
  try {
    return fs.readFileSync(MODE_FILE, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return 'failure';
    throw error;
  }
}

function gitCommandArguments() {
  let args = process.argv.slice(2);
  while (args[0] === '-c') args = args.slice(2);
  if (args[0] === '-C') args = args.slice(2);
  while (args[0] === '-c') args = args.slice(2);
  return args;
}

function runGitFixture() {
  const args = gitCommandArguments();
  const command = args[0];
  if (command === 'clone') {
    fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE, '.git', 'HEAD'), `${BASE_REVISION}\n`, 'ascii');
    return;
  }
  if (command === 'checkout' || command === 'switch' || command === 'add' || command === 'push') {
    return;
  }
  if (command === 'rev-parse') {
    const revision =
      args[1] === 'refs/remotes/origin/HEAD' || !fs.existsSync(COMMIT_MARKER)
        ? BASE_REVISION
        : HEAD_REVISION;
    process.stdout.write(`${revision}\n`);
    return;
  }
  if (command === 'remote' && args[1] === 'get-url') {
    process.stdout.write(`${REMOTE}\n`);
    return;
  }
  if (command === 'status') {
    if (fs.existsSync(OUTPUT_FILE)) process.stdout.write(' M hosted-smoke-output.txt\0');
    return;
  }
  if (command === 'config') {
    process.stdout.write('core.repositoryformatversion\0remote.origin.url\0');
    return;
  }
  if (command === 'commit') {
    fs.writeFileSync(COMMIT_MARKER, `${HEAD_REVISION}\n`, 'ascii');
    return;
  }
  throw new Error(`unsupported smoke Git command: ${args.join(' ')}`);
}

function runCodexFixture() {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write('codex-cli 0.146.0\n');
    return;
  }
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --config --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox -C -m\n'
    );
    return;
  }
  const mode = certificationMode();
  if (mode === 'slow') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
    return;
  }
  fs.writeFileSync(OUTPUT_FILE, 'process-derived hosted smoke output', 'utf8');
  process.stdout.write(
    `${JSON.stringify({ type: 'thread.started', thread_id: 'smoke-thread' })}\n`
  );
  process.stdout.write(
    mode === 'success'
      ? `${JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        })}\n`
      : `${JSON.stringify({ type: 'turn.failed', error: { message: 'bounded smoke refusal' } })}\n`
  );
}

const executable = path.basename(process.argv[1]);
if (executable === 'git') runGitFixture();
else if (executable === 'codex') runCodexFixture();
else throw new Error(`unsupported smoke fixture executable: ${executable}`);
