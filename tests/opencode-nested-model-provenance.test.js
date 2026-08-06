const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const AgentWrapper = require('../src/agent-wrapper');
const ClaudeTaskRunner = require('../src/claude-task-runner');
const { spawnClaudeTaskIsolated } = require('../src/agent/agent-task-executor');
const { appendTaskRunModelArgs } = require('../src/task-run-model-args');
const { reformatOutput } = require('../src/agent/output-reformatter');

const EXTERNAL_MODEL = 'kimi/kimi-k2-5';
const OWNERSHIP_ENV = 'ZEROSHOT_TASK_SPAWN_OWNERSHIP_TOKEN';
const CATALOG_MODEL = 'openai/gpt-5.2-codex';
let settingsDir;
let settingsFile;
let previousSettingsFile;

function assertConfiguredModelArgs(args) {
  assert.deepStrictEqual(
    args.slice(args.indexOf('--model-level'), args.indexOf('--model-level') + 2),
    ['--model-level', 'level2']
  );
  assert.strictEqual(args.includes('--configured-model'), false);
  assert.strictEqual(args.includes('--model'), false);
}

function createClosingProcess(code = 1, stdout = '') {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 12345;
  proc.kill = () => {};
  setImmediate(() => {
    if (stdout) proc.stdout.write(stdout);
    proc.emit('close', code, null);
  });
  return proc;
}

function opencodeTextEvent(value) {
  return `${JSON.stringify({
    type: 'text',
    part: { type: 'text', text: JSON.stringify(value) },
  })}\n`;
}

before(function () {
  settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opencode-model-boundary-'));
  settingsFile = path.join(settingsDir, 'settings.json');
  previousSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      defaultProvider: 'opencode',
      providerSettings: {
        opencode: {
          defaultLevel: 'level2',
          levelOverrides: {
            level2: { model: EXTERNAL_MODEL, reasoningEffort: 'high' },
          },
        },
      },
    })
  );
  process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
});

after(function () {
  if (previousSettingsFile === undefined) {
    delete process.env.ZEROSHOT_SETTINGS_FILE;
  } else {
    process.env.ZEROSHOT_SETTINGS_FILE = previousSettingsFile;
  }
  fs.rmSync(settingsDir, { recursive: true, force: true });
});

describe('Nested task model argument encoding', function () {
  it('keeps provider-level models off the direct model channel', function () {
    const args = [];
    appendTaskRunModelArgs(
      args,
      { level: 'level2', model: EXTERNAL_MODEL, reasoningEffort: 'high' },
      'provider-level'
    );
    assertConfiguredModelArgs(args);
  });

  it('selects the unique formatter identity explicitly in the OpenCode command', async function () {
    const previousAgent = process.env.ZEROSHOT_OPENCODE_AGENT;
    const formatterAgentName = 'zeroshot-output-reformatter-command-test';
    process.env.ZEROSHOT_OPENCODE_AGENT = formatterAgentName;
    try {
      const { prepareTaskProviderCommand } = await import('../task-lib/runner.js');
      const prepared = prepareTaskProviderCommand('format this', {
        provider: 'opencode',
        outputFormat: 'json',
      });
      const agentIndex = prepared.commandSpec.args.indexOf('--agent');
      assert.deepStrictEqual(prepared.commandSpec.args.slice(agentIndex, agentIndex + 2), [
        '--agent',
        formatterAgentName,
      ]);
    } finally {
      if (previousAgent === undefined) {
        delete process.env.ZEROSHOT_OPENCODE_AGENT;
      } else {
        process.env.ZEROSHOT_OPENCODE_AGENT = previousAgent;
      }
    }
  });

  it('preserves provider-level provenance in actual local agent arguments', async function () {
    let capturedArgs;
    const agent = new AgentWrapper(
      { id: 'configured-local', provider: 'opencode', modelLevel: 'level2', timeout: 0 },
      { publish() {}, subscribe() {} },
      { id: 'test-cluster', agents: [] },
      {
        testMode: true,
        mockSpawnFn(args) {
          capturedArgs = args;
          return { success: true };
        },
      }
    );

    await agent._spawnClaudeTask('test context');
    assertConfiguredModelArgs(capturedArgs);
  });

  it('keeps direct local agent models on the catalog-strict channel', async function () {
    let capturedArgs;
    const agent = new AgentWrapper(
      { id: 'direct-local', provider: 'opencode', model: CATALOG_MODEL, timeout: 0 },
      { publish() {}, subscribe() {} },
      { id: 'test-cluster', agents: [] },
      {
        testMode: true,
        mockSpawnFn(args) {
          capturedArgs = args;
          return { success: true };
        },
      }
    );

    await agent._spawnClaudeTask('test context');
    assert.deepStrictEqual(
      capturedArgs.slice(capturedArgs.indexOf('--model'), capturedArgs.indexOf('--model') + 2),
      ['--model', CATALOG_MODEL]
    );
    assert.strictEqual(capturedArgs.includes('--configured-model'), false);
  });

  it('preserves an explicit model during structured-output recovery', async function () {
    let capturedArgs;
    let capturedOptions;
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' } },
      required: ['plan'],
    };
    const agent = new AgentWrapper(
      {
        id: 'direct-reformat',
        role: 'planner',
        provider: 'opencode',
        model: CATALOG_MODEL,
        jsonSchema: schema,
        timeout: 0,
      },
      { publish() {}, subscribe() {} },
      { id: 'test-cluster', agents: [] },
      {
        testMode: true,
        mockSpawnFn(args, options) {
          capturedArgs = args;
          capturedOptions = options;
          return {
            success: true,
            output: opencodeTextEvent({ plan: 'use the configured model' }),
          };
        },
      }
    );
    agent.running = true;
    agent.state = 'executing_task';

    const result = await agent._parseResultOutput('Tool call completed without final JSON');

    assert.deepStrictEqual(result, { plan: 'use the configured model' });
    assert.deepStrictEqual(
      capturedArgs.slice(capturedArgs.indexOf('--model'), capturedArgs.indexOf('--model') + 2),
      ['--model', CATALOG_MODEL]
    );
    assert.deepStrictEqual(capturedOptions.options, {
      skipStructuredResultCheck: true,
      nested: true,
      structuredOutputRecovery: true,
    });
  });
});

describe('Nested Docker agent model arguments', function () {
  it('preserves provider-level provenance in the spawned command', async function () {
    let capturedCommand;
    let capturedOptions;
    const agent = {
      id: 'configured-docker',
      config: { outputFormat: 'json', strictSchema: true },
      isolation: {
        enabled: true,
        clusterId: 'test-cluster',
        manager: {
          spawnInContainer(_clusterId, command, options) {
            capturedCommand = command;
            capturedOptions = options;
            return createClosingProcess();
          },
          execInContainer() {
            return { code: 2, stdout: '', stderr: '' };
          },
        },
      },
      enableLivenessCheck: false,
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({
        level: 'level2',
        model: EXTERNAL_MODEL,
        reasoningEffort: 'high',
      }),
      _resolveModelSpecSource: () => 'provider-level',
      _log() {},
      _publishLifecycle() {},
    };

    await assert.rejects(spawnClaudeTaskIsolated(agent, 'test context'), /Task launch cancelled/);
    assertConfiguredModelArgs(capturedCommand);
    assert.deepStrictEqual(JSON.parse(capturedCommand[3]), {
      providerSettings: {
        opencode: {
          levelOverrides: {
            level2: { model: EXTERNAL_MODEL },
          },
        },
      },
    });
    assert.strictEqual(typeof capturedOptions.env[OWNERSHIP_ENV], 'string');
  });
});

describe('Isolated opencode structured-output recovery', function () {
  it('runs the recovery task inside the active container with the resolved model', async function () {
    this.timeout(6000);
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' } },
      required: ['plan'],
    };
    const spawnedCommands = [];
    let spawnCount = 0;
    const manager = {
      spawnInContainer(_clusterId, command, _options) {
        spawnedCommands.push(command);
        spawnCount++;
        if (spawnCount === 1) {
          return createClosingProcess(0, '✓ Task spawned: task-amber-fox-a1\n');
        }
        const tail = new EventEmitter();
        tail.stdout = new PassThrough();
        tail.stderr = new PassThrough();
        tail.kill = () => {};
        return tail;
      },
      execInContainer(_clusterId, command) {
        const rendered = command.join(' ');
        if (rendered.includes('get-task-id-by-spawn-token')) {
          return Promise.resolve({
            code: 0,
            stdout: 'task-amber-fox-a1\n',
            stderr: '',
          });
        }
        if (rendered.includes('get-log-path')) {
          return Promise.resolve({ code: 0, stdout: '/tmp/reformat.log\n', stderr: '' });
        }
        if (rendered.includes('zeroshot status')) {
          return Promise.resolve({ code: 0, stdout: 'Status: completed\n', stderr: '' });
        }
        if (rendered.includes('cat "/tmp/reformat.log"')) {
          return Promise.resolve({
            code: 0,
            stdout: opencodeTextEvent({ plan: 'isolated recovery' }),
            stderr: '',
          });
        }
        return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
      },
    };
    const agent = {
      id: 'isolated-reformat',
      role: 'planner',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 0,
      enableLivenessCheck: false,
      config: { jsonSchema: schema, outputFormat: 'json', strictSchema: true },
      cluster: { id: 'test-cluster' },
      isolation: { enabled: true, clusterId: 'test-cluster', manager },
      messageBus: { publish() {} },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
      _resolveModelSpecSource: () => 'direct',
      _parseResultOutput: () => {
        throw new Error('nested structured parsing must be skipped');
      },
      _log() {},
      _publishLifecycle() {},
      _stopLivenessCheck() {},
    };

    const result = await reformatOutput({
      rawOutput: 'Tool call completed without final JSON',
      schema,
      providerName: 'opencode',
      runReformat: (prompt) =>
        spawnClaudeTaskIsolated(agent, prompt, {
          skipStructuredResultCheck: true,
          nested: true,
          structuredOutputRecovery: true,
        }),
    });

    assert.deepStrictEqual(result, {
      status: 'recovered',
      value: { plan: 'isolated recovery' },
      attempts: 1,
    });
    const recoveryCommand = spawnedCommands[0];
    assert.deepStrictEqual(
      recoveryCommand.slice(
        recoveryCommand.indexOf('--model'),
        recoveryCommand.indexOf('--model') + 2
      ),
      ['--model', CATALOG_MODEL]
    );
    assert.ok(recoveryCommand.includes('zeroshot'));
    assert.ok(recoveryCommand.includes('task'));
    assert.ok(recoveryCommand.includes('run'));
    assert.ok(recoveryCommand.includes('--structured-output-recovery'));
    assert.strictEqual(recoveryCommand.includes('--resume'), false);
    assert.strictEqual(recoveryCommand.includes('--mcp-config'), false);
  });

  it('retains an isolated nested launch after unconfirmed wrapper cleanup', async function () {
    this.timeout(1000);
    const taskId = 'task-retained-launch-a1';
    let status = 'running';
    let killAttempts = 0;
    const manager = {
      getContainerEnvironmentValue() {
        return null;
      },
      spawnInContainer() {
        return createClosingProcess(1, 'wrapper failed before receipt\n');
      },
      execInContainer(_clusterId, command) {
        const rendered = command.join(' ');
        if (rendered.includes('get-task-id-by-spawn-token')) {
          return Promise.resolve({ code: 0, stdout: `${taskId}\n`, stderr: '' });
        }
        if (command[1] === 'status') {
          return Promise.resolve({ code: 0, stdout: `Status: ${status}\n`, stderr: '' });
        }
        if (command[1] === 'kill') {
          killAttempts++;
          if (killAttempts <= 2) {
            return Promise.resolve({ code: 1, stdout: '', stderr: 'cleanup unavailable' });
          }
          status = 'killed';
          return Promise.resolve({ code: 0, stdout: `Killed ${taskId}\n`, stderr: '' });
        }
        return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
      },
    };
    const agent = {
      id: 'isolated-retained-launch',
      role: 'planner',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 0,
      enableLivenessCheck: false,
      config: { outputFormat: 'json', strictSchema: true },
      cluster: { id: 'test-cluster' },
      isolation: { enabled: true, clusterId: 'test-cluster', manager },
      messageBus: { publish() {} },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
      _resolveModelSpecSource: () => 'direct',
      _log() {},
      _publishLifecycle() {},
      _stopLivenessCheck() {},
    };

    let rejection;
    try {
      await spawnClaudeTaskIsolated(agent, 'test context', {
        skipStructuredResultCheck: true,
        nested: true,
        structuredOutputRecovery: true,
      });
    } catch (error) {
      rejection = error;
    }

    assert.strictEqual(rejection?.retainTaskHandle, true);
    assert.strictEqual(rejection?.taskId, taskId);
    assert.strictEqual(agent.nestedExecutions.size, 1);
    assert.deepStrictEqual(agent.nestedExecutions.activeTaskIds, [taskId]);
    assert.strictEqual(status, 'running');

    const termination = await agent.nestedExecutions.cancelAll('retry retained isolated cleanup');
    assert.notStrictEqual(termination?.forced, false);
    assert.strictEqual(killAttempts, 3);
    assert.strictEqual(status, 'killed');
    assert.strictEqual(agent.nestedExecutions.size, 0);
  });

  it('settles a durable nested task while isolated log-path lookup is stalled', async function () {
    this.timeout(1000);
    const taskId = 'task-slow-log-a1';
    const commands = [];
    let status = 'running';
    let spawnCount = 0;
    let resolveLogPath;
    const manager = {
      getContainerEnvironmentValue() {
        return null;
      },
      spawnInContainer() {
        spawnCount++;
        if (spawnCount === 1) {
          return createClosingProcess(0, `✓ Task spawned: ${taskId}\n`);
        }
        const tail = new EventEmitter();
        tail.stdout = new PassThrough();
        tail.stderr = new PassThrough();
        tail.kill = () => {};
        return tail;
      },
      execInContainer(_clusterId, command) {
        commands.push(command);
        const rendered = command.join(' ');
        if (rendered.includes('get-task-id-by-spawn-token')) {
          return Promise.resolve({ code: 0, stdout: `${taskId}\n`, stderr: '' });
        }
        if (rendered.includes('get-log-path')) {
          return new Promise((resolve) => {
            resolveLogPath = resolve;
          });
        }
        if (command[1] === 'status') {
          return Promise.resolve({ code: 0, stdout: `Status: ${status}\n`, stderr: '' });
        }
        if (command[1] === 'kill') {
          status = 'killed';
          return Promise.resolve({ code: 0, stdout: `Killed ${taskId}\n`, stderr: '' });
        }
        return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
      },
    };
    const agent = {
      id: 'isolated-slow-log-path',
      role: 'planner',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 0,
      enableLivenessCheck: false,
      config: { outputFormat: 'json', strictSchema: true },
      cluster: { id: 'test-cluster' },
      isolation: { enabled: true, clusterId: 'test-cluster', manager },
      messageBus: { publish() {} },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
      _resolveModelSpecSource: () => 'direct',
      _log() {},
      _publishLifecycle() {},
      _stopLivenessCheck() {},
    };
    const launch = spawnClaudeTaskIsolated(agent, 'test context', {
      skipStructuredResultCheck: true,
      nested: true,
      structuredOutputRecovery: true,
    });
    while (!resolveLogPath) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const startedAt = Date.now();
    const cancellation = agent.nestedExecutions.cancelAll('Nested task timed out', {
      code: 'AGENT_TASK_TIMEOUT',
    });
    await assert.rejects(launch, (error) => {
      assert.strictEqual(error.code, 'AGENT_TASK_TIMEOUT');
      assert.strictEqual(error.nestedExecutionCancellation, true);
      return true;
    });
    await cancellation;

    assert.ok(Date.now() - startedAt < 750, 'cancellation must not await the stalled log lookup');
    assert.strictEqual(status, 'killed');
    assert.ok(commands.some((command) => command[1] === 'kill'));
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(agent.nestedExecutions.size, 0);

    resolveLogPath({ code: 0, stdout: '/tmp/late-reformat.log\n', stderr: '' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(spawnCount, 1, 'late lookup must not start a tail process');
  });

  it('confirms every terminal status observed after isolated kill', async function () {
    this.timeout(2000);
    for (const postKillStatus of ['completed', 'failed', 'killed']) {
      const taskId = `task-race-${postKillStatus}-a1`;
      let resolveLogPath;
      let spawnCount = 0;
      let statusChecks = 0;
      let killAttempts = 0;
      const manager = {
        getContainerEnvironmentValue() {
          return null;
        },
        spawnInContainer() {
          spawnCount++;
          if (spawnCount === 1) {
            return createClosingProcess(0, `✓ Task spawned: ${taskId}\n`);
          }
          const tail = new EventEmitter();
          tail.stdout = new PassThrough();
          tail.stderr = new PassThrough();
          tail.kill = () => {};
          return tail;
        },
        execInContainer(_clusterId, command) {
          const rendered = command.join(' ');
          if (rendered.includes('get-task-id-by-spawn-token')) {
            return Promise.resolve({ code: 0, stdout: `${taskId}\n`, stderr: '' });
          }
          if (rendered.includes('get-log-path')) {
            return new Promise((resolve) => {
              resolveLogPath = resolve;
            });
          }
          if (command[1] === 'status') {
            statusChecks++;
            const status = statusChecks === 1 ? 'running' : postKillStatus;
            return Promise.resolve({ code: 0, stdout: `Status: ${status}\n`, stderr: '' });
          }
          if (command[1] === 'kill') {
            killAttempts++;
            return Promise.resolve({ code: 0, stdout: `Kill raced ${taskId}\n`, stderr: '' });
          }
          return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
        },
      };
      const agent = {
        id: `isolated-race-${postKillStatus}`,
        role: 'planner',
        iteration: 1,
        running: true,
        state: 'executing_task',
        timeout: 0,
        enableLivenessCheck: false,
        config: { outputFormat: 'json', strictSchema: true },
        cluster: { id: 'test-cluster' },
        isolation: { enabled: true, clusterId: 'test-cluster', manager },
        messageBus: { publish() {} },
        _resolveProvider: () => 'opencode',
        _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
        _resolveModelSpecSource: () => 'direct',
        _log() {},
        _publishLifecycle() {},
        _stopLivenessCheck() {},
      };
      const launch = spawnClaudeTaskIsolated(agent, 'test context', {
        skipStructuredResultCheck: true,
        nested: true,
        structuredOutputRecovery: true,
      });
      while (!resolveLogPath) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const cancellation = agent.nestedExecutions.cancelAll('cluster shutdown', {
        code: 'REFORMAT_CANCELLED',
      });

      await assert.rejects(launch, (error) => {
        assert.strictEqual(error.code, 'REFORMAT_CANCELLED', postKillStatus);
        assert.strictEqual(error.nestedExecutionCancellation, true, postKillStatus);
        return true;
      });
      const termination = await cancellation;

      assert.notStrictEqual(termination?.forced, false, postKillStatus);
      assert.strictEqual(statusChecks, 2, postKillStatus);
      assert.strictEqual(killAttempts, 1, postKillStatus);
      assert.strictEqual(agent.nestedExecutions.size, 0, postKillStatus);
      resolveLogPath({ code: 0, stdout: `/tmp/late-${postKillStatus}.log\n`, stderr: '' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(spawnCount, 1, postKillStatus);
    }
  });

  it('settles cancelled terminal task without a second stalled log lookup', async function () {
    this.timeout(1000);
    const taskId = 'task-terminal-log-a1';
    let resolveLogPath;
    let logPathLookups = 0;
    let spawnCount = 0;
    const manager = {
      getContainerEnvironmentValue() {
        return null;
      },
      spawnInContainer() {
        spawnCount++;
        if (spawnCount === 1) {
          return createClosingProcess(0, `✓ Task spawned: ${taskId}\n`);
        }
        const tail = new EventEmitter();
        tail.stdout = new PassThrough();
        tail.stderr = new PassThrough();
        tail.kill = () => {};
        return tail;
      },
      execInContainer(_clusterId, command) {
        const rendered = command.join(' ');
        if (rendered.includes('get-task-id-by-spawn-token')) {
          return Promise.resolve({ code: 0, stdout: `${taskId}\n`, stderr: '' });
        }
        if (rendered.includes('get-log-path')) {
          logPathLookups++;
          return new Promise((resolve) => {
            resolveLogPath = resolve;
          });
        }
        if (command[1] === 'status') {
          return Promise.resolve({ code: 0, stdout: 'Status: completed\n', stderr: '' });
        }
        if (command[1] === 'kill') {
          return Promise.resolve({ code: 0, stdout: `Already completed ${taskId}\n`, stderr: '' });
        }
        return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
      },
    };
    const agent = {
      id: 'isolated-terminal-slow-log',
      role: 'planner',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 0,
      enableLivenessCheck: false,
      config: { outputFormat: 'json', strictSchema: true },
      cluster: { id: 'test-cluster' },
      isolation: { enabled: true, clusterId: 'test-cluster', manager },
      messageBus: { publish() {} },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
      _resolveModelSpecSource: () => 'direct',
      _log() {},
      _publishLifecycle() {},
      _stopLivenessCheck() {},
    };
    const launch = spawnClaudeTaskIsolated(agent, 'test context', {
      skipStructuredResultCheck: true,
      nested: true,
      structuredOutputRecovery: true,
    });
    while (!resolveLogPath) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const startedAt = Date.now();
    const cancellation = agent.nestedExecutions.cancelAll('Nested task timed out', {
      code: 'AGENT_TASK_TIMEOUT',
    });

    await assert.rejects(launch, (error) => {
      assert.strictEqual(error.code, 'AGENT_TASK_TIMEOUT');
      assert.strictEqual(error.nestedExecutionCancellation, true);
      return true;
    });
    await cancellation;

    assert.ok(Date.now() - startedAt < 750, 'terminal cancellation must not re-enter log lookup');
    assert.strictEqual(logPathLookups, 1);
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(agent.nestedExecutions.size, 0);

    resolveLogPath({ code: 0, stdout: '/tmp/late-terminal.log\n', stderr: '' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(logPathLookups, 1);
    assert.strictEqual(spawnCount, 1);
  });

  it('cancels promptly while an observed terminal task final read is stalled', async function () {
    this.timeout(4000);
    const taskId = 'task-terminal-drain-a1';
    let resolveFinalRead;
    let finalReadCount = 0;
    let spawnCount = 0;
    let tailKills = 0;
    const manager = {
      getContainerEnvironmentValue() {
        return null;
      },
      spawnInContainer() {
        spawnCount++;
        if (spawnCount === 1) {
          return createClosingProcess(0, `✓ Task spawned: ${taskId}\n`);
        }
        const tail = new EventEmitter();
        tail.stdout = new PassThrough();
        tail.stderr = new PassThrough();
        tail.kill = () => {
          tailKills++;
        };
        return tail;
      },
      execInContainer(_clusterId, command) {
        const rendered = command.join(' ');
        if (rendered.includes('get-task-id-by-spawn-token')) {
          return Promise.resolve({ code: 0, stdout: `${taskId}\n`, stderr: '' });
        }
        if (rendered.includes('get-log-path')) {
          return Promise.resolve({ code: 0, stdout: '/tmp/terminal-drain.log\n', stderr: '' });
        }
        if (rendered.includes('zeroshot status')) {
          return Promise.resolve({ code: 0, stdout: 'Status: completed\n', stderr: '' });
        }
        if (rendered.includes('cat "/tmp/terminal-drain.log"')) {
          finalReadCount++;
          return new Promise((resolve) => {
            resolveFinalRead = resolve;
          });
        }
        return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
      },
    };
    const agent = {
      id: 'isolated-terminal-drain',
      role: 'planner',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 0,
      enableLivenessCheck: false,
      config: { outputFormat: 'json', strictSchema: true },
      cluster: { id: 'test-cluster' },
      isolation: { enabled: true, clusterId: 'test-cluster', manager },
      messageBus: { publish() {} },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
      _resolveModelSpecSource: () => 'direct',
      _log() {},
      _publishLifecycle() {},
      _stopLivenessCheck() {},
    };
    const launch = spawnClaudeTaskIsolated(agent, 'test context', {
      skipStructuredResultCheck: true,
      nested: true,
      structuredOutputRecovery: true,
    });
    while (!resolveFinalRead) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const startedAt = Date.now();
    const cancellation = agent.nestedExecutions.cancelAll('Nested task timed out', {
      code: 'AGENT_TASK_TIMEOUT',
    });

    await assert.rejects(launch, (error) => {
      assert.strictEqual(error.code, 'AGENT_TASK_TIMEOUT');
      assert.strictEqual(error.nestedExecutionCancellation, true);
      return true;
    });
    await cancellation;

    assert.ok(Date.now() - startedAt < 750, 'cancellation must not await the final log read');
    assert.strictEqual(finalReadCount, 1);
    assert.strictEqual(spawnCount, 2);
    assert.strictEqual(tailKills, 1);
    assert.strictEqual(agent.nestedExecutions.size, 0);

    resolveFinalRead({ code: 0, stdout: opencodeTextEvent({ plan: 'too late' }), stderr: '' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(finalReadCount, 1);
    assert.strictEqual(spawnCount, 2);
  });

  it('kills and settles a durable nested task when post-ID log setup fails', async function () {
    this.timeout(3000);
    const taskId = 'task-amber-fox-b2';
    const commands = [];
    let status = 'running';
    const manager = {
      spawnInContainer() {
        return createClosingProcess(0, `✓ Task spawned: ${taskId}\n`);
      },
      execInContainer(_clusterId, command) {
        commands.push(command);
        const rendered = command.join(' ');
        if (rendered.includes('get-task-id-by-spawn-token')) {
          return Promise.resolve({ code: 0, stdout: `${taskId}\n`, stderr: '' });
        }
        if (rendered.includes('get-log-path')) {
          return Promise.resolve({ code: 1, stdout: '', stderr: 'log path unavailable' });
        }
        if (command[1] === 'status') {
          return Promise.resolve({ code: 0, stdout: `Status: ${status}\n`, stderr: '' });
        }
        if (command[1] === 'kill') {
          status = 'killed';
          return Promise.resolve({ code: 0, stdout: `Killed ${taskId}\n`, stderr: '' });
        }
        return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
      },
    };
    const parentTask = { kill() {} };
    const agent = {
      id: 'isolated-setup-failure',
      role: 'planner',
      iteration: 1,
      running: true,
      state: 'executing_task',
      timeout: 0,
      enableLivenessCheck: false,
      currentTask: parentTask,
      currentTaskId: 'parent-task-7',
      processPid: 777,
      config: { outputFormat: 'json', strictSchema: true },
      cluster: { id: 'test-cluster' },
      isolation: { enabled: true, clusterId: 'test-cluster', manager },
      messageBus: { publish() {} },
      _resolveProvider: () => 'opencode',
      _resolveModelSpec: () => ({ model: CATALOG_MODEL }),
      _resolveModelSpecSource: () => 'direct',
      _log() {},
      _publishLifecycle() {},
      _stopLivenessCheck() {},
    };

    await assert.rejects(
      spawnClaudeTaskIsolated(agent, 'test context', {
        skipStructuredResultCheck: true,
        nested: true,
      }),
      /Failed to get log path/
    );

    assert.ok(commands.some((command) => command[1] === 'kill'));
    assert.strictEqual(status, 'killed');
    assert.strictEqual(agent.nestedExecutions.size, 0);
    assert.strictEqual(agent.currentTask, parentTask);
    assert.strictEqual(agent.currentTaskId, 'parent-task-7');
    assert.strictEqual(agent.processPid, 777);
  });
});

describe('Nested ClaudeTaskRunner model arguments', function () {
  it('preserves provider-level provenance locally and in Docker', async function () {
    const runner = new ClaudeTaskRunner({ quiet: true, timeout: 20 });
    const modelSpec = {
      level: 'level2',
      model: EXTERNAL_MODEL,
      reasoningEffort: 'high',
    };
    const localArgs = runner._buildRunArgs({
      context: 'test context',
      providerName: 'opencode',
      runOutputFormat: 'json',
      resolvedModelSpec: modelSpec,
      modelSpecSource: 'provider-level',
      jsonSchema: null,
    });
    assertConfiguredModelArgs(localArgs);

    let capturedCommand;
    let capturedOptions;
    const result = await runner._runIsolated('test context', {
      agentId: 'configured-runner-docker',
      provider: 'opencode',
      modelLevel: 'level2',
      reasoningEffort: 'high',
      outputFormat: 'json',
      isolation: {
        clusterId: 'test-cluster',
        manager: {
          spawnInContainer(_clusterId, command, options) {
            capturedCommand = command;
            capturedOptions = options;
            return createClosingProcess();
          },
        },
      },
    });

    assert.strictEqual(result.success, false);
    assertConfiguredModelArgs(capturedCommand);
    assert.deepStrictEqual(JSON.parse(capturedCommand[3]), {
      providerSettings: {
        opencode: {
          levelOverrides: {
            level2: { model: EXTERNAL_MODEL },
          },
        },
      },
    });
    assert.deepStrictEqual(capturedOptions.env, {});
  });
});

describe('Nested task-lib model preparation', function () {
  it('derives configured intent from settings and rejects caller-supplied model provenance', async function () {
    const { prepareTaskProviderCommand } = await import('../task-lib/runner.js');
    const dockerSettingsFile = path.join(settingsDir, 'docker-settings.json');

    try {
      const prepared = prepareTaskProviderCommand('test context', {
        provider: 'opencode',
        modelLevel: 'level2',
        reasoningEffort: 'high',
      });
      assert.deepStrictEqual(prepared.options.modelSpec, {
        level: 'level2',
        model: EXTERNAL_MODEL,
        reasoningEffort: 'high',
      });

      fs.writeFileSync(
        dockerSettingsFile,
        JSON.stringify({
          defaultProvider: 'opencode',
          providerSettings: {
            opencode: {
              levelOverrides: {
                level2: { model: EXTERNAL_MODEL },
              },
            },
          },
        })
      );
      process.env.ZEROSHOT_SETTINGS_FILE = dockerSettingsFile;
      const isolatedPrepared = prepareTaskProviderCommand('test context', {
        provider: 'opencode',
        modelLevel: 'level2',
      });
      assert.strictEqual(isolatedPrepared.options.modelSpec.model, EXTERNAL_MODEL);

      assert.throws(
        () =>
          prepareTaskProviderCommand('test context', {
            provider: 'opencode',
            model: EXTERNAL_MODEL,
          }),
        { permanent: true }
      );
      assert.throws(
        () =>
          prepareTaskProviderCommand('test context', {
            provider: 'opencode',
            modelLevel: 'level2',
            configuredModel: EXTERNAL_MODEL,
          }),
        /--configured-model is not supported/
      );
    } finally {
      process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    }
  });
});
