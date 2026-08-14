const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { setupE2ERepo, cleanupE2ERepo, runZeroshot } = require('./helpers/e2e-harness');
const { extractTaskLogProviderOutput } = require('./helpers/task-log');

const CONFIG_PATH = path.join(__dirname, 'fixtures', 'codex-terminal-stress-config.json');
const FAKE_CODEX_PATH = path.resolve(__dirname, '..', 'fixtures', 'fake-codex-terminal-stress.js');
const STRESS_BYTES = 12 * 1024 * 1024;
const MAX_EXPORTED_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024;
const BENCHMARK_AGENT_FIELDS = [
  'currentTask',
  'currentTaskId',
  'id',
  'iteration',
  'maxIterations',
  'model',
  'modelSpec',
  'pid',
  'provider',
  'role',
  'state',
];

function assertBenchmarkAgentContract(agent) {
  assert.deepStrictEqual(Object.keys(agent).sort(), BENCHMARK_AGENT_FIELDS);
  for (const name of ['id', 'role', 'state']) {
    assert.ok(typeof agent[name] === 'string' && agent[name], `${name} must be nonempty text`);
  }
  for (const name of ['iteration', 'maxIterations']) {
    assert.ok(Number.isInteger(agent[name]) && agent[name] >= 0, `${name} must be nonnegative`);
  }
  for (const name of ['model', 'provider', 'currentTaskId']) {
    assert.ok(
      agent[name] === null || typeof agent[name] === 'string',
      `${name} must be optional text`
    );
  }
  assert.strictEqual(typeof agent.currentTask, 'boolean');
  assert.ok(agent.pid === null || (Number.isInteger(agent.pid) && agent.pid > 1));
  assert.ok(agent.modelSpec && typeof agent.modelSpec === 'object');
  assert.ok(
    Object.keys(agent.modelSpec).every((name) =>
      ['level', 'model', 'reasoningEffort'].includes(name)
    )
  );
  assert.ok(
    Object.values(agent.modelSpec).every((value) => value === null || typeof value === 'string')
  );
}

function readTaskLog(homeDir) {
  const storePath = path.join(homeDir, '.claude-zeroshot', 'store.db');
  const database = new Database(storePath, { readonly: true, fileMustExist: true });
  try {
    const tasks = database.prepare('SELECT status, error, log_file, attachable FROM tasks').all();
    assert.strictEqual(tasks.length, 1, `expected one real provider task, got ${tasks.length}`);
    assert.strictEqual(tasks[0].status, 'completed', tasks[0].error || 'task did not complete');
    assert.strictEqual(tasks[0].attachable, 0, 'benchmark tasks must use the pipe watcher');
    return fs.readFileSync(tasks[0].log_file, 'utf8');
  } finally {
    database.close();
  }
}

describe('e2e: Codex compressed terminal stress', function () {
  this.timeout(90000);

  let env;
  let issueDir;

  beforeEach(() => {
    env = setupE2ERepo();
    issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-terminal-stress-'));
    fs.symlinkSync(FAKE_CODEX_PATH, path.join(env.binDir, 'codex'));
  });

  afterEach(() => {
    cleanupE2ERepo(env);
    fs.rmSync(issueDir, { recursive: true, force: true });
  });

  it('bounds the control plane while preserving the raw log and terminal export', function () {
    const issuePath = path.join(issueDir, 'task.md');
    const expectedOutputPath = path.join(issueDir, 'expected-provider-output.jsonl');
    const exportPath = path.join(issueDir, 'cluster-export.json');
    fs.writeFileSync(issuePath, '# Synthetic terminal stress\n');

    const clusterId = 'e2e-codex-terminal-stress';
    const run = runZeroshot(
      env,
      [
        'run',
        issuePath,
        '--config',
        CONFIG_PATH,
        '--provider',
        'codex',
        '--model',
        'gpt-5.6-luna',
        '--strict-schema',
        '--sim',
        'off',
      ],
      {
        ZEROSHOT_CLUSTER_ID: clusterId,
        ZEROSHOT_TASK_EXECUTION_CONTEXT: 'benchmark',
        FAKE_CODEX_EXPECTED_OUTPUT: expectedOutputPath,
        FAKE_CODEX_STRESS_BYTES: String(STRESS_BYTES),
      }
    );
    assert.strictEqual(run.status, 0, `STDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`);

    const rawLog = readTaskLog(env.homeDir);
    const expectedOutput = fs.readFileSync(expectedOutputPath, 'utf8');
    assert.ok(Buffer.byteLength(expectedOutput) > STRESS_BYTES);
    assert.strictEqual(extractTaskLogProviderOutput(rawLog, 'turn.completed'), expectedOutput);

    const statusResult = runZeroshot(env, ['status', clusterId, '--json']);
    assert.strictEqual(
      statusResult.status,
      0,
      `STDOUT:\n${statusResult.stdout}\nSTDERR:\n${statusResult.stderr}`
    );
    const status = JSON.parse(statusResult.stdout);
    assert.strictEqual(status.state, 'stopped');
    assert.strictEqual(status.isZombie, false);
    assert.strictEqual(status.pid, null);
    assert.ok(Array.isArray(status.agents) && status.agents.length === 2);
    status.agents.forEach(assertBenchmarkAgentContract);

    const exportResult = runZeroshot(env, [
      'export',
      clusterId,
      '--format',
      'json',
      '--output',
      exportPath,
    ]);
    assert.strictEqual(exportResult.status, 0, exportResult.stderr);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    assert.strictEqual(exported.cluster_id, clusterId);
    assert.strictEqual(exported.messages.length, status.messageCount);
    assert.strictEqual(
      exported.messages.filter((message) =>
        ['CLUSTER_COMPLETE', 'CLUSTER_FAILED'].includes(message.topic)
      ).length,
      1
    );

    const exportedAgentOutputBytes = exported.messages
      .filter((message) => message.topic === 'AGENT_OUTPUT')
      .reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
    assert.ok(
      exportedAgentOutputBytes <= MAX_EXPORTED_AGENT_OUTPUT_BYTES,
      `control-plane agent output was ${exportedAgentOutputBytes} bytes`
    );
  });
});
