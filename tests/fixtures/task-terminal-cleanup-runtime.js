const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mode = process.argv[2];
const repoRoot = path.resolve(__dirname, '../..');

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

function taskRecord(id, status, commandCleanup, ownership = {}) {
  return {
    id,
    prompt: mode,
    fullPrompt: mode,
    cwd: repoRoot,
    status,
    pid: ownership.pid ?? null,
    processGroupId: ownership.processGroupId ?? null,
    terminationStrategy: ownership.terminationStrategy ?? null,
    commandCleanup,
  };
}

function cleanupReceipt(cleanupPath) {
  return {
    cleanup: [cleanupPath],
    cleanupMetadata: [
      {
        kind: 'temp-directory',
        provider: 'claude',
        path: cleanupPath,
        reason: 'settings-overlay',
      },
    ],
  };
}

function fileCleanupReceipt(cleanupPath) {
  return {
    cleanup: [cleanupPath],
    cleanupMetadata: [
      {
        kind: 'temp-file',
        provider: 'codex',
        path: cleanupPath,
        reason: 'output-schema',
      },
    ],
  };
}

async function runRetryScenario(store, killTaskCommand, completeWatcherTask) {
  const cleanupPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zeroshot-claude-settings-run-terminal-retry-')
  );
  const taskId = 'terminal-cleanup-retry';
  store.addTask(taskRecord(taskId, 'running', cleanupReceipt(cleanupPath), { pid: 424242 }));
  let cleanupRuns = 0;

  await completeWatcherTask({
    taskId,
    completion: { status: 'completed', resolvedCode: 0, error: null },
    commandCleanup: {
      run() {
        cleanupRuns += 1;
        return Promise.resolve(false);
      },
    },
    terminateProvider: () => Promise.resolve(true),
    updateTask: store.updateTask,
    emergencyLog() {},
  });

  const terminal = store.getTask(taskId);
  const cleanupExistsBeforeRetry = fs.existsSync(cleanupPath);
  await killTaskCommand(taskId, { graceMs: 40, pollMs: 5 });
  return {
    terminal,
    recovered: store.getTask(taskId),
    cleanupRuns,
    cleanupExistsBeforeRetry,
    cleanupExistsAfterRetry: fs.existsSync(cleanupPath),
  };
}

async function runUnsafeScenario(store, killTaskCommand) {
  const userDirectory = path.join(process.env.ZEROSHOT_HOME, 'user-owned');
  fs.mkdirSync(userDirectory);
  const taskId = 'terminal-cleanup-unsafe';
  store.addTask(
    taskRecord(taskId, 'completed', cleanupReceipt(userDirectory), {
      pid: process.pid,
      processGroupId: process.pid,
      terminationStrategy: 'process',
    })
  );

  await killTaskCommand(taskId, { graceMs: 40, pollMs: 5 });
  let unrelatedAlive = true;
  try {
    process.kill(process.pid, 0);
  } catch {
    unrelatedAlive = false;
  }
  return {
    terminal: store.getTask(taskId),
    unrelatedAlive,
    userDirectoryExists: fs.existsSync(userDirectory),
  };
}

async function runUnsafeFileScenario(store, killTaskCommand) {
  const userFile = path.join(process.env.ZEROSHOT_HOME, 'user-schema.json');
  fs.writeFileSync(userFile, '{}\n');
  const taskId = 'terminal-cleanup-unsafe-file';
  store.addTask(
    taskRecord(taskId, 'completed', fileCleanupReceipt(userFile), {
      pid: process.pid,
      processGroupId: process.pid,
      terminationStrategy: 'process',
    })
  );

  await killTaskCommand(taskId, { graceMs: 40, pollMs: 5 });
  let unrelatedAlive = true;
  try {
    process.kill(process.pid, 0);
  } catch {
    unrelatedAlive = false;
  }
  return {
    terminal: store.getTask(taskId),
    unrelatedAlive,
    userFileExists: fs.existsSync(userFile),
  };
}

function runCleanScenario(store, cleanTasks, cleanMode, unsafe = false, statusOverride = null) {
  const cleanupPath = unsafe
    ? path.join(process.env.ZEROSHOT_HOME, 'user-cleanup')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-claude-settings-run-clean-'));
  if (unsafe) fs.mkdirSync(cleanupPath);
  const status = statusOverride || (cleanMode === 'completed' ? 'completed' : 'failed');
  const taskId = [
    `clean-${cleanMode}`,
    unsafe ? 'unsafe' : null,
    statusOverride,
  ]
    .filter(Boolean)
    .join('-');
  store.addTask(taskRecord(taskId, status, cleanupReceipt(cleanupPath)));
  cleanTasks({ [cleanMode]: true });
  return {
    retained: store.getTask(taskId) || null,
    cleanupExists: fs.existsSync(cleanupPath),
    exitCode: process.exitCode || 0,
  };
}

async function main() {
  const store = await import(moduleUrl('task-lib/store.js'));
  const { killTaskCommand } = await import(moduleUrl('task-lib/commands/kill.js'));
  const { completeWatcherTask } = await import(moduleUrl('task-lib/watcher-output-runtime.js'));
  const { cleanTasks } = await import(moduleUrl('task-lib/commands/clean.js'));
  let result;
  if (mode === 'retry') {
    result = await runRetryScenario(store, killTaskCommand, completeWatcherTask);
  } else if (mode === 'unsafe') {
    result = await runUnsafeScenario(store, killTaskCommand);
  } else if (mode === 'unsafe-file') {
    result = await runUnsafeFileScenario(store, killTaskCommand);
  } else if (mode === 'clean-completed') {
    result = runCleanScenario(store, cleanTasks, 'completed');
  } else if (mode === 'clean-failed') {
    result = runCleanScenario(store, cleanTasks, 'failed');
  } else if (mode === 'clean-all') {
    result = runCleanScenario(store, cleanTasks, 'all');
  } else if (mode === 'clean-unsafe') {
    result = runCleanScenario(store, cleanTasks, 'all', true);
  } else if (mode === 'clean-running') {
    result = runCleanScenario(store, cleanTasks, 'all', false, 'running');
  } else {
    throw new Error(`Unknown terminal cleanup fixture mode: ${mode}`);
  }
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
