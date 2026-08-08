const assert = require('assert');
const { createHash } = require('crypto');
const { StringDecoder } = require('string_decoder');

const {
  CONTROL_PLANE_OUTPUT_LIMITS,
  appendContentToBuffer,
  broadcastIsolatedLine,
  consumeIsolatedTailChunk,
  createIsolatedLogState,
  createLogRecordBuffer,
} = require('../src/agent/agent-task-executor');

describe('bounded provider output transport', function () {
  it('streams a large Codex JSONL record to the raw log without retaining it in the watcher', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const inspected = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'codex',
      log: (value) => logged.push(value),
      stopProvider() {},
      providerSessionCapture: {
        captureLine: (line) => inspected.push(line),
        getCompletionError: () => null,
        getCompletionUpdate: () => ({}),
      },
    });
    const largeText = `before-${'🙂'.repeat(300_000)}-after`;
    const records = [
      JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: largeText },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    ];
    const expected = `${records.join('\n')}\n`;
    const encoded = Buffer.from(expected);
    let buffer = '';
    for (let offset = 0; offset < encoded.length; offset += 4093) {
      buffer = runtime.consumeOutput(buffer, encoded.subarray(offset, offset + 4093));
      assert.strictEqual(buffer, '');
    }
    const completion = runtime.complete({ code: 0, signal: null, outputBuffer: buffer });

    const raw = logged.join('').replace(/^\[\d{13}\]/gm, '');
    const streamed = raw.slice(0, expected.length);
    assert.strictEqual(Buffer.byteLength(streamed), Buffer.byteLength(expected));
    assert.strictEqual(
      createHash('sha256').update(streamed).digest('hex'),
      createHash('sha256').update(expected).digest('hex')
    );
    assert.match(raw.slice(expected.length), /Finished:.*Exit code: 0, Signal: null/s);
    assert.deepStrictEqual(inspected, [records[0], records[2]]);
    assert.strictEqual(completion.status, 'completed');
  });
});

describe('bounded generic provider output transport', function () {
  it('streams oversized non-Codex stdout and stderr lines without cumulative buffering', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const inspected = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider() {},
      providerSessionCapture: {
        captureLine: (line) => inspected.push(line),
        getCompletionError: () => null,
        getCompletionUpdate: () => ({}),
      },
    });
    const stdout = `stdout-${'🙂'.repeat(300_000)}-end`;
    const stderr = `stderr-${'z'.repeat(2 * 1024 * 1024)}-end`;
    for (const [consume, value] of [
      [runtime.consumeOutput, stdout],
      [runtime.consumeStderr, stderr],
    ]) {
      const encoded = Buffer.from(`${value}\n`);
      let buffer = '';
      for (let offset = 0; offset < encoded.length; offset += 4093) {
        buffer = consume(buffer, encoded.subarray(offset, offset + 4093));
        assert.strictEqual(buffer, '');
      }
    }
    runtime.complete({ code: 0, signal: null, outputBuffer: '', stderrBuffer: '' });

    const raw = logged.join('').replace(/^\[\d{13}\]/gm, '');
    const expected = `${stdout}\n${stderr}\n`;
    const streamed = raw.slice(0, expected.length);
    assert.strictEqual(Buffer.byteLength(streamed), Buffer.byteLength(expected));
    assert.strictEqual(
      createHash('sha256').update(streamed).digest('hex'),
      createHash('sha256').update(expected).digest('hex')
    );
    assert.match(inspected[0], /omitted from watcher inspection/);
    assert.match(raw.slice(expected.length), /Finished:.*Exit code: 0, Signal: null/s);
  });
});

describe('bounded silent structured output transport', function () {
  it('preserves bounded Claude structured output larger than 64 KiB', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const runtime = createWatcherOutputRuntime({
      config: {
        outputFormat: 'json',
        jsonSchema: { type: 'object' },
        silentJsonOutput: true,
      },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider() {},
    });
    const record = JSON.stringify({
      structured_output: { summary: 's'.repeat(128 * 1024), result: 'complete' },
    });
    const encoded = Buffer.from(`${record}\n`);
    let buffer = '';
    for (let offset = 0; offset < encoded.length; offset += 4093) {
      buffer = runtime.consumeOutput(buffer, encoded.subarray(offset, offset + 4093));
    }
    const completion = runtime.complete({ code: 0, signal: null, outputBuffer: buffer });

    assert.strictEqual(logged.join(''), `${record}\n`);
    assert.strictEqual(completion.status, 'completed');
  });

  it('fails oversized silent structured output while preserving its raw bytes', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    let stopCalls = 0;
    const runtime = createWatcherOutputRuntime({
      config: {
        outputFormat: 'json',
        jsonSchema: { type: 'object' },
        silentJsonOutput: true,
      },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider: () => {
        stopCalls += 1;
      },
    });
    const record = JSON.stringify({ structured_output: { result: 'x'.repeat(2 * 1024 * 1024) } });
    const encoded = Buffer.from(`${record}\n`);
    let buffer = '';
    for (let offset = 0; offset < encoded.length; offset += 4093) {
      buffer = runtime.consumeOutput(buffer, encoded.subarray(offset, offset + 4093));
    }
    const completion = runtime.complete({ code: 0, signal: null, outputBuffer: buffer });

    const raw = logged.join('').replace(/^\[\d{13}\]/gm, '');
    assert.strictEqual(raw.slice(0, record.length + 1), `${record}\n`);
    assert.match(raw.slice(record.length + 1), /\[FATAL\].*inspection limit/);
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(completion.status, 'failed');
    assert.match(completion.error, /inspection limit/);
  });
});

describe('bounded control-plane record transport', function () {
  it('replaces an oversized conductor record with a stable receipt and resumes at the next line', function () {
    const timestamp = '[1777777777777]';
    const oversized = `${timestamp}${'x'.repeat(2 * 1024 * 1024)}`;
    const next = `${timestamp}{"type":"turn.completed"}`;
    const input = `${oversized}\n${next}\n`;
    const state = { lineBuffer: createLogRecordBuffer() };
    const lines = [];

    for (let offset = 0; offset < input.length; offset += 8191) {
      appendContentToBuffer(state, input.slice(offset, offset + 8191), (line) => lines.push(line));
    }

    const expectedDigest = createHash('sha256').update(oversized).digest('hex');
    assert.deepStrictEqual(lines, [
      `${timestamp}[ZEROSHOT] Provider output record retained in task log but omitted from the control plane ` +
        `(byte_length=${Buffer.byteLength(oversized)}, sha256=${expectedDigest})`,
      next,
    ]);
    assert.deepStrictEqual(state.lineBuffer, createLogRecordBuffer());
  });
});

describe('isolated bounded provider output transport', function () {
  it('preserves isolated receipt hashes when UTF-8 characters span stdout chunks', function () {
    const timestamp = '[1777777777777]';
    const oversized = `${timestamp}${'🙂'.repeat(300_000)}`;
    const next = `${timestamp}{"type":"turn.completed"}`;
    const input = `${oversized}\n${next}\n`;
    const encoded = Buffer.from(input);
    const state = createIsolatedLogState();
    state.tailDecoder = new StringDecoder('utf8');
    const lines = [];
    const published = [];
    const agent = {
      id: 'isolated-worker',
      iteration: 1,
      cluster: { id: 'cluster-1' },
      messageBus: { publish: (message) => published.push(message) },
    };

    for (let offset = 0; offset < encoded.length; offset += 4093) {
      consumeIsolatedTailChunk(state, encoded.subarray(offset, offset + 4093), (line) => {
        lines.push(line);
        broadcastIsolatedLine({ agent, providerName: 'codex', taskId: 'task-1', state, line });
      });
    }

    const expectedDigest = createHash('sha256').update(oversized).digest('hex');
    assert.deepStrictEqual(lines, [
      `${timestamp}[ZEROSHOT] Provider output record retained in task log but omitted from the control plane ` +
        `(byte_length=${Buffer.byteLength(oversized)}, sha256=${expectedDigest})`,
      next,
    ]);
    assert.match(state.fullOutput, /Provider output record retained in task log/);
    assert.match(state.fullOutput, /turn\.completed/);
    assert.ok(Buffer.byteLength(state.fullOutput) <= CONTROL_PLANE_OUTPUT_LIMITS.maxBytes);
    assert.strictEqual(published.length, 2);
  });
});
