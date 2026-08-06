#!/usr/bin/env node
import fs from 'node:fs';

const WORKSPACE = '/workspace';
const args = process.argv.slice(2);
const CODEX_HELP = [
  'Usage: codex exec --json --skip-git-repo-check',
  '--config --ephemeral --ignore-user-config --ignore-rules',
  '--strict-config --sandbox -C -m',
].join(' ');

if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.146.0\n');
} else if (args.includes('--help')) {
  process.stdout.write(`${CODEX_HELP}\n`);
} else {
  if (
    args.includes('--dangerously-bypass-approvals-and-sandbox') ||
    args[args.indexOf('--sandbox') + 1] !== 'danger-full-access' ||
    !args.includes('approval_policy="never"')
  ) {
    throw new Error('hosted Codex did not use the fixed capsule boundary');
  }
  fs.writeFileSync(
    `${WORKSPACE}/hosted-smoke-output.txt`,
    'process-derived hosted smoke output',
    'utf8'
  );
  const events = [
    { type: 'thread.started', thread_id: 'smoke-thread' },
    { type: 'turn.failed', error: { message: 'bounded smoke refusal' } },
  ];
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}
