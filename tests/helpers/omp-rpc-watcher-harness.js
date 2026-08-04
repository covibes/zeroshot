const assert = require('assert');
const { fork } = require('child_process');
const { execFileAsync, fs, os, path, pathToFileURL, runNodeModule } = require('./test-runtime');

const zeroshotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-rpc-watcher-home-'));
const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-ownership.js')
).href;

const FAKE_OMP_RPC_PATH = path.join(__dirname, 'fake-omp-rpc.js');
const RPC_WATCHER_PATH = path.join(__dirname, '..', '..', 'task-lib', 'rpc-watcher.js');
const SENTINEL_PROMPT = 'ZS_SENTINEL_PROMPT_MARKER_DO_NOT_LOG_8f21c3';
const { SENTINEL_SYSTEM, SENTINEL_MESSAGE, SENTINEL_CONTROL } = require('./omp-rpc-sentinels');
const { encodeWatcherPromptFrame, sendWatcherPrompt } = require('../../src/watcher-prompt-channel');

/**
 * Read a live process's command line the way any local user could: /proc on Linux, `ps` elsewhere.
 * Returns null when the process is already gone or the platform exposes neither.
 */
function readProcessCommandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').join(' ');
  } catch {
    // Not Linux (or the process exited); fall through to ps.
  }
  try {
    return require('child_process')
      .execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
      .trim();
  } catch {
    return null;
  }
}

function runStoreScript(script) {
  return runNodeModule(script, { ZEROSHOT_HOME: zeroshotHome });
}

async function storeAddTask(task) {
  await runStoreScript(`
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    addTask(${JSON.stringify(task)});
  `);
}

async function storeGetTask(id) {
  const stdout = await runStoreScript(`
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    process.stdout.write(JSON.stringify(getTask(${JSON.stringify(id)})));
  `);
  return JSON.parse(stdout);
}

async function storeRequestCancellation(id) {
  await runStoreScript(`
    const { requestTaskCancellation } = await import(${JSON.stringify(storeUrl)});
    requestTaskCancellation(${JSON.stringify(id)});
  `);
}

async function writeProvisionalOwnershipFor(id, { partitionId, storageRoot, cwd, owner }) {
  const stdout = await runStoreScript(`
    const { updateTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const record = writeProvisionalOwnership({
      partitionId: ${JSON.stringify(partitionId)},
      storageRoot: ${JSON.stringify(storageRoot)},
      canonicalWorkspace: ${JSON.stringify(cwd)},
      owner: ${JSON.stringify(owner)},
    });
    updateTask(${JSON.stringify(id)}, { ompSessionOwnership: record });
    process.stdout.write(JSON.stringify(record));
  `);
  return JSON.parse(stdout);
}

/** Advance a seeded provisional row straight to committed, standing in for a prior successful
 * turn's terminal boundary so a resume has a real committed lineage to transfer from. */
async function commitOwnershipFor(id, evidence) {
  const stdout = await runStoreScript(`
    const { commitOwnership } = await import(${JSON.stringify(ownershipUrl)});
    process.stdout.write(JSON.stringify(commitOwnership({
      taskId: ${JSON.stringify(id)},
      selectedProvider: 'anthropic',
      selectedModel: '@default',
      ...${JSON.stringify(evidence)},
    })));
  `);
  return JSON.parse(stdout);
}

/** Release a row's ownership out of band, modelling another process having already claimed or
 * cleared the lineage before this watcher reaches its transfer point. */
async function clearOwnershipFor(id) {
  await runStoreScript(`
    const { updateTask } = await import(${JSON.stringify(storeUrl)});
    updateTask(${JSON.stringify(id)}, { ompSessionOwnership: null });
  `);
}

// Simulates the parent agent process's post-hook success boundary (agent-lifecycle.js), which is
// the only caller ever allowed to advance a cluster-agent owner from 'provisional' to 'committed'.
async function commitRecordedOwnershipFor(id) {
  const stdout = await runStoreScript(`
    const { commitRecordedOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    const committed = commitRecordedOwnership(${JSON.stringify(id)});
    process.stdout.write(JSON.stringify({ committed, task: getTask(${JSON.stringify(id)}) }));
  `);
  return JSON.parse(stdout);
}

let idCounter = 0;
function nextTaskId(label) {
  idCounter += 1;
  return `omp-rpc-watcher-${label}-${idCounter}`;
}

function buildCommandSpec(overlay, overrides = {}) {
  return {
    binary: process.execPath,
    args: [FAKE_OMP_RPC_PATH],
    env: {},
    cwd: process.cwd(),
    cleanup: [overlay.dir],
    cleanupMetadata: [
      { kind: 'temp-directory', provider: 'omp', path: overlay.dir, reason: 'isolated-config' },
    ],
    ...overrides,
  };
}

/**
 * Fork the real watcher exactly the way task-lib/runner.js#spawnWatcher does: the prompt travels
 * over the private stdin pipe, and argv carries only the id/cwd/logFile/args/config quintuple.
 *
 * `promptFrame` overrides the framed bytes written to that pipe (used to prove the fail-closed
 * paths); `sendPrompt: false` attaches no pipe at all, i.e. an absent channel.
 */
function runWatcher({
  id,
  commandSpec,
  scenario,
  prompt = SENTINEL_PROMPT,
  env = {},
  promptFrame = null,
  sendPrompt = true,
  ompSession = null,
  ompResumeExpectation = null,
}) {
  const logFile = path.join(zeroshotHome, `${id}.log`);
  fs.writeFileSync(logFile, '');
  const argv = [
    id,
    commandSpec.cwd,
    logFile,
    '[]',
    JSON.stringify({
      commandSpec,
      ...(ompSession ? { ompSession } : {}),
      ...(ompResumeExpectation ? { ompResumeExpectation } : {}),
    }),
  ];
  return new Promise((resolve, reject) => {
    const child = fork(RPC_WATCHER_PATH, argv, {
      env: {
        ...process.env,
        ZEROSHOT_HOME: zeroshotHome,
        OMP_FAKE_RPC_SCENARIO: scenario,
        ...env,
      },
      stdio: sendPrompt ? ['pipe', 'ignore', 'ignore', 'ipc'] : 'ignore',
    });

    // Sampled synchronously here because uv_spawn has already fork+exec'd by the time fork()
    // returns, so /proc/<pid>/cmdline is populated and the watcher cannot yet have exited.
    const cmdline = readProcessCommandLine(child.pid);

    if (sendPrompt) {
      if (promptFrame === null) sendWatcherPrompt(child.stdin, prompt);
      else {
        child.stdin.on('error', () => {});
        child.stdin.end(promptFrame);
      }
    }

    child.on('exit', (code) => resolve({ code, logFile, argv, cmdline }));
    child.on('error', reject);
  });
}

const { createOmpConfigOverlay } = require('../../src/omp-config-overlay');

async function seedTask(id, commandSpec, overrides = {}) {
  await storeAddTask({
    id,
    status: 'running',
    provider: 'omp',
    cwd: commandSpec.cwd,
    logFile: path.join(zeroshotHome, `${id}.log`),
    commandCleanup: {
      cleanup: commandSpec.cleanup,
      cleanupMetadata: commandSpec.cleanupMetadata,
    },
    ...overrides,
  });
}

module.exports = {
  FAKE_OMP_RPC_PATH,
  RPC_WATCHER_PATH,
  SENTINEL_CONTROL,
  SENTINEL_MESSAGE,
  SENTINEL_PROMPT,
  SENTINEL_SYSTEM,
  assert,
  buildCommandSpec,
  clearOwnershipFor,
  commitOwnershipFor,
  commitRecordedOwnershipFor,
  createOmpConfigOverlay,
  encodeWatcherPromptFrame,
  execFileAsync,
  fs,
  nextTaskId,
  os,
  path,
  readProcessCommandLine,
  runWatcher,
  seedTask,
  storeAddTask,
  storeGetTask,
  storeRequestCancellation,
  writeProvisionalOwnershipFor,
  zeroshotHome,
};
