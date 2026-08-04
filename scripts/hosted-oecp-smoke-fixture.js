#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE_REVISION = 'a'.repeat(40);
const REPOSITORY = 'the-open-engine/zeroshot-smoke';
const REMOTE = `https://github.com/${REPOSITORY}.git`;
const WORKSPACE = '/workspace';

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
    process.stdout.write(`${BASE_REVISION}\n`);
    return;
  }
  if (command === 'remote' && args[1] === 'get-url') {
    process.stdout.write(`${REMOTE}\n`);
    return;
  }
  if (command === 'status' || command === 'config') return;
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
  fs.writeFileSync(
    path.join(WORKSPACE, 'hosted-smoke-output.txt'),
    'process-derived hosted smoke output',
    'utf8'
  );
  process.stdout.write(
    `${JSON.stringify({ type: 'thread.started', thread_id: 'smoke-thread' })}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ type: 'turn.failed', error: { message: 'bounded smoke refusal' } })}\n`
  );
}

const executable = path.basename(process.argv[1]);
if (executable === 'git') runGitFixture();
else if (executable === 'codex') runCodexFixture();
else throw new Error(`unsupported smoke fixture executable: ${executable}`);
