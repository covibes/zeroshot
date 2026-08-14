'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeTaskRunner = require('../src/claude-task-runner');
const { parseTaskLogLine } = require('../cli/index');
const { streamClusterSemanticExport } = require('../cli/semantic-export');
const { decodeTaskLogLine } = require('../src/task-log-line');
const { parseProviderChunk } = require('../src/providers');
const { fakeLedger, lifecycle, parseRecords } = require('./helpers/cluster-export-fixtures');

const TIMESTAMP = 1_800_000_000_123;
const MARKER = `[${TIMESTAMP}][ZEROSHOT][LOG_FORMAT] channel-framed-v2`;
const STDOUT_PREFIX = `[${TIMESTAMP}][ZEROSHOT][PROVIDER_STDOUT] `;
const STDERR_PREFIX = `[${TIMESTAMP}][ZEROSHOT][PROVIDER_STDERR] `;

function taskCli(root, logPath) {
  const executable = path.join(root, 'zeroshot');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const action = process.argv[2];
if (action === 'get-log-path') process.stdout.write(${JSON.stringify(logPath)} + '\\n');
else if (action === 'status') process.stdout.write('Status: completed\\nCleanup: complete\\n');
`,
    { mode: 0o755 }
  );
  return executable;
}

function exportSdkRecords(logged, suffix, status) {
  const taskId = `sdk-task-${suffix}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-sdk-${suffix}-`));
  try {
    const logFile = path.join(root, `${taskId}.log`);
    const outputPath = path.join(root, `${suffix}.semantic.jsonl`);
    fs.writeFileSync(logFile, `${logged.join('')}\n${'='.repeat(50)}\n`);
    streamClusterSemanticExport({
      ledger: fakeLedger([lifecycle(1, taskId, 'sdk-agent')]),
      clusterId: `sdk-cluster-${suffix}`,
      readTask: () => ({
        id: taskId,
        fullPrompt: 'sdk prompt',
        status,
        provider: 'omp',
        model: 'openai/test',
        logFile,
      }),
      allowedLogRoot: root,
      outputPath,
    });
    return parseRecords(outputPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it('TaskRunner follows framed stdout without exposing JSON-shaped stderr', async function () {
  this.timeout(5_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-framed-task-runner-'));
  const logPath = path.join(root, 'task.log');
  const providerLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } });
  const fabricated = JSON.stringify({ type: 'turn.completed', usage: {} });
  fs.writeFileSync(
    logPath,
    `${MARKER}\n${STDOUT_PREFIX}${providerLine}\n${STDERR_PREFIX}${fabricated}\n`
  );
  const streamed = [];
  try {
    const runner = new ClaudeTaskRunner({
      quiet: true,
      timeout: 4_000,
      onOutput: (line) => streamed.push(line),
    });
    const result = await runner._followLogs(taskCli(root, logPath), 'task', 'agent');
    assert.equal(result.output, `${providerLine}\n`);
    assert.deepEqual(streamed, [providerLine]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('logs rendering parses framed JSON and preserves reserved-prefix stdout', async () => {
  const { parseLogLine } = await import('../task-lib/commands/logs.js');
  const providerLine = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'framed logs' },
  });
  assert.deepEqual(parseLogLine(`${STDOUT_PREFIX}${providerLine}`), [
    { type: 'text', text: 'framed logs' },
  ]);
  assert.deepEqual(parseLogLine(`${STDERR_PREFIX}${providerLine}`), []);
  assert.deepEqual(
    parseLogLine(`${STDOUT_PREFIX}[ZEROSHOT][PROVIDER_STDERR] genuine provider stdout`),
    [{ type: 'text', text: '[ZEROSHOT][PROVIDER_STDERR] genuine provider stdout\n' }]
  );
});

it('CLI task-log reconstruction accepts framed stdout only', () => {
  const providerLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } });
  assert.deepEqual(parseTaskLogLine(`${STDOUT_PREFIX}${providerLine}`), {
    timestamp: TIMESTAMP,
    jsonContent: providerLine,
  });
  assert.equal(parseTaskLogLine(`${STDERR_PREFIX}${providerLine}`), null);
  assert.equal(parseTaskLogLine(MARKER), null);
});

it('provider facade parses framed stdout without accepting stderr', () => {
  const providerLine = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'provider facade' },
  });
  assert.deepEqual(parseProviderChunk('codex', `${STDOUT_PREFIX}${providerLine}`), [
    { type: 'text', text: 'provider facade' },
  ]);
  assert.deepEqual(parseProviderChunk('codex', `${STDERR_PREFIX}${providerLine}`), []);
});

it('frames OMP SDK progress and its sole terminal event under a v2 marker', async () => {
  const { logSdkTerminal, markSdkTaskLog } = await import('../task-lib/sdk-watcher-output.js');
  const logged = [];
  let timestamp = 1_800_000_000_000;
  const log = (value) => logged.push(value);
  markSdkTaskLog(log, timestamp++);
  logSdkTerminal(
    log,
    {
      progress: [{ type: 'progress', sequence: 0, stage: 'running' }],
      terminal: {
        type: 'result',
        event: { type: 'result', success: true, result: 'done' },
      },
      diagnosticStderr: 'first diagnostic\nsecond diagnostic',
    },
    () => timestamp++
  );

  const lines = logged.join('').trimEnd().split('\n');
  assert.equal(decodeTaskLogLine(lines[0]).format, 'channel-framed-v2');
  const providerLines = lines.map(decodeTaskLogLine).filter((line) => line.providerOutput);
  assert.deepEqual(
    providerLines.map((line) => JSON.parse(line.content).type),
    ['progress', 'result']
  );
  const diagnostics = lines
    .map(decodeTaskLogLine)
    .filter((line) => line.channel === 'provider_stderr');
  assert.deepEqual(
    diagnostics.map((line) => line.content),
    ['first diagnostic', 'second diagnostic']
  );
  assert.ok(diagnostics.every((line) => !line.providerOutput));

  const records = exportSdkRecords(logged, 'success', 'completed');
  const events = records.filter((record) => record.record_type === 'event');
  assert.deepEqual(
    events.map((record) => record.event.type),
    ['result']
  );
  assert.equal(events[0].event.result, 'done');
  assert.equal(records.at(-1).complete, true);
});

it('normalizes OMP SDK error and cancellation terminals into one failed result', async () => {
  const { logSdkTerminal, markSdkTaskLog } = await import('../task-lib/sdk-watcher-output.js');
  const cases = [
    { category: 'provider', code: 'provider-error', status: 'failed' },
    { category: 'cancelled', code: 'cancelled', status: 'killed' },
  ];
  for (const item of cases) {
    const logged = [];
    let timestamp = 1_800_000_000_100;
    const log = (value) => logged.push(value);
    markSdkTaskLog(log, timestamp++);
    const error = {
      code: item.code,
      category: item.category,
      retryable: false,
      redacted: true,
    };
    logSdkTerminal(
      log,
      {
        progress: [],
        terminal: { type: 'error', frame: { type: 'error', error } },
        diagnosticStderr: `${item.category} diagnostic`,
      },
      () => timestamp++
    );

    const decoded = logged.join('').trimEnd().split('\n').map(decodeTaskLogLine);
    const providerEvents = decoded
      .filter((line) => line.channel === 'provider_stdout')
      .map((line) => JSON.parse(line.content));
    assert.deepEqual(providerEvents, [{ type: 'result', success: false, error }]);
    assert.deepEqual(
      decoded.filter((line) => line.channel === 'provider_stderr').map((line) => line.content),
      [`${item.category} diagnostic`]
    );

    const records = exportSdkRecords(logged, item.category, item.status);
    const semanticEvents = records.filter((record) => record.record_type === 'event');
    assert.equal(semanticEvents.length, 1);
    assert.deepEqual(semanticEvents[0].event, { type: 'result', success: false, error });
    assert.equal(records.at(-1).complete, true);
  }
});
