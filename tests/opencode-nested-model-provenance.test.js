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

    await assert.rejects(
      spawnClaudeTaskIsolated(agent, 'test context'),
      /zeroshot task run failed with code 1/
    );
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
      spawnInContainer(_clusterId, command) {
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
        spawnClaudeTaskIsolated(agent, prompt, { skipStructuredResultCheck: true }),
    });

    assert.deepStrictEqual(result, { plan: 'isolated recovery' });
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
