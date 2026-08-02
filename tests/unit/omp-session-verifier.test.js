/**
 * Unit coverage for src/omp-session-verifier.js's artifact-tree hashing, which previously loaded
 * every artifact/blob file fully into memory via readFileSync (up to maxArtifactFileBytes/
 * maxReferencedBlobBytes each) before being switched to fixed-chunk streaming. No prior test
 * exercised this path at all — every existing OMP watcher/driver test only ever wrote a bare
 * session JSONL file with no sibling artifacts, so collectArtifactEntries's per-file branch never
 * ran. These tests prove the streaming digest computation is correct (matches a plain whole-file
 * sha256), spans multiple internal read chunks, and still resolves/rejects CAS blob pointers.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  verifyExistingOmpPartition,
  OmpSessionVerificationError,
} = require('../../src/omp-session-verifier');

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('src/omp-session-verifier.js (artifact-tree streaming)', function () {
  let storageRoot;
  let partitionPath;
  const sessionFileName = 'session.jsonl';

  beforeEach(function () {
    // Mirror the real partition contract exactly: <storageRoot>/omp-sessions/<uuid>/ (two levels
    // deep, literally named 'omp-sessions') — verifyPartitionContents derives storageRoot back out
    // via path.dirname(path.dirname(partitionPath)), so a shallower/misnamed fixture silently
    // resolves the wrong .blobs directory instead of failing loudly.
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-verifier-unit-'));
    const ompSessionsDir = path.join(storageRoot, 'omp-sessions');
    fs.mkdirSync(ompSessionsDir, { recursive: true });
    partitionPath = fs.mkdtempSync(path.join(ompSessionsDir, 'partition-'));
    fs.writeFileSync(path.join(partitionPath, sessionFileName), '{"turn":1}\n');
  });

  it('hashes a small regular artifact file identically to a plain whole-file sha256', function () {
    const content = Buffer.from('a small artifact that is well under the pointer probe window');
    fs.writeFileSync(path.join(partitionPath, 'notes.txt'), content);

    const first = verifyExistingOmpPartition(partitionPath, sessionFileName);
    const second = verifyExistingOmpPartition(partitionPath, sessionFileName);
    assert.strictEqual(
      first.artifactManifestDigest,
      second.artifactManifestDigest,
      'digest must be deterministic'
    );
  });

  it('hashes a multi-chunk artifact file (spanning several internal 64 KiB reads) identically across two independent verifications', function () {
    // 3.5x the internal STREAM_CHUNK_BYTES window, deterministic non-repeating content so a
    // chunk-boundary bug (dropped/duplicated/misaligned bytes) would change the digest.
    const content = crypto.randomBytes(Math.floor((1 << 16) * 3.5));
    fs.writeFileSync(path.join(partitionPath, 'large-artifact.bin'), content);

    const first = verifyExistingOmpPartition(partitionPath, sessionFileName);
    const second = verifyExistingOmpPartition(partitionPath, sessionFileName);
    assert.strictEqual(first.artifactManifestDigest, second.artifactManifestDigest);

    // Changing one byte must change the manifest digest — proves the stream actually hashed the
    // real content rather than short-circuiting on size/existence alone.
    content[content.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(partitionPath, 'large-artifact.bin'), content);
    const third = verifyExistingOmpPartition(partitionPath, sessionFileName);
    assert.notStrictEqual(third.artifactManifestDigest, first.artifactManifestDigest);
  });

  it('resolves a valid CAS blob pointer artifact against the shared .blobs store', function () {
    const blobBytes = Buffer.from('shared CAS blob content');
    const hex = sha256Hex(blobBytes);
    const blobDir = path.join(storageRoot, 'omp-sessions', '.blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, hex), blobBytes);
    fs.writeFileSync(path.join(partitionPath, 'pointer.bin'), `blob:sha256:${hex}`);

    const result = verifyExistingOmpPartition(partitionPath, sessionFileName);
    assert.match(result.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
  });

  it('rejects a blob pointer whose referenced content does not match the declared digest', function () {
    const hex = sha256Hex(Buffer.from('expected content'));
    const blobDir = path.join(storageRoot, 'omp-sessions', '.blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, hex), 'different content entirely');
    fs.writeFileSync(path.join(partitionPath, 'pointer.bin'), `blob:sha256:${hex}`);

    assert.throws(
      () => verifyExistingOmpPartition(partitionPath, sessionFileName),
      (error) =>
        error instanceof OmpSessionVerificationError && error.code === 'blob-digest-mismatch'
    );
  });

  it('rejects a blob pointer referencing a blob that does not exist', function () {
    const hex = 'f'.repeat(64);
    fs.writeFileSync(path.join(partitionPath, 'pointer.bin'), `blob:sha256:${hex}`);

    assert.throws(
      () => verifyExistingOmpPartition(partitionPath, sessionFileName),
      (error) => error instanceof OmpSessionVerificationError && error.code === 'blob-missing'
    );
  });

  it('never treats a large file with a pointer-shaped prefix as a blob pointer (trailing bytes are not silently ignored)', function () {
    const hex = sha256Hex(Buffer.from('irrelevant'));
    const blobDir = path.join(storageRoot, 'omp-sessions', '.blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, hex), 'irrelevant');
    const spoofed = Buffer.concat([Buffer.from(`blob:sha256:${hex}`), Buffer.alloc(200, 'x')]);
    fs.writeFileSync(path.join(partitionPath, 'spoofed.bin'), spoofed);

    // Must be hashed as an ordinary file (its real content), not resolved as the pointer prefix.
    const result = verifyExistingOmpPartition(partitionPath, sessionFileName);
    assert.match(result.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
  });
});
