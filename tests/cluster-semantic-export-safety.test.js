const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { streamClusterSemanticExport } = require('../cli/semantic-export');
const {
  fakeLedger,
  lifecycle,
  parseRecords,
  protectedOutputs,
  sourceBoundary,
  withLogWorkspace,
  withReadMutation,
} = require('./helpers/cluster-export-fixtures');
const {
  PI_USAGE,
  semanticFixture,
  semanticTask,
  timestamped,
} = require('./helpers/semantic-export-fixtures');

function exportOne({ root, logRoot, taskId, task, outputName }) {
  const outputPath = path.join(root, outputName);
  streamClusterSemanticExport({
    ledger: fakeLedger([lifecycle(1, taskId, 'agent')]),
    clusterId: 'semantic-cluster',
    readTask: () => task,
    allowedLogRoot: logRoot,
    outputPath,
  });
  return parseRecords(outputPath);
}

it(
  'keeps nonterminal evidence incomplete and malformed Pi stdout fail-closed',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const runningId = 'task-running';
    const malformedId = 'task-pi-malformed';
    const runningLog = path.join(logRoot, `${runningId}.log`);
    const malformedLog = path.join(logRoot, `${malformedId}.log`);
    fs.writeFileSync(runningLog, semanticFixture('codex'));
    fs.writeFileSync(malformedLog, '[1800000000123]not-json-provider-stdout\n');
    const runningTask = semanticTask(runningId, 'codex', runningLog);
    runningTask.status = 'running';
    const tasks = new Map([
      [runningId, runningTask],
      [malformedId, semanticTask(malformedId, 'pi', malformedLog)],
    ]);
    const outputPath = path.join(root, 'truthful.semantic.jsonl');
    streamClusterSemanticExport({
      ledger: fakeLedger([
        lifecycle(1, runningId, 'running-agent'),
        lifecycle(2, malformedId, 'pi-agent'),
      ]),
      clusterId: 'semantic-cluster',
      readTask: (taskId) => tasks.get(taskId) || null,
      allowedLogRoot: logRoot,
      outputPath,
    });
    const records = parseRecords(outputPath);
    const codes = records
      .filter((record) => record.record_type === 'diagnostic')
      .map((record) => `${record.task_id}:${record.code}`);
    assert.ok(codes.includes(`${runningId}:task_not_terminal`));
    assert.ok(codes.includes(`${malformedId}:malformed_json`));
    assert.strictEqual(records.at(-1).complete, false);
  })
);

it(
  'fails closed on legacy mixed channels instead of projecting JSON-shaped stderr',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const taskId = 'task-legacy-codex';
    const logFile = path.join(logRoot, `${taskId}.log`);
    fs.writeFileSync(logFile, '[1800000000123]{"type":"turn.completed"}\n');
    const records = exportOne({
      root,
      logRoot,
      taskId,
      task: semanticTask(taskId, 'codex', logFile),
      outputName: 'legacy.semantic.jsonl',
    });
    assert.strictEqual(
      records.some((record) => record.record_type === 'event'),
      false
    );
    const codes = records
      .filter((record) => record.record_type === 'diagnostic')
      .map((record) => record.code);
    assert.ok(codes.includes('legacy_ambiguous_channels'));
    assert.ok(codes.includes('terminal_result_missing'));
  })
);

it(
  'projects channel-framed JSON logs without confusing stderr or reserved stdout',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const timestamp = 1_800_000_000_123;
    const marker = `[${timestamp}][ZEROSHOT][LOG_FORMAT] channel-framed-v2\n`;
    const stdout = (line) => `[${timestamp}][ZEROSHOT][PROVIDER_STDOUT] ${line}\n`;
    const stderr = (line) => `[${timestamp}][ZEROSHOT][PROVIDER_STDERR] ${line}\n`;
    const ids = {
      ordinary: 'task-json-ordinary',
      fatal: 'task-json-silent-fatal',
      collision: 'task-reserved-prefix',
    };
    const ordinaryResult = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ordinary JSON mode',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const collisionResult = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'collision survived',
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    const outputs = {
      ordinary: marker + stdout(ordinaryResult),
      fatal:
        marker +
        stderr('Error: No messages returned') +
        `[${timestamp}][ZEROSHOT][FATAL] Claude CLI error: No messages returned\n`,
      collision:
        marker +
        stdout('[ZEROSHOT][LOG_FORMAT] channel-framed-v2') +
        stdout('[ZEROSHOT][PROVIDER_STDERR] genuine provider stdout') +
        stdout(collisionResult),
    };
    function project(label, status = 'completed') {
      const taskId = ids[label];
      const logFile = path.join(logRoot, `${taskId}.log`);
      fs.writeFileSync(logFile, outputs[label]);
      const task = semanticTask(taskId, 'claude', logFile);
      task.status = status;
      return exportOne({
        root,
        logRoot,
        taskId,
        task,
        outputName: `${label}.semantic.jsonl`,
      });
    }
    const ordinary = project('ordinary');
    const fatal = project('fatal', 'failed');
    const collision = project('collision');
    const events = (records) => records.filter((record) => record.record_type === 'event');
    const codes = (records) =>
      records.filter((record) => record.record_type === 'diagnostic').map((record) => record.code);
    assert.strictEqual(events(ordinary).at(-1).event.success, true);
    assert.deepStrictEqual(codes(ordinary), []);
    assert.deepStrictEqual(events(fatal), []);
    assert.deepStrictEqual(codes(fatal), ['terminal_result_missing']);
    assert.strictEqual(events(collision).at(-1).event.result, 'collision survived');
    assert.strictEqual(codes(collision).filter((code) => code === 'malformed_json').length, 2);
    assert.ok(
      Object.values(outputs).every(
        (output) => !/^\[\d{13}\]Error: No messages returned$/m.test(output)
      )
    );
  })
);

it(
  'emits one Pi terminal result and rejects provider output after agent_settled',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const taskId = 'task-pi-post-settled';
    const logFile = path.join(logRoot, `${taskId}.log`);
    fs.writeFileSync(
      logFile,
      timestamped([
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'settled result' }],
            usage: PI_USAGE,
            stopReason: 'stop',
          },
        },
        { type: 'agent_settled' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'late output' },
        },
      ])
    );
    const records = exportOne({
      root,
      logRoot,
      taskId,
      task: semanticTask(taskId, 'pi', logFile),
      outputName: 'post-settled.semantic.jsonl',
    });
    const results = records.filter(
      (record) => record.record_type === 'event' && record.event.type === 'result'
    );
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].event.success, true);
    assert.ok(
      records.some(
        (record) => record.record_type === 'diagnostic' && record.code === 'output_after_terminal'
      )
    );
  })
);

it(
  'refuses existing, symlink, and source-log output paths',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const boundary = protectedOutputs(root, 'semantic.jsonl');
    const taskId = 'task-destination';
    const sourceLog = path.join(logRoot, `${taskId}.log`);
    const options = {
      ledger: fakeLedger([lifecycle(1, taskId, 'destination-agent')]),
      clusterId: 'semantic-cluster',
      readTask: () => semanticTask(taskId, 'codex', sourceLog),
      allowedLogRoot: logRoot,
    };
    assert.throws(() => streamClusterSemanticExport({ ...options, outputPath: boundary.existing }));
    assert.throws(() => streamClusterSemanticExport({ ...options, outputPath: boundary.symlink }));
    assert.throws(() => streamClusterSemanticExport({ ...options, outputPath: sourceLog }));
    assert.strictEqual(fs.readFileSync(boundary.protectedPath, 'utf8'), 'protected');
  })
);

it(
  'refuses source symlinks and detects mutation between hash and parse',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    if (process.platform === 'win32') return;
    const symlinkId = 'task-symlink-source';
    const changingId = 'task-changing-source';
    const boundary = sourceBoundary(
      root,
      logRoot,
      'semantic.jsonl',
      'must-not-project',
      semanticFixture('codex')
    );
    const tasks = new Map([
      [symlinkId, semanticTask(symlinkId, 'pi', boundary.symlinkLog)],
      [changingId, semanticTask(changingId, 'codex', boundary.changingLog)],
    ]);
    withReadMutation(boundary.changingLog, 2, 'appended after hash', () => {
      streamClusterSemanticExport({
        ledger: fakeLedger([
          lifecycle(1, symlinkId, 'symlink-agent'),
          lifecycle(2, changingId, 'changing-agent'),
        ]),
        clusterId: 'semantic-cluster',
        readTask: (taskId) => tasks.get(taskId) || null,
        allowedLogRoot: logRoot,
        outputPath: boundary.outputPath,
      });
    });
    const records = parseRecords(boundary.outputPath);
    assert.strictEqual(fs.readFileSync(boundary.protectedPath, 'utf8'), 'must-not-project');
    assert.deepStrictEqual(records.at(-1).issues, [
      `task:${changingId}:log_changed_during_parse`,
      `task:${symlinkId}:log_unreadable`,
    ]);
  })
);
