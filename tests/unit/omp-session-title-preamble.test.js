const assert = require('node:assert/strict');
const fs = require('node:fs');

const { verifyExistingOmpPartition } = require('../../src/omp-session-verifier');
const {
  makeBlobStore,
  makeSessionPartition,
  makeStorageRoot,
  withEnv,
} = require('../helpers/omp-session-fixtures');

describe('OMP session title preamble', function () {
  it('accepts the title metadata record emitted before the OMP 17.2.1 session header', function () {
    const storageRoot = makeStorageRoot('omp-title-preamble-');
    const blobs = makeBlobStore('omp-title-preamble-blobs-');
    const partition = makeSessionPartition({ storageRoot, sessionId: 'sess-titled' });
    const original = fs.readFileSync(partition.sessionFilePath, 'utf8');
    const title = {
      type: 'title',
      v: 1,
      title: 'Implement the customer workflow',
      updatedAt: '2026-08-12T13:56:49.891Z',
      pad: ' ',
    };
    fs.writeFileSync(partition.sessionFilePath, `${JSON.stringify(title)}\n${original}`);

    try {
      const verified = withEnv(blobs.env, () =>
        verifyExistingOmpPartition(partition.partitionPath, partition.sessionFileName)
      );
      assert.strictEqual(verified.sessionHeader.sessionId, 'sess-titled');
      assert.strictEqual(verified.sessionRecords, 2);
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
      fs.rmSync(blobs.blobRoot, { recursive: true, force: true });
    }
  });
});
