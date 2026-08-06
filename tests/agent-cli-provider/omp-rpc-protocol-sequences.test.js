const { test } = require('node:test');
const {
  OmpRpcFrameDecoder,
  TEST_LIMITS,
  assertProtocolError,
  chunkLine,
  twoChunkPayload,
} = require('../helpers/omp-rpc-protocol-harness');

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
