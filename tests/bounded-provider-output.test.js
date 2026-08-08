const assert = require('assert');
const { createHash } = require('crypto');

const {
  appendContentToBuffer,
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
