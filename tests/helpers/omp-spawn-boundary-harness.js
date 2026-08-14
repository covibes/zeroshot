const assert = require('assert');
const { execFileAsync, fs, os, path, pathToFileURL, runNodeModule } = require('./test-runtime');

const moduleUrl = (relativePath) => pathToFileURL(path.resolve(__dirname, relativePath)).href;
const storeUrl = moduleUrl('../../task-lib/store.js');
const runnerUrl = moduleUrl('../../task-lib/runner.js');
const ownershipUrl = moduleUrl('../../task-lib/omp-session-ownership.js');
const cleanupUrl = moduleUrl('../../task-lib/omp-session-cleanup.js');
const killCommandUrl = moduleUrl('../../task-lib/commands/kill.js');

// Advertises exactly the evidence assertRequiredOmpFeatures() demands, so the real spawnTask
// reaches the rpc-stdio lane without a real OMP install (same shape as
// tests/unit/task-runner-prompt-channel.test.js).
const FAKE_OMP = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('omp 17.2.1\\n');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: omp [options]\\n  Modes: rpc\\n  --config --model --thinking --approval-mode --no-title --no-session --session-dir --resume\\n');
  process.exit(0);
}
process.exit(0);
`;

const WATCHER_SPAWN_STUB = `const forks = [];
childProcess.spawn = (executable, [script, ...argv], options) => {
  const stdinChunks = [];
  forks.push({ executable, script, argv, options, stdinChunks });
  return {
    stdin: {
      on() {},
      end(chunk) {
        if (chunk !== undefined) stdinChunks.push(Buffer.from(chunk).toString('base64'));
      },
    },
    unref() {},
  };
};`;

/** Run the real spawnTask with watcher spawn stubbed so no watcher process is created. */
const SPAWN_HARNESS = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('child_process');
${WATCHER_SPAWN_STUB}

const { spawnTask } = await import(${JSON.stringify(runnerUrl)});
const { loadTasks } = await import(${JSON.stringify(storeUrl)});

let threw = null;
let spawnedId = null;
try {
  spawnedId = spawnTask('do the thing', { provider: 'omp', model: 'openai/test-model' })?.id ?? null;
} catch (error) {
  threw = { message: error.message, code: error.code ?? null };
}

process.stdout.write('\\n@@' + JSON.stringify({
  threw,
  spawnedId,
  forks: forks.length,
  tasks: Object.values(loadTasks()).map((task) => ({
    id: task.id,
    status: task.status,
    error: task.error,
    exitCode: task.exitCode,
    pid: task.pid,
    ownership: task.ompSessionOwnership,
  })),
}));
`;

const PROMPT_HARNESS = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('child_process');
${WATCHER_SPAWN_STUB}

const { spawnTask } = await import(${JSON.stringify(runnerUrl)});
spawnTask(process.env.HARNESS_PROMPT, {
  provider: process.env.HARNESS_PROVIDER,
  model: process.env.HARNESS_MODEL,
});
process.stdout.write('\\n@@' + JSON.stringify(forks));
`;

function makeHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-omp-spawn-${label}-`));
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const fakeOmp = path.join(binDir, 'omp');
  fs.writeFileSync(fakeOmp, FAKE_OMP);
  fs.chmodSync(fakeOmp, 0o755);
  const settingsFile = path.join(home, 'settings.json');
  const level = { model: 'openai/test-model', reasoningEffort: 'max' };
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      providerSettings: {
        omp: {
          transport: 'rpc',
          minLevel: 'level1',
          defaultLevel: 'level2',
          maxLevel: 'level3',
          levelOverrides: { level1: level, level2: level, level3: level },
        },
      },
    })
  );
  return { home, binDir, settingsFile };
}

function homeEnv({ home, binDir, settingsFile }) {
  return {
    HOME: home,
    USERPROFILE: home,
    ZEROSHOT_HOME: home,
    ZEROSHOT_SETTINGS_FILE: settingsFile,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
}

/** Runs a script against this home's store. A non-zero exit is a legitimate outcome for some of
 * these commands (`zeroshot task kill` sets process.exitCode when it cannot confirm termination),
 * so the stdout is returned either way and the assertions judge the durable state. */
function runInHome(homeInfo, script) {
  return runNodeModule(script, homeEnv(homeInfo), (stdout) => stdout.includes('@@'));
}

async function runSpawnHarness(homeInfo) {
  const harnessPath = path.join(homeInfo.home, 'spawn-harness.mjs');
  fs.writeFileSync(harnessPath, SPAWN_HARNESS);
  const { stdout } = await execFileAsync(process.execPath, [harnessPath], {
    env: { ...process.env, ...homeEnv(homeInfo) },
  });
  return JSON.parse(stdout.split('@@').pop());
}

async function runPromptHarness({ provider, model, prompt }) {
  const homeInfo = makeHome('prompt-channel');
  const harnessPath = path.join(homeInfo.home, 'prompt-harness.mjs');
  fs.writeFileSync(harnessPath, PROMPT_HARNESS);
  try {
    const { stdout } = await execFileAsync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        ...homeEnv(homeInfo),
        HARNESS_PROVIDER: provider,
        HARNESS_MODEL: model,
        HARNESS_PROMPT: prompt,
      },
    });
    return JSON.parse(stdout.split('@@').pop());
  } finally {
    fs.rmSync(homeInfo.home, { recursive: true, force: true });
  }
}

/** The standalone storage root spawnTask uses: TASKS_DIR under ZEROSHOT_HOME. */
async function tasksDir(homeInfo) {
  const stdout = await runInHome(
    homeInfo,
    `const { TASKS_DIR } = await import(${JSON.stringify(
      pathToFileURL(path.resolve(__dirname, '../../task-lib/config.js')).href
    )});
     process.stdout.write(TASKS_DIR);`
  );
  return stdout.trim();
}

module.exports = {
  assert,
  cleanupUrl,
  fs,
  killCommandUrl,
  makeHome,
  ownershipUrl,
  path,
  runInHome,
  runSpawnHarness,
  runPromptHarness,
  storeUrl,
  tasksDir,
};
