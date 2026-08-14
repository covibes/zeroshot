const { spawn } = require('child_process');
const { existsSync, mkdirSync, readFileSync } = require('fs');
const { dirname, resolve } = require('path');
const { pathToFileURL } = require('url');
const { decodeTaskLogLine } = require('../../src/task-log-line');
const {
  forceKill,
  forceKillOwnedGroup,
  isRunning,
  spawnCapturedWatcher,
  waitFor: waitForRuntime,
} = require('./watcher-runtime-helpers');

const watcherName = process.argv[2];
const repoRoot = resolve(__dirname, '../..');
const watcherPath = resolve(repoRoot, 'task-lib', watcherName);
const providerPath = resolve(__dirname, 'sigterm-root-with-child.js');
const logFile = resolve(process.env.HOME, '.zeroshot', `${watcherName}.log`);
const taskId = watcherName === 'attachable-watcher.js' ? 'runtime-a' : 'runtime-w';

function waitFor(predicate) {
  return waitForRuntime(predicate, `Timed out waiting for ${watcherName} runtime state`);
}

async function main() {
  const storeUrl = pathToFileURL(resolve(repoRoot, 'task-lib/store.js')).href;
  const killUrl = pathToFileURL(resolve(repoRoot, 'task-lib/commands/kill.js')).href;
  const { addTask, getTask } = await import(storeUrl);
  const { killTaskCommand } = await import(killUrl);
  const {
    cleanupClaudeSettingsOverlay,
    prepareClaudeSettingsOverlay,
  } = require('../../src/worktree-claude-config');
  const settingsPath = prepareClaudeSettingsOverlay();
  const cleanupDir = dirname(settingsPath);
  const cleanupMetadata = [
    {
      kind: 'temp-directory',
      provider: 'claude',
      path: cleanupDir,
      reason: 'settings-overlay',
    },
  ];

  mkdirSync(dirname(logFile), { recursive: true });
  addTask({
    id: taskId,
    prompt: 'runtime ownership proof',
    fullPrompt: 'runtime ownership proof',
    cwd: repoRoot,
    status: 'running',
    pid: null,
    logFile,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider: 'claude',
    attachable: watcherName === 'attachable-watcher.js',
    commandCleanup: { cleanup: [cleanupDir], cleanupMetadata },
  });

  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const config = {
    provider: 'claude',
    outputFormat: 'stream-json',
    commandSpec: {
      binary: process.execPath,
      args: [providerPath],
      env: {},
      cleanup: [cleanupDir],
      cleanupMetadata,
    },
  };
  const captured = spawnCapturedWatcher(
    watcherPath,
    [taskId, repoRoot, logFile, '[]', JSON.stringify(config)],
    { env: process.env }
  );
  const watcher = captured.child;

  let providerPid;
  let descendantPid;
  try {
    const persisted = await waitFor(() => {
      const task = getTask(taskId);
      if (watcher.exitCode !== null && !task?.pid) {
        const logOutput = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
        throw new Error(
          `${watcherName} exited ${watcher.exitCode} before persisting ownership: ${captured.output()}${logOutput}`
        );
      }
      return task?.pid && task.processGroupId && task.terminationStrategy ? task : null;
    });
    providerPid = persisted.pid;
    assertOwnedMetadata(persisted);
    descendantPid = await waitFor(() => readDescendantPid(logFile));

    await killTaskCommand(taskId, {
      graceMs: 100,
      hardKillWaitMs: 500,
      pollMs: 10,
    });
    await waitFor(() => !isRunning(providerPid) && !isRunning(descendantPid));

    const terminal = getTask(taskId);
    const result = {
      watcherName,
      providerPid,
      descendantPid,
      unrelatedAlive: isRunning(unrelated.pid),
      providerAlive: isRunning(providerPid),
      descendantAlive: isRunning(descendantPid),
      persistedStrategy: persisted.terminationStrategy,
      persistedGroupId: persisted.processGroupId,
      terminalGroupId: terminal.processGroupId,
      cleanupRemoved: !existsSync(cleanupDir),
    };
    process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
  } finally {
    forceKill(watcher.pid);
    forceKillOwnedGroup(providerPid);
    forceKill(descendantPid);
    forceKill(unrelated.pid);
    cleanupClaudeSettingsOverlay(settingsPath);
  }
}

function assertOwnedMetadata(task) {
  if (process.platform === 'win32') {
    if (task.processGroupId !== null || task.terminationStrategy !== 'process-tree') {
      throw new Error(`Invalid Windows ownership metadata: ${JSON.stringify(task)}`);
    }
    return;
  }
  if (task.processGroupId !== task.pid || task.terminationStrategy !== 'process-group') {
    throw new Error(`Invalid POSIX ownership metadata: ${JSON.stringify(task)}`);
  }
}

function readDescendantPid(path) {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const decoded = decodeTaskLogLine(line);
    const content = decoded.content.trim();
    if (decoded.providerOutput && /^\d+$/.test(content)) return Number(content);
  }
  return null;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
