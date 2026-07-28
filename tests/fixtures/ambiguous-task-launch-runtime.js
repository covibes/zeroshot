const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mode = process.argv[2] || process.env.AMBIGUOUS_TASK_MODE;
const repoRoot = path.resolve(__dirname, '../..');
const taskId = process.env.AMBIGUOUS_TASK_ID || `ambiguous-${mode}`;
const settingsEnv = 'ZEROSHOT_CLAUDE_SETTINGS_FILE';
const ownershipTokenEnv = 'ZEROSHOT_TASK_SPAWN_OWNERSHIP_TOKEN';
const scenario = process.env.AMBIGUOUS_TASK_SCENARIO || 'persisted';
const settingsMarker = process.env.AMBIGUOUS_SETTINGS_MARKER;

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runAmbiguousWrapper() {
  const { addTask } = await import(moduleUrl('task-lib/store.js'));
  const settingsPath = process.env[settingsEnv];
  if (settingsMarker) {
    fs.writeFileSync(settingsMarker, settingsPath, 'utf8');
  }
  if (scenario === 'pre-persistence-contract-failure') {
    const { buildProviderCommand } = await import(moduleUrl('task-lib/provider-helper-runtime.js'));
    buildProviderCommand('claude', 'unsupported settings test', {
      claudeSettingsFile: settingsPath,
      cliFeatures: { supportsSettings: false },
    });
  }
  const cleanupPath = path.dirname(settingsPath);
  const provider = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  provider.unref();
  addTask({
    id: taskId,
    prompt: mode,
    fullPrompt: mode,
    cwd: repoRoot,
    status: 'running',
    pid: provider.pid,
    processGroupId: process.platform === 'win32' ? null : provider.pid,
    terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
    provider: 'claude',
    spawnOwnershipToken: process.env[ownershipTokenEnv] || null,
    commandCleanup: {
      cleanup: [cleanupPath],
      cleanupMetadata: [
        {
          kind: 'temp-directory',
          provider: 'claude',
          path: cleanupPath,
          reason: 'settings-overlay',
        },
      ],
    },
  });
  process.stdout.write('wrapper exited after persisting the task\n');
  process.exitCode = 1;
}

function createAgent() {
  return {
    id: 'ambiguous-agent',
    role: 'implementation',
    config: {
      cwd: repoRoot,
      outputFormat: 'stream-json',
      strictSchema: false,
    },
    isolation: { enabled: false },
    worktree: { enabled: false, path: null },
    quiet: true,
    enableLivenessCheck: false,
    _resolveProvider() {
      return 'claude';
    },
    _resolveModelSpec() {
      return { model: null, reasoningEffort: null };
    },
    _log() {},
    _publishLifecycle() {},
  };
}

async function rejectThroughLauncher() {
  process.env.AMBIGUOUS_TASK_WRAPPER = '1';
  process.env.AMBIGUOUS_TASK_ID = taskId;
  process.env.AMBIGUOUS_TASK_SCENARIO = scenario;
  process.env.AMBIGUOUS_TASK_MODE = mode;
  if (mode === 'runner') {
    const ClaudeTaskRunner = require('../../src/claude-task-runner');
    const runner = new ClaudeTaskRunner({ quiet: true });
    const spawnAndGetTaskId = runner._spawnAndGetTaskId.bind(runner);
    runner._spawnAndGetTaskId = (_command, _args, cwd, spawnEnv, agentId) =>
      spawnAndGetTaskId(process.execPath, [__filename], cwd, spawnEnv, agentId);
    await runner.run('ambiguous wrapper test', {
      provider: 'claude',
      cwd: repoRoot,
    });
    return;
  }

  if (mode === 'agent') {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-ambiguous-bin-'));
    const fakeZeroshot = path.join(fakeBin, 'zeroshot');
    fs.writeFileSync(
      fakeZeroshot,
      `#!/usr/bin/env node\nrequire(${JSON.stringify(__filename)});\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ''}`;
    const { spawnClaudeTask } = require('../../src/agent/agent-task-executor');
    await spawnClaudeTask(createAgent(), 'ambiguous wrapper test');
    return;
  }

  throw new Error(`Unknown ambiguous launcher mode: ${mode}`);
}

async function runScenario() {
  const { getTask } = await import(moduleUrl('task-lib/store.js'));
  const { killTaskCommand } = await import(moduleUrl('task-lib/commands/kill.js'));
  let rejection;
  try {
    await rejectThroughLauncher();
  } catch (error) {
    rejection = error;
  }
  const settingsPath = fs.existsSync(settingsMarker)
    ? fs.readFileSync(settingsMarker, 'utf8')
    : null;
  const pending = getTask(taskId);
  if (scenario === 'persisted' && !pending) {
    throw new Error(`Ambiguous wrapper did not persist ${taskId}`);
  }
  const cleanupPath = pending?.commandCleanup?.cleanup?.[0] || path.dirname(settingsPath);
  const overlayExistsAfterReject = fs.existsSync(cleanupPath);
  const providerAliveAfterReject = pending?.pid ? isRunning(pending.pid) : false;

  let terminal = null;
  if (pending) {
    await killTaskCommand(taskId, {
      graceMs: 40,
      hardKillWaitMs: 500,
      pollMs: 5,
    });
    terminal = getTask(taskId);
  }
  process.stdout.write(
    `RESULT:${JSON.stringify({
      rejection: {
        message: rejection?.message,
        commandCleanupOwner: rejection?.commandCleanupOwner,
      },
      pending,
      terminal,
      overlayExistsAfterReject,
      providerAliveAfterReject,
      overlayExistsAfterKill: fs.existsSync(cleanupPath),
      providerAliveAfterKill: pending?.pid ? isRunning(pending.pid) : false,
    })}\n`
  );
}

if (process.env.AMBIGUOUS_TASK_WRAPPER === '1') {
  runAmbiguousWrapper().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
} else {
  runScenario().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
