const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const { writeBenchmarkResultBundle } = require('../src/foreground-benchmark-files');
const {
  RESULT_SCHEMA,
  buildBenchmarkResult,
  buildCancelledResult,
} = require('../src/foreground-benchmark-result');
const { writeForegroundResult } = require('../src/foreground-benchmark-run');
const { createTempDirectory, removeTempDirectory } = require('./helpers/temp-directory');

const RUN_ID = 'benchmark-result-test';
const STOPPED_AGENTS = [{ id: 'planner', pid: null }];
const ATOMIC_KILL_FIXTURE = path.join(__dirname, 'fixtures', 'foreground-atomic-kill.js');

function terminal(topic) {
  return { topic, sender: 'planner', receiver: 'system', content: { data: {} } };
}

function snapshot() {
  return {
    messageCount: 17,
    tokensByRole: {
      _total: { inputTokens: 10, outputTokens: 5, count: 2 },
    },
  };
}

function completedResult() {
  return buildBenchmarkResult({
    runId: RUN_ID,
    terminalMessages: [terminal('CLUSTER_COMPLETE')],
    agents: STOPPED_AGENTS,
  });
}

describe('foreground benchmark atomic bundle', function () {
  let directory;
  beforeEach(() => {
    directory = createTempDirectory('zeroshot-foreground-result-');
  });

  afterEach(() => {
    removeTempDirectory(directory);
  });

  it('writes telemetry before one non-overwriting receipt with matching digest', function () {
    const resultPath = path.join(directory, 'result.json');
    const receipt = writeBenchmarkResultBundle(resultPath, completedResult(), snapshot());
    const persisted = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const telemetryPath = path.join(directory, persisted.telemetry.artifact);
    const telemetry = fs.readFileSync(telemetryPath);

    assert.deepStrictEqual(persisted, receipt);
    assert.strictEqual(persisted.telemetry.byteLength, telemetry.length);
    assert.strictEqual(
      persisted.telemetry.sha256,
      crypto.createHash('sha256').update(telemetry).digest('hex')
    );
    assert.strictEqual(fs.statSync(resultPath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(telemetryPath).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), [
      'result.json',
      'result.json.telemetry.json',
    ]);
  });

  it('refuses to replace an existing result and removes its orphan telemetry', function () {
    const resultPath = path.join(directory, 'result.json');
    fs.writeFileSync(resultPath, 'existing\n', { mode: 0o600 });
    const result = buildCancelledResult({ runId: RUN_ID, agents: STOPPED_AGENTS });

    assert.throws(() => writeBenchmarkResultBundle(resultPath, result, snapshot()), /EEXIST/);
    assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'existing\n');
    assert.deepStrictEqual(fs.readdirSync(directory), ['result.json']);
  });

  it('retains a complete published bundle when the final durability sync fails', function () {
    const resultPath = path.join(directory, 'result.json');
    const originalFsync = fs.fsyncSync;
    let calls = 0;
    fs.fsyncSync = (descriptor) => {
      calls += 1;
      if (calls === 4)
        throw Object.assign(new Error('simulated directory fsync failure'), { code: 'EIO' });
      return originalFsync(descriptor);
    };
    try {
      assert.throws(
        () => writeBenchmarkResultBundle(resultPath, completedResult(), snapshot()),
        /simulated directory fsync failure/
      );
    } finally {
      fs.fsyncSync = originalFsync;
    }

    const receipt = JSON.parse(fs.readFileSync(resultPath));
    const telemetryPath = path.join(directory, receipt.telemetry.artifact);
    assert.strictEqual(fs.existsSync(telemetryPath), true);
    const telemetry = fs.readFileSync(telemetryPath);
    assert.strictEqual(receipt.telemetry.byteLength, telemetry.length);
    assert.strictEqual(
      receipt.telemetry.sha256,
      crypto.createHash('sha256').update(telemetry).digest('hex')
    );
  });
});

describe('foreground benchmark terminal and crash races', function () {
  let directory;
  beforeEach(() => {
    directory = createTempDirectory('zeroshot-foreground-race-');
  });
  afterEach(() => {
    removeTempDirectory(directory);
  });

  it('lets an authoritative terminal win a cancellation race', function () {
    const resultPath = path.join(directory, 'raced-result.json');
    const completed = { ...terminal('CLUSTER_COMPLETE'), sequence: '9' };
    const cluster = {
      messageBus: {
        query: ({ topic }) => (topic === 'CLUSTER_COMPLETE' ? [completed] : []),
        readSnapshot: snapshot,
      },
    };
    const orchestrator = {
      getStatus: () => ({ state: 'stopped', isZombie: false, agents: STOPPED_AGENTS }),
    };
    const receipt = writeForegroundResult({
      orchestrator,
      cluster,
      clusterId: RUN_ID,
      resultPath,
      cancelled: true,
    });

    assert.strictEqual(receipt.outcome, 'completed');
    assert.strictEqual(receipt.terminalOwner, 'task');
  });

  for (const phase of ['before', 'after']) {
    it(`survives SIGKILL ${phase} the authoritative receipt link`, async function () {
      const resultPath = path.join(directory, `${phase}-kill-result.json`);
      const markerPath = path.join(directory, `${phase}-kill.marker`);
      const child = spawn(process.execPath, [ATOMIC_KILL_FIXTURE, resultPath, markerPath, phase], {
        stdio: 'ignore',
      });
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(markerPath) && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.strictEqual(fs.existsSync(markerPath), true, 'child did not reach atomic boundary');
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));

      assert.strictEqual(fs.existsSync(resultPath), phase === 'after');
      if (phase === 'after') {
        const { schema, outcome, telemetry } = JSON.parse(fs.readFileSync(resultPath));
        assert.strictEqual(schema, RESULT_SCHEMA);
        assert.strictEqual(outcome, 'completed');
        const telemetryBytes = fs.readFileSync(path.join(directory, telemetry.artifact));
        assert.strictEqual(telemetry.byteLength, telemetryBytes.length);
        assert.strictEqual(
          telemetry.sha256,
          crypto.createHash('sha256').update(telemetryBytes).digest('hex')
        );
      }
    });
  }
});
