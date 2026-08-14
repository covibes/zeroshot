const assert = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SEMANTIC_EXPORT_BOUNDS, streamClusterSemanticExport } = require('../cli/semantic-export');
const {
  fakeLedger,
  lifecycle,
  parseRecords,
  withLogWorkspace,
} = require('./helpers/cluster-export-fixtures');
const {
  expectedSemanticEvents,
  PI_USAGE,
  semanticFixture,
  semanticTask,
  timestamped,
} = require('./helpers/semantic-export-fixtures');

function assertSemanticBundleDigest(raw, records) {
  const lines = raw.toString('utf8').trimEnd().split('\n');
  const footer = records.at(-1);
  assert.strictEqual(footer.preceding_records, lines.length - 1);
  assert.strictEqual(
    footer.records_sha256,
    createHash('sha256')
      .update(Buffer.from(`${lines.slice(0, -1).join('\n')}\n`))
      .digest('hex')
  );
}

function assertTaskProjection(records, taskId, provider, output) {
  const record = records.find(
    (candidate) => candidate.record_type === 'task' && candidate.task_id === taskId
  );
  assert.strictEqual(record.adapter_id, provider);
  assert.strictEqual(record.prompt, `exact prompt for ${taskId}`);
  assert.strictEqual(record.raw_output_sha256, createHash('sha256').update(output).digest('hex'));
  const events = records.filter(
    (candidate) => candidate.record_type === 'event' && candidate.task_id === taskId
  );
  assert.ok(events.every((event) => event.raw_output_sha256 === record.raw_output_sha256));
  if (taskId !== 'task-pi-finish') {
    assert.deepStrictEqual(
      events.map((event) => event.event),
      expectedSemanticEvents(provider)
    );
  }
}

it(
  'projects Codex, Claude, and stateful Pi through the provider-neutral event union',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const fixtures = [
      ['task-pi', 'pi', semanticFixture('pi')],
      ['task-codex', 'codex', semanticFixture('codex')],
      ['task-claude', 'claude', semanticFixture('claude')],
      [
        'task-pi-finish',
        'pi',
        timestamped([
          {
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'finish me' }],
              usage: PI_USAGE,
              stopReason: 'stop',
            },
          },
        ]),
      ],
    ];
    const tasks = new Map();
    for (const [taskId, provider, output] of fixtures) {
      const logFile = path.join(logRoot, `${taskId}.log`);
      fs.writeFileSync(logFile, output);
      tasks.set(taskId, semanticTask(taskId, provider, logFile));
    }
    const ledger = fakeLedger(
      fixtures.map(([taskId], index) => lifecycle(index + 1, taskId, `agent-${index}`))
    );
    const first = path.join(root, 'first.semantic.jsonl');
    const second = path.join(root, 'second.semantic.jsonl');
    const options = {
      ledger,
      clusterId: 'semantic-cluster',
      readTask: (taskId) => tasks.get(taskId) || null,
      allowedLogRoot: logRoot,
    };
    streamClusterSemanticExport({ ...options, outputPath: first });
    streamClusterSemanticExport({ ...options, outputPath: second });

    assert.deepStrictEqual(fs.readFileSync(first), fs.readFileSync(second));
    assert.strictEqual(fs.statSync(first).mode & 0o777, 0o600);
    const raw = fs.readFileSync(first);
    const records = parseRecords(first);
    assert.strictEqual(records[0].schema_version, 'zeroshot.semantic.v1');
    for (const [taskId, provider, output] of fixtures) {
      assertTaskProjection(records, taskId, provider, output);
    }
    const eventTypes = new Set(
      records.filter((record) => record.record_type === 'event').map((record) => record.event.type)
    );
    assert.deepStrictEqual(
      [...eventTypes].sort(),
      ['result', 'text', 'thinking', 'tool_call', 'tool_result'].sort()
    );
    const lineEvent = records.find(
      (record) => record.record_type === 'event' && record.derivation === 'line'
    );
    assert.strictEqual(lineEvent.source.line_number, 2);
    assert.ok(lineEvent.source.byte_start > 0);
    const finishEvent = records.find(
      (record) => record.task_id === 'task-pi-finish' && record.derivation === 'finish'
    );
    assert.strictEqual(finishEvent.event.success, false);
    assert.match(finishEvent.event.error, /stdout ended before agent_settled/);
    assert.strictEqual(records.at(-1).complete, true);
    assertSemanticBundleDigest(raw, records);
    assert.strictEqual(raw.includes(Buffer.from(logRoot)), false);
  })
);

it(
  'reports malformed, unknown, oversized, and mismatched evidence without provider calls',
  withLogWorkspace('zeroshot-semantic-', (root, logRoot) => {
    const ids = {
      unknown: 'task-unknown',
      noProvider: 'task-missing-provider',
      malformed: 'task-malformed',
      oversized: 'task-oversized',
      wide: 'task-wide-event',
      deep: 'task-deep-event',
      mismatched: 'task-mismatched',
    };
    let deepInput = {};
    for (let depth = 0; depth < SEMANTIC_EXPORT_BOUNDS.maxValueDepth + 2; depth++) {
      deepInput = { nested: deepInput };
    }
    const outputs = new Map([
      [ids.unknown, 'opaque provider output\n'],
      [ids.noProvider, 'provider was not recorded\n'],
      [ids.malformed, timestamped([]) + '[1800000000123]{not-json\n'],
      [ids.oversized, `${'x'.repeat(SEMANTIC_EXPORT_BOUNDS.maxLineBytes + 1)}\n`],
      [
        ids.wide,
        timestamped([
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'x'.repeat(SEMANTIC_EXPORT_BOUNDS.maxStringBytes + 1),
            },
          },
        ]),
      ],
      [
        ids.deep,
        timestamped([
          {
            type: 'item.completed',
            item: { type: 'function_call', id: 'deep', name: 'deep', arguments: deepInput },
          },
        ]),
      ],
      [ids.mismatched, semanticFixture('codex')],
    ]);
    const tasks = new Map();
    for (const [taskId, output] of outputs) {
      const provider = taskId === ids.unknown ? 'not-a-provider' : 'codex';
      const logFile = path.join(logRoot, `${taskId}.log`);
      fs.writeFileSync(logFile, output);
      tasks.set(taskId, semanticTask(taskId, provider, logFile));
    }
    tasks.get(ids.noProvider).provider = null;
    tasks.get(ids.oversized).provider = 'pi';
    tasks.get(ids.mismatched).id = 'different-id';
    const outputPath = path.join(root, 'issues.semantic.jsonl');
    streamClusterSemanticExport({
      ledger: fakeLedger(
        [...outputs.keys()].map((taskId, index) => lifecycle(index + 1, taskId, `agent-${index}`))
      ),
      clusterId: 'semantic-cluster',
      readTask: (taskId) => tasks.get(taskId) || null,
      allowedLogRoot: logRoot,
      outputPath,
    });
    const records = parseRecords(outputPath);
    const codes = new Set(
      records.filter((record) => record.record_type === 'diagnostic').map((record) => record.code)
    );
    for (const code of [
      'unknown_provider',
      'malformed_json',
      'line_too_large',
      'event_string_too_large',
      'event_shape_too_deep',
      'task_row_identity_mismatch',
    ]) {
      assert.ok(codes.has(code), code);
    }
    assert.strictEqual(records.at(-1).complete, false);
  })
);
