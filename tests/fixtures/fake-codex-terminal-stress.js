#!/usr/bin/env node

const fs = require('node:fs');

const RETRYABLE_FAILURE =
  'service_unavailable: synthetic retryable provider outage; ' +
  'Authorization: Bearer sk-zs-retryable-secret';

function writeChunked(buffer) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const writeNext = () => {
      while (offset < buffer.length) {
        const next = Math.min(buffer.length, offset + 4093);
        if (!process.stdout.write(buffer.subarray(offset, next))) {
          offset = next;
          process.stdout.once('drain', writeNext);
          return;
        }
        offset = next;
      }
      resolve();
    };
    process.stdout.on('error', reject);
    writeNext();
  });
}

function providerOutput() {
  const targetBytes = Number(process.env.FAKE_CODEX_STRESS_BYTES || 12 * 1024 * 1024);
  const failAtTerminal = process.env.FAKE_CODEX_TERMINAL_FAILURE === '1';
  const recordPayload = 'medium-output-🌍'.repeat(2048);
  const lines = [JSON.stringify({ type: 'thread.started', thread_id: 'fake-stress-thread' })];
  let outputBytes = Buffer.byteLength(lines[0]) + 1;
  let index = 0;

  while (outputBytes < targetBytes) {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: `command-${index}`,
        type: 'command_execution',
        command: `stress-command-${index}`,
        aggregated_output: `${recordPayload}:${index}`,
        exit_code: 0,
      },
    });
    lines.push(line);
    outputBytes += Buffer.byteLength(line) + 1;
    index += 1;
  }

  lines.push(
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'oversized-command',
        type: 'command_execution',
        command: 'oversized-command',
        aggregated_output: 'oversized-output'.repeat(96 * 1024),
        exit_code: 0,
      },
    })
  );
  lines.push(
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'benign-auth-source',
        type: 'command_execution',
        command: 'inspect-source',
        aggregated_output: 'const Authorization = benignSource;',
        exit_code: 0,
      },
    })
  );
  if (failAtTerminal) {
    lines.push(
      JSON.stringify({
        type: 'turn.failed',
        error: {
          message: 'insufficient_quota: Authorization: Bearer sk-zs-secret-qualification',
        },
      })
    );
  } else {
    lines.push(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            summary: 'Synthetic terminal stress completed',
            result: 'UTF-8 and final structured output survived 🌍',
          }),
        },
      })
    );
    lines.push(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    );
  }
  return `${lines.join('\n')}\n`;
}

async function retryableProviderOutput() {
  const countFile = process.env.FAKE_CODEX_COUNT_FILE;
  if (!countFile) throw new Error('FAKE_CODEX_COUNT_FILE is required');
  const previous = fs.existsSync(countFile)
    ? Number.parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10) || 0
    : 0;
  const attempt = previous + 1;
  fs.writeFileSync(countFile, `${attempt}\n`);
  const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS || 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  process.stdout.write(
    `${JSON.stringify({ type: 'thread.started', thread_id: `fake-retry-${attempt}` })}\n` +
      `${JSON.stringify({ type: 'turn.failed', error: { message: RETRYABLE_FAILURE } })}\n`
  );
  process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.147.0\n');
    return;
  }
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'codex exec --json --output-schema -m -C --config --skip-git-repo-check ' +
        '--sandbox --ephemeral --ignore-user-config --ignore-rules --strict-config resume\n'
    );
    return;
  }

  if (process.env.FAKE_CODEX_RETRYABLE_TERMINAL === '1') {
    await retryableProviderOutput();
    return;
  }

  const startDelayMs = Number(process.env.FAKE_CODEX_START_DELAY_MS || 0);
  if (startDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, startDelayMs));
  }

  const output = providerOutput();
  const expectedPath = process.env.FAKE_CODEX_EXPECTED_OUTPUT;
  if (!expectedPath) throw new Error('FAKE_CODEX_EXPECTED_OUTPUT is required');
  fs.writeFileSync(expectedPath, output);
  await writeChunked(Buffer.from(output));
  if (process.env.FAKE_CODEX_TERMINAL_FAILURE === '1') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
