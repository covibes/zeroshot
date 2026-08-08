const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const {
  executeTask,
  startLivenessCheck,
  stopLivenessCheck,
} = require('../../src/agent/agent-lifecycle');
const { followClaudeTaskLogsIsolated, killTask } = require('../../src/agent/agent-task-executor');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('Timed out waiting for condition');
}

function createFakeProcess() {
  return {
    pid: 9012,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
    on() {},
  };
}

function createIsolationManager({
  status = 'running',
  killCommandFailures = 0,
  unverifiableKillAttempts = 0,
  terminalStatusOnKill = null,
} = {}) {
  const providerOutput = '{"summary":"done","result":"ok"}\n';
  const commands = [];
  let taskStatus = status;
  let remainingKillCommandFailures = killCommandFailures;
  let remainingUnverifiableKillAttempts = unverifiableKillAttempts;
  let activeKillCalls = 0;
  let pendingStatusFailures = 0;
  return {
    commands,
    killCalls: 0,
    maxConcurrentKillCalls: 0,
    setStatus(nextStatus) {
      taskStatus = nextStatus;
    },
    allowTermination() {
      remainingKillCommandFailures = 0;
      remainingUnverifiableKillAttempts = 0;
      pendingStatusFailures = 0;
    },
    spawnInContainer() {
      return createFakeProcess();
    },
    async execInContainer(_clusterId, command) {
      commands.push(command);
      const commandText = command.join(' ');
      if (commandText.includes('get-log-path')) {
        return { code: 0, stdout: '/tmp/provider.log\n', stderr: '' };
      }
      if (commandText.includes('kill')) {
        this.killCalls += 1;
        activeKillCalls += 1;
        this.maxConcurrentKillCalls = Math.max(this.maxConcurrentKillCalls, activeKillCalls);
        try {
          await sleep(10);
          if (remainingKillCommandFailures > 0) {
            remainingKillCommandFailures -= 1;
            return { code: 1, stdout: '', stderr: 'kill command failed' };
          }
          if (remainingUnverifiableKillAttempts > 0) {
            remainingUnverifiableKillAttempts -= 1;
            pendingStatusFailures += 1;
            return { code: 0, stdout: 'kill requested\n', stderr: '' };
          }
          if (terminalStatusOnKill) {
            taskStatus = terminalStatusOnKill;
            return {
              code: 0,
              stdout: `Task is not running (status: ${terminalStatusOnKill})\n`,
              stderr: '',
            };
          }
          taskStatus = 'killed';
          return { code: 0, stdout: 'killed\n', stderr: '' };
        } finally {
          activeKillCalls -= 1;
        }
      }
      if (commandText.includes('status')) {
        if (pendingStatusFailures > 0) {
          pendingStatusFailures -= 1;
          return { code: 1, stdout: '', stderr: 'status verification failed' };
        }
        return {
          code: 0,
          stdout: `Status: ${taskStatus}\n`,
          stderr: '',
        };
      }
      if (commandText.includes('wc -c')) {
        return { code: 0, stdout: `${Buffer.byteLength(providerOutput)}\n`, stderr: '' };
      }
      if (commandText.includes('tail -c')) {
        return { code: 0, stdout: providerOutput, stderr: '' };
      }
      throw new Error(`Unexpected isolated command: ${command.join(' ')}`);
    },
  };
}

function createIsolatedAgent(manager, overrides = {}) {
  const events = [];
  const agent = {
    id: 'isolated-worker',
    role: 'implementation',
    isolation: {
      enabled: true,
      manager,
      clusterId: 'isolated-cluster',
    },
    cluster: { id: 'cluster' },
    config: { cwd: '/tmp/work' },
    worktree: null,
    iteration: 1,
    timeout: 0,
    staleDuration: 20,
    enableLivenessCheck: true,
    currentTask: null,
    currentTaskId: 'isolated-task',
    processPid: 9012,
    lastOutputTime: Date.now(),
    taskStartedAt: Date.now(),
    livenessCheckInterval: null,
    livenessTerminationStarted: false,
    consecutiveStaleWarnings: 0,
    messageBus: { publish() {} },
    _resolveProvider: () => 'codex',
    _parseResultOutput: () => Promise.resolve({ summary: 'done', result: 'ok' }),
    _log() {},
    _publishLifecycle(event, data) {
      events.push({ event, data });
    },
    _stopLivenessCheck() {
      stopLivenessCheck(this);
    },
    _killTask(termination) {
      return killTask(this, termination);
    },
    ...overrides,
  };
  return { agent, events };
}

async function runWatchdogRecovery(overrides, managerOptions = {}) {
  const manager = createIsolationManager(managerOptions);
  const { agent, events } = createIsolatedAgent(manager, overrides);
  const execution = followClaudeTaskLogsIsolated(agent, agent.currentTaskId);

  await waitFor(() => agent.currentTask);
  startLivenessCheck(agent);
  const result = await execution;
  await sleep(80);
  stopLivenessCheck(agent);

  return { agent, events, manager, result };
}

async function runPermanentWatchdogFailure(managerOptions) {
  const manager = createIsolationManager(managerOptions);
  const { agent, events } = createIsolatedAgent(manager, {
    lastOutputTime: Date.now() - 100,
    taskStartedAt: Date.now() - 100,
  });
  const execution = followClaudeTaskLogsIsolated(agent, agent.currentTaskId);

  await waitFor(() => agent.currentTask);
  startLivenessCheck(agent);
  const outcome = await Promise.race([
    execution.then(
      (result) => ({ result }),
      (error) => ({ error })
    ),
    sleep(300).then(() => ({ timedOut: true })),
  ]);
  const observed = {
    agent,
    events,
    manager,
    outcome,
    killCalls: manager.killCalls,
    stillMonitored: Boolean(agent.livenessCheckInterval),
  };

  if (outcome.timedOut) {
    stopLivenessCheck(agent);
    manager.allowTermination();
    await agent.currentTask?.terminate('test cleanup');
    await execution;
  }

  return observed;
}

async function runLifecycleRecovery(managerOptions = {}) {
  const manager = createIsolationManager(managerOptions);
  const { agent, events } = createIsolatedAgent(manager, {
    config: { cwd: '/tmp/work', hooks: {}, maxRetries: 3 },
    currentTaskId: null,
    iteration: 0,
    maxIterations: 10,
    running: true,
    state: 'idle',
    testMode: true,
    quiet: true,
    messageBus: { publish() {}, query: () => [] },
    _buildContext: () => 'task context',
    _selectModel: () => 'test-model',
    _resolveModelSpec: () => null,
  });
  const published = [];
  let spawnCalls = 0;
  agent._publish = (message) => published.push(message);
  agent._spawnClaudeTask = async function () {
    spawnCalls += 1;
    this.currentTaskId = `isolated-task-${spawnCalls}`;
    this.lastOutputTime = Date.now() - 100;
    this.taskStartedAt = Date.now() - 100;
    const execution = followClaudeTaskLogsIsolated(this, this.currentTaskId);
    await waitFor(() => this.currentTask);
    startLivenessCheck(this);
    return execution;
  };

  await executeTask(agent, { topic: 'ISSUE_OPENED', sender: 'system' });
  return { agent, events, manager, published, spawnCalls };
}

function useZeroBackoffSettings() {
  let originalSettingsFile;
  let settingsDir;

  beforeEach(function () {
    originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-isolated-recovery-'));
    process.env.ZEROSHOT_SETTINGS_FILE = path.join(settingsDir, 'settings.json');
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({ backoffBaseMs: 0, backoffMaxMs: 0, jitterFactor: 0 })
    );
  });

  afterEach(function () {
    if (originalSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFile;
    }
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });
}

module.exports = {
  createIsolatedAgent,
  createIsolationManager,
  runLifecycleRecovery,
  runPermanentWatchdogFailure,
  runWatchdogRecovery,
  sleep,
  useZeroBackoffSettings,
  waitFor,
};
