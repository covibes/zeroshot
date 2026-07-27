const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  forceKill,
  forceKillOwnedGroup,
  isRunning,
  spawnCapturedWatcher,
  waitFor,
} = require('./watcher-runtime-helpers');

const watcherName = process.argv[2];
const mode = process.argv[3];
const repoRoot = path.resolve(__dirname, '../..');
const watcherPath = path.join(repoRoot, 'task-lib', watcherName);
const taskId = `cleanup-${watcherName}-${mode}`.replaceAll('.', '-');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-watcher-cleanup-'));
const logFile = path.join(stateDir, 'task.log');
const providerPidFile = path.join(stateDir, 'provider.pid');

async function main() {
  const storeUrl = pathToFileURL(path.join(repoRoot, 'task-lib/store.js')).href;
  const { addTask, getTask } = await import(storeUrl);
  const {
    cleanupClaudeSettingsOverlay,
    prepareClaudeSettingsOverlay,
  } = require('../../src/worktree-claude-config');

  const settingsPath = prepareClaudeSettingsOverlay();
  const ownedOverlayDir = path.dirname(settingsPath);
  let cleanupDir = ownedOverlayDir;
  let cleanupMetadata = [
    {
      kind: 'temp-directory',
      provider: 'claude',
      path: cleanupDir,
      reason: 'settings-overlay',
    },
  ];

  if (mode === 'unowned') {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-unowned-cleanup-'));
    cleanupMetadata = [
      {
        kind: 'temp-directory',
        provider: 'claude',
        path: cleanupDir,
        reason: 'settings-overlay',
      },
    ];
  }

  addTask({
    id: taskId,
    prompt: mode,
    fullPrompt: mode,
    cwd: repoRoot,
    status: 'running',
    pid: null,
    logFile,
    provider: 'claude',
    commandCleanup: { cleanup: [cleanupDir], cleanupMetadata },
  });

  const providerExitCode = mode === 'exit7' ? 7 : 0;
  const providerSource =
    mode === 'crash'
      ? `
        const fs = require('fs');
        fs.writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
        fs.rmSync(${JSON.stringify(logFile)}, { force: true });
        fs.mkdirSync(${JSON.stringify(logFile)}, { recursive: true });
        process.stdout.write('trigger watcher log failure\\n');
        setInterval(() => {}, 1000);
      `
      : `process.stdout.write('provider output\\n'); process.exit(${providerExitCode});`;
  const commandSpec = {
    binary: process.execPath,
    args: ['-e', providerSource],
    env: {},
    cleanup: [cleanupDir],
    cleanupMetadata,
  };
  const config = {
    provider: 'claude',
    outputFormat: 'stream-json',
    commandSpec,
  };
  const captured = spawnCapturedWatcher(watcherPath, [
    taskId,
    repoRoot,
    logFile,
    '[]',
    JSON.stringify(config),
  ]);
  const watcher = captured.child;

  let providerPid = null;
  try {
    if (mode === 'crash') {
      providerPid = await waitFor(
        () =>
          fs.existsSync(providerPidFile) ? Number(fs.readFileSync(providerPidFile, 'utf8')) : null,
        `Timed out waiting for ${watcherName} ${mode} provider`
      );
    }
    const watcherExit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watcher did not exit')), 20000);
      watcher.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
      watcher.once('error', reject);
    });
    await waitFor(() => {
      const task = getTask(taskId);
      return task && task.status !== 'running' ? task : null;
    }, `Timed out waiting for ${watcherName} ${mode} terminal task`);
    const task = getTask(taskId);
    const logOutput =
      fs.existsSync(logFile) && fs.statSync(logFile).isFile()
        ? fs.readFileSync(logFile, 'utf8')
        : '';
    process.stdout.write(
      `RESULT:${JSON.stringify({
        watcherExit,
        watcherOutput: captured.output(),
        providerPid,
        providerAlive: isRunning(providerPid),
        cleanupExists: fs.existsSync(cleanupDir),
        ownedOverlayExists: fs.existsSync(ownedOverlayDir),
        status: task.status,
        exitCode: task.exitCode,
        commandCleanup: task.commandCleanup,
        logOutput,
      })}\n`
    );
  } finally {
    forceKillOwnedGroup(providerPid);
    forceKill(watcher.pid);
    cleanupClaudeSettingsOverlay(settingsPath);
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
