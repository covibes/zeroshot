#!/usr/bin/env node
import fs from 'node:fs';

const WORKSPACE = '/workspace';
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.146.0\n');
} else if (args.includes('--help')) {
  process.stdout.write(
    'Usage: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --config --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox -C -m\n'
  );
} else {
  fs.writeFileSync(
    `${WORKSPACE}/hosted-smoke-output.txt`,
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
