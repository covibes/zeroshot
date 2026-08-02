#!/usr/bin/env node
/**
 * Fake OMP (`@oh-my-pi/pi-coding-agent`) CLI for deterministic OMP-provider tests.
 *
 * A generic registry provider is resolved from PATH by its binary name (`omp`), so dropping an
 * executable literally named `omp` on PATH makes the real stack (CLI parsing -> registry
 * resolution -> preflight availability probe -> spawn -> OMP JSON parsing -> ledger) run for
 * real, offline, with no API calls.
 *
 * Behaviour:
 *   omp --version   -> print a version line, exit 0 (availability probe).
 *   omp --help/-h   -> print usage listing every flag the omp adapter emits/detects, exit 0
 *                      (drives detectCliFeatures + the help-or-version probe).
 *   omp ... -p ...  -> a non-interactive print run: write `omp-received.json` into
 *                      process.cwd() recording {argv, cwd, env} (env limited to credential-shaped
 *                      names), then emit OMP-shaped JSON (one assistant event + a success result).
 */

const fs = require('fs');
const path = require('path');

const USAGE = [
  'omp - OMP coding agent (fake)',
  '',
  'Usage: omp [options] [prompt]',
  '  --mode <mode>          Output mode, e.g. json',
  '  -p, --print            Non-interactive print mode',
  '  --cwd <dir>            Working directory for the session',
  '  --auto-approve         Auto-approve tool calls',
  '  --model <model>        Set the model to use',
  '  --thinking <effort>    Reasoning effort (low/medium/high)',
  '  --no-extensions        Disable extensions',
  '  --no-skills            Disable skills',
  '  --no-rules             Disable rules',
  '  --no-title             Disable session title generation',
].join('\n');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--version')) {
    process.stdout.write('omp v17.2.1 (fake)\n');
    process.exit(0);
  }

  const isRun = argv.includes('-p') || argv.includes('--print');
  if (!isRun || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const received = {
    argv,
    cwd: process.cwd(),
    env: Object.keys(process.env).filter((k) => /API_KEY|TOKEN|SECRET/.test(k)),
  };
  const target = path.resolve(process.cwd(), 'omp-received.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(received));
  process.stderr.write(`fake-omp: wrote ${target}\n`);

  const text = 'Implemented the requested feature.';
  emit({ type: 'message_start', message: { role: 'assistant' } });
  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  emit({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    },
  });
  process.exit(0);
}

main();
