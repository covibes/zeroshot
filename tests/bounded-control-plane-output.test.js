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

it('replaces an oversized conductor record with a stable receipt', function () {
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

it('preserves isolated receipt hashes across split UTF-8 chunks', function () {
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
