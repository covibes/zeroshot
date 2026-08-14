const assert = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { TRACE_OUTPUT_CHUNK_BYTES, streamClusterTraceExport } = require('../cli/trace-export');
const {
  fakeLedger,
  lifecycle,
  parseRecords,
  taskOutput,
  traceTask,
  withLogWorkspace,
} = require('./helpers/cluster-export-fixtures');

function assertBundleDigest(raw, records) {
  const footer = records.at(-1);
  assert.strictEqual(footer.record_type, 'footer');
  assert.strictEqual(footer.complete, true);
  assert.deepStrictEqual(footer.issues, []);
  const lines = raw.toString('utf8').trimEnd().split('\n');
  const precedingBytes = Buffer.from(`${lines.slice(0, -1).join('\n')}\n`);
  assert.strictEqual(
    footer.records_sha256,
    createHash('sha256').update(precedingBytes).digest('hex')
  );
}

it(
  'exports provider-neutral prompts, ledger records, and exact raw task-log bytes',
  withLogWorkspace('zeroshot-trace-', (root, logRoot) => {
    const fixtures = [
      ['task-pi', 'pi', 'pi prompt\nwith unicode π', Buffer.from([0, 255, 10, 13, 123, 125])],
      ['task-codex', 'codex', 'codex prompt', Buffer.from('{"type":"result"}\n')],
      ['task-claude', 'claude', 'claude prompt', Buffer.from('{"type":"assistant"}\n')],
    ];
    const tasks = new Map();
    for (const [taskId, provider, prompt, output] of fixtures) {
      const logFile = path.join(logRoot, `${taskId}.log`);
      fs.writeFileSync(logFile, output);
      tasks.set(taskId, traceTask(taskId, provider, prompt, logFile));
    }
    const messages = fixtures.map(([taskId], index) =>
      lifecycle(index + 1, taskId, `agent-${index}`)
    );
    const first = path.join(root, 'first.trace.jsonl');
    const second = path.join(root, 'second.trace.jsonl');
    const options = {
      ledger: fakeLedger(messages),
      clusterId: 'trace-cluster',
      readTask: (taskId) => tasks.get(taskId) || null,
      allowedLogRoot: logRoot,
    };
    streamClusterTraceExport({ ...options, outputPath: first });
    streamClusterTraceExport({ ...options, outputPath: second });

    assert.deepStrictEqual(fs.readFileSync(first), fs.readFileSync(second));
    assert.strictEqual(fs.statSync(first).mode & 0o777, 0o600);
    const raw = fs.readFileSync(first);
    const records = parseRecords(first);
    assert.deepStrictEqual(records[0], {
      record_type: 'header',
      schema_version: 'zeroshot.trace.v1',
      media_type: 'application/x-zeroshot-trace+jsonl',
      cluster_id: 'trace-cluster',
      chunk_bytes: TRACE_OUTPUT_CHUNK_BYTES,
    });
    assert.deepStrictEqual(
      records.filter((record) => record.record_type === 'ledger_message').map((row) => row.message),
      messages
    );
    const exportedTasks = records.filter((record) => record.record_type === 'task');
    assert.deepStrictEqual(
      exportedTasks.map((record) => record.task_id),
      ['task-claude', 'task-codex', 'task-pi']
    );
    assert.deepStrictEqual(
      exportedTasks.map((record) => record.provider),
      ['claude', 'codex', 'pi']
    );
    assert.ok(
      exportedTasks.every((record) => record.prompt === tasks.get(record.task_id).fullPrompt)
    );
    for (const [taskId, , , output] of fixtures) {
      assert.deepStrictEqual(taskOutput(records, taskId), output);
      const end = records.find(
        (record) => record.record_type === 'task_output_end' && record.task_id === taskId
      );
      assert.strictEqual(end.complete, true);
      assert.strictEqual(end.byte_length, output.length);
      assert.strictEqual(end.sha256, createHash('sha256').update(output).digest('hex'));
    }
    assert.strictEqual(raw.includes(Buffer.from(logRoot)), false);
    assertBundleDigest(raw, records);
  })
);

it(
  'chunks large output and reports missing task evidence without pretending completeness',
  withLogWorkspace('zeroshot-trace-', (root, logRoot) => {
    const largeId = 'task-large';
    const missingLogId = 'task-missing-log';
    const missingTaskId = 'task-missing-row';
    const largeOutput = Buffer.alloc(TRACE_OUTPUT_CHUNK_BYTES * 2 + 17, 0xab);
    const largeLog = path.join(logRoot, `${largeId}.log`);
    fs.writeFileSync(largeLog, largeOutput);
    const missingLog = path.join(logRoot, `${missingLogId}.log`);
    const tasks = new Map([
      [largeId, traceTask(largeId, 'pi', 'large prompt', largeLog)],
      [missingLogId, traceTask(missingLogId, 'claude', 'legacy fallback', missingLog)],
    ]);
    tasks.get(missingLogId).fullPrompt = null;
    const outputPath = path.join(root, 'incomplete.trace.jsonl');
    const ledger = fakeLedger([
      lifecycle(1, largeId, 'large-agent'),
      lifecycle(2, missingLogId, 'missing-log-agent'),
      lifecycle(3, missingTaskId, 'missing-row-agent'),
    ]);
    assert.throws(
      () =>
        streamClusterTraceExport({
          ledger,
          clusterId: 'trace-cluster',
          readTask: (taskId) => tasks.get(taskId) || null,
          allowedLogRoot: logRoot,
          outputPath: largeLog,
        }),
      /cannot replace a source task log/
    );
    assert.deepStrictEqual(fs.readFileSync(largeLog), largeOutput);
    streamClusterTraceExport({
      ledger,
      clusterId: 'trace-cluster',
      readTask: (taskId) => tasks.get(taskId) || null,
      allowedLogRoot: logRoot,
      outputPath,
    });

    const records = parseRecords(outputPath);
    assert.deepStrictEqual(taskOutput(records, largeId), largeOutput);
    const chunks = records.filter(
      (record) => record.record_type === 'task_output_chunk' && record.task_id === largeId
    );
    assert.deepStrictEqual(
      chunks.map((record) => Buffer.from(record.data_base64, 'base64').length),
      [TRACE_OUTPUT_CHUNK_BYTES, TRACE_OUTPUT_CHUNK_BYTES, 17]
    );
    assert.strictEqual(
      records.find((record) => record.record_type === 'task' && record.task_id === missingLogId)
        .prompt,
      'legacy fallback'
    );
    assert.deepStrictEqual(records.at(-1).issues, [
      `task:${missingLogId}:log_missing`,
      `task:${missingTaskId}:task_row_missing`,
    ]);
  })
);
