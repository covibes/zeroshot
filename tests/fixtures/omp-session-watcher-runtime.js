const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '../..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-watcher-'));
const binDir = path.join(stateDir, 'bin');
const marker = path.join(stateDir, 'invocations.jsonl');
const settingsFile = path.join(stateDir, 'settings.json');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(settingsFile, '{}');
fs.writeFileSync(
  path.join(binDir, 'omp'),
  `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: omp --mode json -p --cwd <path> --auto-approve --resume=<value>\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('omp 1.0.0\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args) + '\\n');
const prompt = args.at(-1);
const emit = (value) => process.stdout.write(typeof value === 'string' ? value + '\\n' : JSON.stringify(value) + '\\n');
if (prompt === 'fresh-valid' || prompt === 'resume-valid') {
  emit({ type: 'session', version: 3, id: 'omp-1' });
} else if (prompt === 'resume-fork') {
  emit({ type: 'session', version: 3, id: 'omp-forked' });
} else if (prompt === 'fresh-missing') {
  emit({ type: 'turn_start' });
} else if (prompt === 'malformed-then-valid') {
  emit('{broken');
  emit({ type: 'session', version: 3, id: 'omp-later-valid' });
} else if (prompt === 'fresh-conflict') {
  emit({ type: 'session', version: 3, id: 'omp-a' });
  emit({ type: 'session', version: 3, id: 'omp-b' });
} else if (prompt === 'prefix-mismatch') {
  emit({ type: 'session', version: 3, id: 'omp-prefix-full' });
} else if (prompt === 'whitespace-id') {
  emit({ type: 'session', version: 3, id: ' omp-space ' });
}
`,
  { mode: 0o755 }
);

process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;
process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;

async function waitForTerminal(getTask, taskId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const task = getTask(taskId);
    if (task && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for OMP task ${taskId}`);
}

async function main() {
  const runnerUrl = pathToFileURL(path.join(repoRoot, 'task-lib/runner.js')).href;
  const storeUrl = pathToFileURL(path.join(repoRoot, 'task-lib/store.js')).href;
  const { spawnTask } = await import(runnerUrl);
  const { getTask } = await import(storeUrl);

  function run(prompt, resume = null) {
    const task = spawnTask(prompt, {
      provider: 'omp',
      cwd: repoRoot,
      outputFormat: 'stream-json',
      attachable: false,
      ...(resume === null ? {} : { resume }),
    });
    return waitForTerminal(getTask, task.id);
  }

  const fresh = await run('fresh-valid');
  const resumed = await run('resume-valid', fresh.sessionId);
  const forked = await run('resume-fork', fresh.sessionId);
  const missing = await run('fresh-missing');
  const malformedThenValid = await run('malformed-then-valid');
  const conflicting = await run('fresh-conflict');
  const prefixMismatch = await run('prefix-mismatch', 'omp-prefix');
  const whitespace = await run('whitespace-id');
  const invocations = fs
    .readFileSync(marker, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  process.stdout.write(
    `RESULT:${JSON.stringify({
      repoRoot,
      fresh,
      resumed,
      forked,
      missing,
      malformedThenValid,
      conflicting,
      prefixMismatch,
      whitespace,
      invocations,
    })}\n`
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
