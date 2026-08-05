#!/usr/bin/env node
import fs from 'node:fs';

const WORKSPACE = '/workspace';
const MODE_FILE = '/tmp/zeroshot-oecp-certification-mode';
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.146.0\n');
} else if (args.includes('--help')) {
  process.stdout.write(
    'Usage: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --config --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox -C -m\n'
  );
} else {
  let mode = 'failure';
  try {
    mode = fs.readFileSync(MODE_FILE, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (mode === 'slow') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
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
      mode === 'success'
        ? `${JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 1, output_tokens: 1 },
          })}\n`
        : `${JSON.stringify({ type: 'turn.failed', error: { message: 'bounded smoke refusal' } })}\n`
    );
  }
}
