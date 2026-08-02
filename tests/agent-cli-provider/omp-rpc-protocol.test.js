const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  OMP_SUPPORTED_VERSION,
  OMP_RELEASE_ASSETS,
  findOmpReleaseAsset,
  ompReleaseAssetDownloadUrl,
} = require('../../lib/agent-cli-provider/omp-release');
const {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  OmpRpcFrameDecoder,
  OmpRpcProtocolError,
  assertNoPreNegotiationRpcChunk,
  classifyOmpRpcFrameType,
  encodeOmpRpcCommand,
} = require('../../lib/agent-cli-provider/omp-rpc-protocol');
const {
  exactBoundaryPromptCommand,
  multibyteUtf8PromptCommand,
  oneByteOverPromptCommand,
} = require('../helpers/omp-rpc-boundary-vectors');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'omp-rpc');
const HELPERS_DIR = path.join(__dirname, '..', 'helpers');

function fixturePath(name) {
  return path.join(FIXTURES_DIR, `${name}.jsonl`);
}

function readFixture(name) {
  return fs.readFileSync(fixturePath(name));
}

function decodeWhole(limits, buffer) {
  const decoder = new OmpRpcFrameDecoder(limits);
  const frames = [...decoder.push(buffer)];
  decoder.finish();
  return frames;
}

function decodeSplit(limits, buffer, chunkSize) {
  const decoder = new OmpRpcFrameDecoder(limits);
  const frames = [];
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    frames.push(...decoder.push(buffer.subarray(offset, offset + chunkSize)));
  }
  decoder.finish();
  return frames;
}

function assertProtocolError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OmpRpcProtocolError, `expected OmpRpcProtocolError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const HAPPY_PATH_SCENARIOS = [
  'negotiate-v2',
  'request-response',
  'event-before-ack',
  'same-id-late-failure',
  'lifecycle-continuation',
  'compacted-agent-end',
  'chunked-response',
  'extension-ui-request',
  'stderr-emission.stdout',
  'early-shutdown',
  'extension-shutdown',
];

// (a) omp-release exports.
test('omp-release exports OMP_SUPPORTED_VERSION 17.2.1', () => {
  assert.equal(OMP_SUPPORTED_VERSION, '17.2.1');
});

test('omp-release exports exactly 6 Unix assets with the verified digests', () => {
  assert.equal(OMP_RELEASE_ASSETS.length, 6);
  const byPlatform = new Map(OMP_RELEASE_ASSETS.map((asset) => [asset.platform, asset]));
  assert.deepEqual(
    Object.fromEntries(
      [...byPlatform.entries()].map(([platform, asset]) => [platform, asset.sha256])
    ),
    {
      'darwin-arm64': 'b75eddb19ba9ec401fee5ecb35b3ceb5ddc48708e98b5a113136df5d65f2bed8',
      'darwin-x64': 'd23c197d93243122ef9a35a247bdd85075c4c1356dd1fa4a080faaa2dae4b905',
      'linux-arm64': 'd34883744bb54476f7268aad4b561ea9b1cd826f201d044b337c5a96713fa83d',
      'linux-musl-arm64': '3babfe15664f32fcc03dc91d92a10341baf6e65b9868351de21c5aa3218e139d',
      'linux-musl-x64': '8f05f7eed2940b11c29d7aaf0e641b100c014db5bfbee00afa5dd4929ad5dd6a',
      'linux-x64': 'ac0285a571aa79c58d59482561a3871befe7333dba3a3bdc2e90682653ee33b2',
    }
  );
  for (const asset of OMP_RELEASE_ASSETS) {
    assert.equal(asset.sha256.length, 64);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
});

test('findOmpReleaseAsset / ompReleaseAssetDownloadUrl resolve by platform', () => {
  const asset = findOmpReleaseAsset('linux-x64');
  assert.ok(asset);
  assert.equal(asset.name, 'omp-linux-x64');
  assert.equal(
    ompReleaseAssetDownloadUrl(asset),
    'https://github.com/can1357/oh-my-pi/releases/download/v17.2.1/omp-linux-x64'
  );
  assert.equal(findOmpReleaseAsset('windows-x64'), undefined);
});

// (b) decoder happy path per fixture scenario, fed whole-buffer and split at 1-byte/3-byte
// granularities, asserting identical output every time.
for (const scenario of HAPPY_PATH_SCENARIOS) {
  test(`OmpRpcFrameDecoder decodes ${scenario}.jsonl identically at every read granularity`, () => {
    const buffer = readFixture(scenario);
    const whole = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, buffer);
    const split1 = decodeSplit(DEFAULT_OMP_RPC_DECODER_LIMITS, buffer, 1);
    const split3 = decodeSplit(DEFAULT_OMP_RPC_DECODER_LIMITS, buffer, 3);
    assert.ok(whole.length > 0);
    assert.deepStrictEqual(split1, whole);
    assert.deepStrictEqual(split3, whole);
  });
}

test('same-id-late-failure.jsonl: decoder does not reject a second same-id response', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('same-id-late-failure'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 'req_2');
  assert.equal(frames[1].id, 'req_2');
  assert.equal(frames[0].success, true);
  assert.equal(frames[1].success, false);
});

test('chunked-response.jsonl reassembles into one response frame with the expected shape', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('chunked-response'));
  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.equal(frame.type, 'response');
  assert.equal(frame.command, 'get_messages_page');
  assert.equal(frame.success, true);
  assert.equal(frame.data.totalMessages, 40);
  assert.equal(frame.data.messages.length, 40);
});

test('lifecycle-continuation.jsonl preserves willContinue across turns', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('lifecycle-continuation'));
  const agentEnds = frames.filter((frame) => frame.type === 'agent_end');
  assert.equal(agentEnds.length, 2);
  assert.equal(agentEnds[0].willContinue, true);
  assert.equal(agentEnds[1].willContinue, undefined);
});

test('compacted-agent-end.jsonl carries messageCount without re-streaming the message', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('compacted-agent-end'));
  const agentEnd = frames.find((frame) => frame.type === 'agent_end');
  assert.ok(agentEnd);
  assert.deepEqual(agentEnd.messages, []);
  assert.equal(agentEnd.messageCount, 1);
});

test('stderr-emission fixtures: the stderr file is plain text the codec never parses', () => {
  const stderrText = fs.readFileSync(path.join(FIXTURES_DIR, 'stderr-emission.stderr.txt'), 'utf8');
  assert.throws(() => JSON.parse(stderrText.split('\n')[0]));
  const stdoutFrames = decodeWhole(
    DEFAULT_OMP_RPC_DECODER_LIMITS,
    readFixture('stderr-emission.stdout')
  );
  assert.ok(stdoutFrames.every((frame) => typeof frame.type === 'string'));
});

// (c)/(d) chunk validation error codes, using tight limits so misbehavior is easy to trigger
// without multi-hundred-KB fixtures.
const TEST_LIMITS = {
  maxPhysicalFrameBytes: 65536,
  maxReassembledFrameBytes: 4096,
  maxConcurrentReassemblies: 1,
  maxChunksPerFrame: 8,
  maxInflightReassemblyBytes: 4096,
};

function chunkLine(overrides) {
  return `${JSON.stringify({ type: 'rpc_chunk', ...overrides })}\n`;
}

function twoChunkPayload(jsonText) {
  const bytes = Buffer.from(jsonText, 'utf8');
  const half = Math.max(1, Math.ceil(bytes.byteLength / 2));
  const first = bytes.subarray(0, half);
  const second = bytes.subarray(half);
  return { byteLength: bytes.byteLength, first, second };
}

test('invalid-chunk-metadata: missing/empty/oversized chunkId', () => {
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  assertProtocolError(
    () =>
      decoder.push(Buffer.from(chunkLine({ index: 0, count: 2, byteLength: 10, data: 'AAAA' }))),
    'invalid-chunk-metadata'
  );
  const decoder2 = new OmpRpcFrameDecoder(TEST_LIMITS);
  assertProtocolError(
    () =>
      decoder2.push(
        Buffer.from(chunkLine({ chunkId: '', index: 0, count: 2, byteLength: 10, data: 'AAAA' }))
      ),
    'invalid-chunk-metadata'
  );
  const decoder3 = new OmpRpcFrameDecoder(TEST_LIMITS);
  assertProtocolError(
    () =>
      decoder3.push(
        Buffer.from(
          chunkLine({ chunkId: 'x'.repeat(129), index: 0, count: 2, byteLength: 10, data: 'AAAA' })
        )
      ),
    'invalid-chunk-metadata'
  );
});

test('invalid-chunk-metadata: bad index/count/byteLength combinations', () => {
  const cases = [
    { chunkId: 'c1', index: -1, count: 2, byteLength: 10, data: 'AAAA' },
    { chunkId: 'c1', index: 0, count: 1, byteLength: 10, data: 'AAAA' },
    {
      chunkId: 'c1',
      index: 0,
      count: TEST_LIMITS.maxChunksPerFrame + 1,
      byteLength: 10,
      data: 'AAAA',
    },
    { chunkId: 'c1', index: 2, count: 2, byteLength: 10, data: 'AAAA' },
    { chunkId: 'c1', index: 0, count: 2, byteLength: 0, data: 'AAAA' },
    {
      chunkId: 'c1',
      index: 0,
      count: 2,
      byteLength: TEST_LIMITS.maxReassembledFrameBytes + 1,
      data: 'AAAA',
    },
    { chunkId: 'c1', index: 0.5, count: 2, byteLength: 10, data: 'AAAA' },
  ];
  for (const testCase of cases) {
    const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
    assertProtocolError(
      () => decoder.push(Buffer.from(chunkLine(testCase))),
      'invalid-chunk-metadata'
    );
  }
});

test('invalid-chunk-data: non-string, empty, non-base64, and non-canonical base64', () => {
  const badData = [42, '', 'not-base64!!', 'AAAAA', 'AA=A'];
  for (const data of badData) {
    const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
    assertProtocolError(
      () =>
        decoder.push(
          Buffer.from(chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength: 10, data }))
        ),
      'invalid-chunk-data'
    );
  }
});

test('chunk-sequence-must-start-at-zero: first-seen chunkId with index != 0', () => {
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(chunkLine({ chunkId: 'c1', index: 1, count: 2, byteLength: 10, data: 'AAAA' }))
      ),
    'chunk-sequence-must-start-at-zero'
  );
});

test('chunk-sequence-mismatch: wrong count/byteLength and out-of-order/duplicate index', () => {
  const { byteLength, first } = twoChunkPayload(
    '{"type":"response","command":"noop","success":true}'
  );

  const decoderCount = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoderCount.push(
    Buffer.from(
      chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength, data: first.toString('base64') })
    )
  );
  assertProtocolError(
    () =>
      decoderCount.push(
        Buffer.from(
          chunkLine({
            chunkId: 'c1',
            index: 1,
            count: 3,
            byteLength,
            data: first.toString('base64'),
          })
        )
      ),
    'chunk-sequence-mismatch'
  );

  const decoderDuplicate = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoderDuplicate.push(
    Buffer.from(
      chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength, data: first.toString('base64') })
    )
  );
  assertProtocolError(
    () =>
      decoderDuplicate.push(
        Buffer.from(
          chunkLine({
            chunkId: 'c1',
            index: 0,
            count: 2,
            byteLength,
            data: first.toString('base64'),
          })
        )
      ),
    'chunk-sequence-mismatch'
  );
});

test('chunk-sequence-exceeds-declared-length: chunk carries more bytes than declared', () => {
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  const oversizedData = Buffer.from(
    'this payload is longer than the declared byteLength',
    'utf8'
  ).toString('base64');
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(
          chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength: 5, data: oversizedData })
        )
      ),
    'chunk-sequence-exceeds-declared-length'
  );
});

test('chunk-sequence-length-mismatch: final chunk total is short of declared byteLength', () => {
  const { first, second } = twoChunkPayload('{"type":"response","command":"noop","success":true}');
  const inflatedByteLength = first.byteLength + second.byteLength + 2;
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoder.push(
    Buffer.from(
      chunkLine({
        chunkId: 'c1',
        index: 0,
        count: 2,
        byteLength: inflatedByteLength,
        data: first.toString('base64'),
      })
    )
  );
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(
          chunkLine({
            chunkId: 'c1',
            index: 1,
            count: 2,
            byteLength: inflatedByteLength,
            data: second.toString('base64'),
          })
        )
      ),
    'chunk-sequence-length-mismatch'
  );
});

test('malformed-json-in-reassembled-frame: reassembled bytes are not valid JSON', () => {
  const { byteLength, first, second } = twoChunkPayload('{"type":"response", not valid json');
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoder.push(
    Buffer.from(
      chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength, data: first.toString('base64') })
    )
  );
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(
          chunkLine({
            chunkId: 'c1',
            index: 1,
            count: 2,
            byteLength,
            data: second.toString('base64'),
          })
        )
      ),
    'malformed-json-in-reassembled-frame'
  );
});

test('non-object-reassembled-frame: reassembled bytes parse to a non-object JSON value', () => {
  const { byteLength, first, second } = twoChunkPayload('"just a plain string, not an object"');
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoder.push(
    Buffer.from(
      chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength, data: first.toString('base64') })
    )
  );
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(
          chunkLine({
            chunkId: 'c1',
            index: 1,
            count: 2,
            byteLength,
            data: second.toString('base64'),
          })
        )
      ),
    'non-object-reassembled-frame'
  );
});

test('inflight-reassembly-bytes-exceeded: decoded chunk bytes exceed the inflight cap', () => {
  const limits = { ...TEST_LIMITS, maxInflightReassemblyBytes: 4 };
  const decoder = new OmpRpcFrameDecoder(limits);
  const data = Buffer.from('this is well over four bytes', 'utf8').toString('base64');
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength: 100, data }))
      ),
    'inflight-reassembly-bytes-exceeded'
  );
});

// (d) interleaving and interruption.
test('interleaved-chunk-sequence: a second chunkId while one is pending exceeds maxConcurrentReassemblies', () => {
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoder.push(
    Buffer.from(chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength: 10, data: 'AAAA' }))
  );
  assertProtocolError(
    () =>
      decoder.push(
        Buffer.from(chunkLine({ chunkId: 'c2', index: 0, count: 2, byteLength: 10, data: 'AAAA' }))
      ),
    'interleaved-chunk-sequence'
  );
});

test('interrupted-chunk-sequence: a non-chunk frame arrives while a sequence is pending', () => {
  const decoder = new OmpRpcFrameDecoder(TEST_LIMITS);
  decoder.push(
    Buffer.from(chunkLine({ chunkId: 'c1', index: 0, count: 2, byteLength: 10, data: 'AAAA' }))
  );
  assertProtocolError(
    () => decoder.push(Buffer.from(`${JSON.stringify({ type: 'ping' })}\n`)),
    'interrupted-chunk-sequence'
  );
});

// (e) finish() edge cases.
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
function fillNegotiateCommandToExactBytes(targetBytes) {
  const base = { id: 'boundary-cmd', type: 'negotiate_protocol', protocolVersion: 2, note: '' };
  const baselineBytes = Buffer.byteLength(`${JSON.stringify({ ...base, note: '' })}\n`, 'utf8');
  if (targetBytes < baselineBytes) {
    throw new Error(
      `targetBytes ${targetBytes} is smaller than the unpadded command size ${baselineBytes}`
    );
  }
  const command = { ...base, note: 'a'.repeat(targetBytes - baselineBytes) };
  const actualBytes = Buffer.byteLength(`${JSON.stringify(command)}\n`, 'utf8');
  if (actualBytes !== targetBytes) {
    throw new Error(`Padding produced ${actualBytes} bytes, expected ${targetBytes}.`);
  }
  return command;
}

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
