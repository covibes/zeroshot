const { test } = require('node:test');
const {
  OmpRpcFrameDecoder,
  TEST_LIMITS,
  assertProtocolError,
  chunkLine,
  twoChunkPayload,
} = require('../helpers/omp-rpc-protocol-harness');

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
