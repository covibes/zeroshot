const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { streamClusterTraceExport } = require('../cli/trace-export');
const {
  fakeLedger,
  lifecycle,
  parseRecords,
  protectedOutputs,
  runCliTaskExport,
  sourceBoundary,
  taskOutput,
  traceTask,
  withLogWorkspace,
  withReadMutation,
} = require('./helpers/cluster-export-fixtures');

it(
  'captures but never marks a nonterminal task output complete',
  withLogWorkspace('zeroshot-trace-', (root, logRoot) => {
    const taskId = 'task-running';
    const logFile = path.join(logRoot, `${taskId}.log`);
    const outputPath = path.join(root, 'running.trace.jsonl');
    fs.writeFileSync(logFile, 'still running\n');
    const runningTask = traceTask(taskId, 'pi', 'running prompt', logFile);
    runningTask.status = 'running';
    streamClusterTraceExport({
      ledger: fakeLedger([lifecycle(1, taskId, 'running-agent')]),
      clusterId: 'trace-cluster',
      readTask: () => runningTask,
      allowedLogRoot: logRoot,
      outputPath,
    });
    const records = parseRecords(outputPath);
    const end = records.find((record) => record.record_type === 'task_output_end');
    assert.strictEqual(end.available, true);
    assert.strictEqual(end.complete, false);
    assert.deepStrictEqual(taskOutput(records, taskId), Buffer.from('still running\n'));
    assert.deepStrictEqual(records.at(-1).issues, [`task:${taskId}:task_not_terminal`]);
  })
);

it(
  'exports the native bundle through the public CLI',
  withLogWorkspace('zeroshot-trace-', (root) => {
    const homeDir = path.join(root, 'home');
    const clusterId = 'cli-trace-cluster';
    const taskId = 'task-cli-trace';
    const cliLogRoot = path.join(homeDir, '.claude-zeroshot', 'logs');
    const logFile = path.join(cliLogRoot, `${taskId}.log`);
    const outputPath = path.join(root, 'cli.trace.jsonl');
    fs.mkdirSync(path.join(homeDir, '.zeroshot'), { recursive: true });
    fs.mkdirSync(cliLogRoot, { recursive: true });
    fs.writeFileSync(logFile, 'provider-native-output\n');
    runCliTaskExport({
      homeDir,
      clusterId,
      taskId,
      task: traceTask(taskId, 'pi', 'exact CLI prompt', logFile),
      format: 'trace',
      outputPath,
    });
    const records = parseRecords(outputPath);
    assert.strictEqual(records.at(-1).complete, true);
    assert.deepStrictEqual(taskOutput(records, taskId), Buffer.from('provider-native-output\n'));
  })
);

it(
  'never replaces existing output or follows an output symlink',
  withLogWorkspace('zeroshot-trace-', (root, logRoot) => {
    const boundary = protectedOutputs(root, 'trace.jsonl');
    const options = {
      ledger: fakeLedger([]),
      clusterId: 'trace-cluster',
      readTask: () => null,
      allowedLogRoot: logRoot,
    };
    assert.throws(() => streamClusterTraceExport({ ...options, outputPath: boundary.existing }));
    assert.throws(() => streamClusterTraceExport({ ...options, outputPath: boundary.symlink }));
    assert.strictEqual(fs.readFileSync(boundary.existing, 'utf8'), 'existing');
    assert.strictEqual(fs.readFileSync(boundary.protectedPath, 'utf8'), 'protected');
  })
);

it(
  'ignores unrelated task IDs and rejects mismatched task rows',
  withLogWorkspace('zeroshot-trace-', (root, logRoot) => {
    const legitimateId = 'task-legitimate';
    const unrelatedId = 'task-unrelated';
    const mismatchedId = 'task-mismatched';
    const outputPath = path.join(root, 'boundary.trace.jsonl');
    const messages = [
      { topic: 'AGENT_OUTPUT', sender: 'agent', content: { data: { taskId: legitimateId } } },
      lifecycle(2, mismatchedId, 'mismatched-agent'),
      { topic: 'PLUGIN_DATA', content: { data: { taskId: unrelatedId } } },
    ];
    const tasks = new Map();
    for (const taskId of [legitimateId, unrelatedId, mismatchedId]) {
      const logFile = path.join(logRoot, `${taskId}.log`);
      fs.writeFileSync(logFile, `${taskId}-private-output`);
      tasks.set(taskId, traceTask(taskId, 'pi', `${taskId}-private-prompt`, logFile));
    }
    tasks.get(mismatchedId).id = 'different-task-id';
    streamClusterTraceExport({
      ledger: fakeLedger(messages),
      clusterId: 'trace-cluster',
      readTask: (taskId) => tasks.get(taskId) || null,
      allowedLogRoot: logRoot,
      outputPath,
    });
    const records = parseRecords(outputPath);
    assert.deepStrictEqual(
      records.filter((record) => record.record_type === 'task').map((record) => record.task_id),
      [legitimateId, mismatchedId]
    );
    assert.strictEqual(taskOutput(records, unrelatedId).length, 0);
    assert.strictEqual(taskOutput(records, mismatchedId).length, 0);
  })
);

it(
  'refuses source symlinks and detects a task log changing during capture',
  withLogWorkspace('zeroshot-trace-', (root, logRoot) => {
    if (process.platform === 'win32') return;
    const symlinkId = 'task-symlink-source';
    const changingId = 'task-changing-source';
    const boundary = sourceBoundary(
      root,
      logRoot,
      'trace.jsonl',
      'must-not-export',
      'initial bytes'
    );
    const tasks = new Map([
      [symlinkId, traceTask(symlinkId, 'pi', 'symlink prompt', boundary.symlinkLog)],
      [changingId, traceTask(changingId, 'codex', 'changing prompt', boundary.changingLog)],
    ]);
    withReadMutation(boundary.changingLog, 1, ' appended later', () => {
      streamClusterTraceExport({
        ledger: fakeLedger([
          lifecycle(1, symlinkId, 'symlink-agent'),
          lifecycle(2, changingId, 'changing-agent'),
        ]),
        clusterId: 'trace-cluster',
        readTask: (taskId) => tasks.get(taskId) || null,
        allowedLogRoot: logRoot,
        outputPath: boundary.outputPath,
      });
    });
    const records = parseRecords(boundary.outputPath);
    assert.strictEqual(taskOutput(records, symlinkId).length, 0);
    assert.strictEqual(fs.readFileSync(boundary.protectedPath, 'utf8'), 'must-not-export');
    assert.deepStrictEqual(records.at(-1).issues, [
      `task:${changingId}:log_changed_during_export`,
      `task:${symlinkId}:log_unreadable`,
    ]);
  })
);
