const { test } = require('node:test');
const {
  assert,
  assertNoPreNegotiationRpcChunk,
  assertProtocolError,
  chunkLine,
  classifyOmpRpcFrameType,
  decodeWhole,
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  encodeOmpRpcCommand,
  exactBoundaryPromptCommand,
  fillNegotiateCommandToExactBytes,
  HELPERS_DIR,
  multibyteUtf8PromptCommand,
  oneByteOverPromptCommand,
  path,
  readFixture,
  spawn,
  TEST_LIMITS,
  OmpRpcFrameDecoder,
} = require('../helpers/omp-rpc-protocol-harness');

test('finish() throws incomplete-physical-frame for an unterminated physical frame', () => {
  const decoder = new OmpRpcFrameDecoder(DEFAULT_OMP_RPC_DECODER_LIMITS);
  decoder.push(Buffer.from('{"type":"ping"}'));
  assertProtocolError(() => decoder.finish(), 'incomplete-physical-frame');
});

test('finish() throws incomplete-chunk-sequence for a still-pending rpc_chunk sequence', () => {
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoder.push(
    Buffer.from(chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength: 10, data: 'AAAA' }))
  );
  assertProtocolError(() => decoder.finish(), 'incomplete-chunk-sequence');
});

test('push() after finish() throws decoder-finished', () => {
  const decoder = new OmpRpcFrameDecoder(DEFAULT_OMP_RPC_DECODER_LIMITS);
  decoder.push(Buffer.from('{"type":"ping"}\n'));
  decoder.finish();
  assertProtocolError(() => decoder.push(Buffer.from('{"type":"ping"}\n')), 'decoder-finished');
});

test('physical-frame-too-large: a single line exceeding maxPhysicalFrameBytes throws', () => {
  const limits = { ...DEFAULT_OMP_RPC_DECODER_LIMITS, maxPhysicalFrameBytes: 32 };
  const decoder = new OmpRpcFrameDecoder(limits);
  const oversizedLine = `${JSON.stringify({ type: 'ping', padding: 'x'.repeat(64) })}\n`;
  assertProtocolError(() => decoder.push(Buffer.from(oversizedLine)), 'physical-frame-too-large');
});

test('malformed-physical-frame: raw non-JSON text, truncated JSON, and bare JSON scalars', () => {
  const cases = [
    'not json at all\n',
    '{"type":"response","id":"req_1"\n',
    '"just a string"\n',
    '42\n',
  ];
  for (const line of cases) {
    const decoder = new OmpRpcFrameDecoder(DEFAULT_OMP_RPC_DECODER_LIMITS);
    assertProtocolError(() => decoder.push(Buffer.from(line)), 'malformed-physical-frame');
  }
});

// (f) classification + pre-negotiation guard.
test('classifyOmpRpcFrameType classifies known-pre-negotiation, v2-only, and unknown types', () => {
  assert.equal(classifyOmpRpcFrameType('ready'), 'known-pre-negotiation');
  assert.equal(classifyOmpRpcFrameType('available_commands_update'), 'known-pre-negotiation');
  assert.equal(classifyOmpRpcFrameType('response'), 'known-pre-negotiation');
  assert.equal(classifyOmpRpcFrameType('agent_end'), 'known-pre-negotiation');
  assert.equal(classifyOmpRpcFrameType('subagent_event'), 'known-pre-negotiation');
  assert.equal(classifyOmpRpcFrameType('rpc_chunk'), 'v2-only');
  assert.equal(classifyOmpRpcFrameType('totally_unrecognized_type'), 'unknown');
});

test('assertNoPreNegotiationRpcChunk rejects rpc_chunk before negotiation, allows it after', () => {
  assertProtocolError(
    () => assertNoPreNegotiationRpcChunk('rpc_chunk', false),
    'pre-negotiation-rpc-chunk'
  );
  assert.doesNotThrow(() => assertNoPreNegotiationRpcChunk('rpc_chunk', true));
  assert.doesNotThrow(() => assertNoPreNegotiationRpcChunk('ready', false));
});

// (g) encodeOmpRpcCommand: exact-boundary, one-byte-over, and multibyte UTF-8, for two distinct
// outbound-object shapes (prompt and negotiate_protocol).
for (const [label, exactCommand, overCommand] of [
  ['prompt', exactBoundaryPromptCommand, oneByteOverPromptCommand],
  [
    'negotiate_protocol',
    (maxFrameBytes) => fillNegotiateCommandToExactBytes(maxFrameBytes),
    (maxFrameBytes) => fillNegotiateCommandToExactBytes(maxFrameBytes + 1),
  ],
]) {
  test(`encodeOmpRpcCommand (${label}): exact boundary returns exactly maxFrameBytes bytes`, () => {
    const maxFrameBytes = 2048;
    const encoded = encodeOmpRpcCommand(exactCommand(maxFrameBytes), maxFrameBytes);
    assert.ok(Buffer.isBuffer(encoded));
    assert.equal(encoded.byteLength, maxFrameBytes);
    assert.equal(encoded[encoded.byteLength - 1], 0x0a);
  });

  test(`encodeOmpRpcCommand (${label}): one byte over throws outbound-frame-too-large`, () => {
    const maxFrameBytes = 2048;
    assertProtocolError(
      () => encodeOmpRpcCommand(overCommand(maxFrameBytes), maxFrameBytes),
      'outbound-frame-too-large'
    );
  });
}

test('encodeOmpRpcCommand: multibyte UTF-8 boundary uses byte length, not string length', () => {
  const maxFrameBytes = 2048;
  const command = multibyteUtf8PromptCommand(maxFrameBytes);
  const encoded = encodeOmpRpcCommand(command, maxFrameBytes);
  assert.equal(encoded.byteLength, maxFrameBytes);
  assert.ok(command.message.length < maxFrameBytes / 2);
});

// (h) spawn the fake OMP RPC process and prove real OS pipe chunking round-trips identically.
test('fake-omp-rpc.js stdout reproduces the negotiate-v2 fixture frames', async () => {
  const expectedFrames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('negotiate-v2'));

  const child = spawn(process.execPath, [path.join(HELPERS_DIR, 'fake-omp-rpc.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const decoder = new OmpRpcFrameDecoder(DEFAULT_OMP_RPC_DECODER_LIMITS);
  const frames = [];
  child.stdout.on('data', (chunk) => {
    frames.push(...decoder.push(chunk));
  });

  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  child.stdin.write(
    encodeOmpRpcCommand({ id: 'protocol-1', type: 'negotiate_protocol', protocolVersion: 2 }, 1024)
  );
  child.stdin.end();

  const exitCode = await closed;
  decoder.finish();
  assert.equal(exitCode, 0);
  assert.deepStrictEqual(frames, expectedFrames);
});
