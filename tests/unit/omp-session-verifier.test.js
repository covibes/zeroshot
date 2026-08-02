/**
 * src/omp-session-verifier.js — the two-phase lazy-file contract of issue #866.
 *
 * The contract this proves, against the tagged OMP v17.2.1 layout:
 *   - the session transcript is streamed and *parsed*; its first record is OMP's session header
 *   - canonical `blob:sha256:<hex>` references nested inside those records resolve at the shared,
 *     machine-wide OMP CAS root (pi-utils::getBlobsDir()), not at any Zeroshot-owned directory
 *   - a missing / digest-mismatched / non-canonical reference is an invalid continuation
 *   - only owner-held directories and regular, single-link files are accepted; symlinks, hard
 *     links, non-regular files, and substituted inodes fail closed
 *   - every declared and observed bound in OMP_SESSION_LIMITS is enforced
 *   - the artifact manifest digest is deterministic and changes on any type/path/content drift
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkPartitionPathReady,
  verifyExistingOmpPartition,
  verifyPartitionContents,
} = require('../../src/omp-session-verifier');
const { OMP_SESSION_LIMITS } = require('../../src/omp-session-limits');
const { resolveOmpBlobsDir } = require('../../src/omp-blob-root');
const {
  makeBlobStore,
  makeSessionPartition,
  makeStorageRoot,
  withEnv,
} = require('../helpers/omp-session-fixtures');

function expectCode(fn, code, message) {
  assert.throws(
    fn,
    (error) => {
      assert.strictEqual(error.code, code, `${message}: got ${error.code} (${error.message})`);
      return true;
    },
    message
  );
}

describe('src/omp-session-verifier.js (two-phase lazy-file verification)', function () {
  let storageRoot;
  let blobs;

  beforeEach(function () {
    storageRoot = makeStorageRoot('omp-verifier-unit-');
    blobs = makeBlobStore('omp-verifier-blobs-');
  });

  function verify(partition, options = {}) {
    return withEnv(blobs.env, () =>
      verifyExistingOmpPartition(partition.partitionPath, partition.sessionFileName, options)
    );
  }

  describe('session transcript and header', function () {
    it('parses the session header and reports the on-disk session identity and workspace', function () {
      const partition = makeSessionPartition({
        storageRoot,
        sessionId: 'sess-header',
        cwd: '/work/space',
        records: [{ type: 'message', role: 'user' }],
      });

      const verified = verify(partition);

      assert.strictEqual(verified.sessionHeader.sessionId, 'sess-header');
      assert.strictEqual(verified.sessionHeader.cwd, '/work/space');
      assert.strictEqual(verified.sessionRecords, 2);
      assert.strictEqual(verified.sessionFilePath, partition.sessionFilePath);
      assert.strictEqual(verified.sessionFileName, partition.sessionFileName);
      assert.deepStrictEqual(verified.sessionFileIdentity, partition.sessionFileIdentity());
      assert.deepStrictEqual(verified.partitionIdentity, partition.identity());
      assert.match(verified.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
    });

    it('rejects a transcript whose first record is not a session header', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.writeFileSync(partition.sessionFilePath, '{"type":"message","role":"user"}\n');
      expectCode(() => verify(partition), 'session-header-invalid', 'non-header first record');
    });

    it('rejects a transcript with an unparseable record', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.appendFileSync(partition.sessionFilePath, 'not json at all\n');
      expectCode(() => verify(partition), 'session-record-unparseable', 'unparseable record');
    });

    it('rejects an empty transcript (no header at all)', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.writeFileSync(partition.sessionFilePath, '');
      expectCode(() => verify(partition), 'session-header-missing', 'empty transcript');
    });

    it('requires a direct-child *.jsonl session file name', function () {
      const partition = makeSessionPartition({ storageRoot });
      for (const name of ['../escape.jsonl', 'sub/nested.jsonl', 'session.txt', '..', '']) {
        expectCode(
          () => verifyExistingOmpPartition(partition.partitionPath, name),
          'invalid-session-file-name',
          `name ${JSON.stringify(name)}`
        );
      }
    });
  });

  describe('shared OMP CAS blob references', function () {
    it('resolves canonical nested references at the real shared OMP blob root', function () {
      const ref = blobs.put('image-bytes');
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ type: 'image', data: ref }] }],
      });

      const verified = verify(partition);

      assert.deepStrictEqual(verified.blobReferences, [ref]);
      assert.strictEqual(
        verified.blobsDir,
        withEnv(blobs.env, () => resolveOmpBlobsDir()),
        'blobs must resolve at getBlobsDir(), never inside the Zeroshot partition'
      );
      assert.strictEqual(
        verified.blobsDir,
        blobs.blobsDir,
        'the shared store the fixture wrote is the store the verifier read'
      );
      assert.ok(
        !verified.blobsDir.startsWith(storageRoot),
        'the shared CAS root is not under the Zeroshot storage root'
      );
    });

    it('accepts a blob carrying the typed sidecar hardlink OMP creates for image viewers', function () {
      const ref = blobs.put(Buffer.from('89504e47', 'hex'), { extension: 'png' });
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'tool_result', result: ref }],
      });
      assert.deepStrictEqual(verify(partition).blobReferences, [ref]);
    });

    it('collects references from arbitrarily nested record positions', function () {
      const first = blobs.put('one');
      const second = blobs.put('two');
      const partition = makeSessionPartition({
        storageRoot,
        records: [
          { type: 'message', content: [{ nested: { deeper: [{ image_url: first }] } }] },
          { type: 'message', content: [{ data: second }] },
          { type: 'message', content: [{ data: first }] },
        ],
      });
      assert.deepStrictEqual(verify(partition).blobReferences, [first, second].sort());
    });

    it('treats a missing referenced blob as an invalid continuation', function () {
      const ref = blobs.put('vanishing');
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ data: ref }] }],
      });
      fs.rmSync(path.join(blobs.blobsDir, ref.slice('blob:sha256:'.length)));
      expectCode(() => verify(partition), 'blob-missing', 'missing blob');
    });

    it('rejects a referenced blob whose bytes do not match its digest', function () {
      const ref = blobs.put('original');
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ data: ref }] }],
      });
      fs.writeFileSync(path.join(blobs.blobsDir, ref.slice('blob:sha256:'.length)), 'tampered');
      expectCode(() => verify(partition), 'blob-digest-mismatch', 'substituted blob content');
    });

    it('rejects a non-canonical blob reference instead of silently treating it as data', function () {
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ data: 'blob:sha256:NOT-A-CANONICAL-HASH' }] }],
      });
      expectCode(() => verify(partition), 'blob-reference-noncanonical', 'non-canonical ref');
    });

    it('rejects a referenced blob replaced by a symlink', function () {
      const ref = blobs.put('linked');
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ data: ref }] }],
      });
      const blobPath = path.join(blobs.blobsDir, ref.slice('blob:sha256:'.length));
      const elsewhere = path.join(blobs.blobRoot, 'elsewhere');
      fs.writeFileSync(elsewhere, 'linked');
      fs.rmSync(blobPath);
      fs.symlinkSync(elsewhere, blobPath);
      expectCode(() => verify(partition), 'symlink-rejected', 'symlinked blob');
    });

    it('enforces maxBlobReferences while collecting', function () {
      const refs = [];
      for (let i = 0; i <= 4; i += 1) refs.push(blobs.put(`blob-${i}`));
      const partition = makeSessionPartition({
        storageRoot,
        records: refs.map((ref) => ({ type: 'message', content: [{ data: ref }] })),
      });
      expectCode(
        () =>
          withEnv(blobs.env, () =>
            verifyPartitionContents(partition.partitionPath, partition.sessionFileName, {
              limits: { ...OMP_SESSION_LIMITS, maxBlobReferences: 3 },
            })
          ),
        'blob-references-exceeded',
        'too many distinct refs'
      );
    });

    it('enforces maxReferencedBlobBytes against the blob it actually reads', function () {
      const ref = blobs.put('x'.repeat(4096));
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ data: ref }] }],
      });
      expectCode(
        () =>
          withEnv(blobs.env, () =>
            verifyPartitionContents(partition.partitionPath, partition.sessionFileName, {
              limits: { ...OMP_SESSION_LIMITS, maxReferencedBlobBytes: 16 },
            })
          ),
        'blob-bytes-exceeded',
        'oversized blob'
      );
    });

    it('never reads the shared blob root when the transcript has no references', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.rmSync(blobs.blobsDir, { recursive: true, force: true });
      const verified = verify(partition);
      assert.deepStrictEqual(verified.blobReferences, []);
      assert.strictEqual(verified.blobsDir, null);
    });
  });

  describe('file-type and identity pinning', function () {
    it('rejects a session file substituted for a symlink', function () {
      const partition = makeSessionPartition({ storageRoot });
      const outside = path.join(storageRoot, 'outside.jsonl');
      fs.writeFileSync(outside, '{"type":"session","id":"other"}\n');
      fs.rmSync(partition.sessionFilePath);
      fs.symlinkSync(outside, partition.sessionFilePath);
      expectCode(() => verify(partition), 'symlink-rejected', 'symlinked session file');
    });

    it('rejects a multiply-linked session file', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.linkSync(partition.sessionFilePath, path.join(storageRoot, 'second-link.jsonl'));
      expectCode(() => verify(partition), 'hard-link-rejected', 'hard-linked session file');
    });

    it('rejects a non-regular session file (FIFO)', function () {
      if (process.platform === 'win32') return this.skip();
      const partition = makeSessionPartition({ storageRoot });
      fs.rmSync(partition.sessionFilePath);
      require('child_process').execFileSync('mkfifo', [partition.sessionFilePath]);
      assert.throws(
        () => verify(partition),
        (error) => error.name === 'OmpSessionVerificationError'
      );
    });

    it('rejects a symlinked partition directory', function () {
      const partition = makeSessionPartition({ storageRoot });
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-verifier-target-'));
      fs.rmSync(partition.partitionPath, { recursive: true });
      fs.symlinkSync(target, partition.partitionPath);
      expectCode(() => verify(partition), 'symlink-rejected', 'symlinked partition');
      expectCode(
        () => checkPartitionPathReady(partition.partitionPath),
        'symlink-rejected',
        'symlinked partition at ready'
      );
    });

    it('rejects a partition whose inode no longer matches the recorded identity', function () {
      const partition = makeSessionPartition({ storageRoot });
      const recorded = partition.identity();
      const substituted = { device: recorded.device, inode: String(Number(recorded.inode) + 1) };
      expectCode(
        () => verify(partition, { expectedPartitionIdentity: substituted }),
        'partition-identity-mismatch',
        'substituted partition inode'
      );
      expectCode(
        () =>
          checkPartitionPathReady(partition.partitionPath, {
            expectedPartitionIdentity: substituted,
          }),
        'partition-identity-mismatch',
        'substituted partition inode at ready'
      );
    });

    it('accepts a partition whose inode matches the recorded identity', function () {
      const partition = makeSessionPartition({ storageRoot });
      const verified = verify(partition, { expectedPartitionIdentity: partition.identity() });
      assert.deepStrictEqual(verified.partitionIdentity, partition.identity());
    });

    it('rejects a missing partition and a missing session file distinctly', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.rmSync(partition.sessionFilePath);
      expectCode(() => verify(partition), 'session-file-missing', 'missing session file');
      fs.rmSync(partition.partitionPath, { recursive: true });
      expectCode(() => verify(partition), 'partition-missing', 'missing partition');
      expectCode(
        () => checkPartitionPathReady(partition.partitionPath),
        'partition-missing',
        'missing partition at ready'
      );
    });

    it('rejects a symlink inside the artifact tree', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['keep.txt'] });
      const outside = path.join(storageRoot, 'escape-target');
      fs.writeFileSync(outside, 'secret');
      fs.symlinkSync(outside, path.join(partition.artifactsDir, 'escape'));
      expectCode(() => verify(partition), 'symlink-rejected', 'symlinked artifact');
    });

    it('rejects a multiply-linked artifact file', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['shared.txt'] });
      fs.linkSync(
        path.join(partition.artifactsDir, 'shared.txt'),
        path.join(storageRoot, 'artifact-alias')
      );
      expectCode(() => verify(partition), 'not-a-regular-single-link-file', 'hard-linked artifact');
    });
  });

  describe('artifact manifest', function () {
    it('is deterministic across independent verifications of an unchanged tree', function () {
      const partition = makeSessionPartition({
        storageRoot,
        artifacts: ['a.txt', 'nested/b.txt', 'nested/deeper/c.txt'],
      });
      assert.strictEqual(
        verify(partition).artifactManifestDigest,
        verify(partition).artifactManifestDigest
      );
    });

    it('changes when artifact content, path, or type changes', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['a.txt'] });
      const baseline = verify(partition).artifactManifestDigest;

      fs.appendFileSync(path.join(partition.artifactsDir, 'a.txt'), 'more');
      const contentChanged = verify(partition).artifactManifestDigest;
      assert.notStrictEqual(contentChanged, baseline, 'content drift must change the manifest');

      fs.renameSync(
        path.join(partition.artifactsDir, 'a.txt'),
        path.join(partition.artifactsDir, 'b.txt')
      );
      assert.notStrictEqual(
        verify(partition).artifactManifestDigest,
        contentChanged,
        'path drift must change the manifest'
      );

      fs.rmSync(path.join(partition.artifactsDir, 'b.txt'));
      fs.mkdirSync(path.join(partition.artifactsDir, 'b.txt'));
      assert.notStrictEqual(
        verify(partition).artifactManifestDigest,
        contentChanged,
        'type drift must change the manifest'
      );
    });

    it('changes when the transcript itself changes', function () {
      const partition = makeSessionPartition({ storageRoot });
      const baseline = verify(partition).artifactManifestDigest;
      fs.appendFileSync(partition.sessionFilePath, '{"type":"message","role":"user"}\n');
      assert.notStrictEqual(verify(partition).artifactManifestDigest, baseline);
    });

    it('streams a multi-chunk artifact to the same digest a whole-file sha256 produces', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['seed.txt'] });
      const payload = crypto.randomBytes((1 << 16) * 2 + 1234);
      const target = path.join(partition.artifactsDir, 'big.bin');
      fs.writeFileSync(target, payload);

      const withBig = verify(partition).artifactManifestDigest;
      assert.strictEqual(withBig, verify(partition).artifactManifestDigest, 'deterministic');

      // Rewriting the file with bytes that hash the same (identical content) must not move the
      // manifest; a single differing byte must. That is exactly what a correct streamed digest
      // over several internal 64 KiB reads guarantees.
      fs.writeFileSync(target, Buffer.from(payload));
      assert.strictEqual(verify(partition).artifactManifestDigest, withBig);
      const mutated = Buffer.from(payload);
      mutated[(1 << 16) + 7] ^= 0xff;
      fs.writeFileSync(target, mutated);
      assert.notStrictEqual(verify(partition).artifactManifestDigest, withBig);
    });
  });

  describe('bounds', function () {
    function verifyWithLimits(partition, limits) {
      return withEnv(blobs.env, () =>
        verifyPartitionContents(partition.partitionPath, partition.sessionFileName, {
          limits: { ...OMP_SESSION_LIMITS, ...limits },
        })
      );
    }

    it('pins OMP_SESSION_LIMITS to the exact values issue #866 specifies', function () {
      assert.deepStrictEqual(
        { ...OMP_SESSION_LIMITS },
        {
          maxSessionBytes: 268435456,
          maxSessionRecords: 1000000,
          maxArtifactEntries: 4096,
          maxArtifactDepth: 16,
          maxRelativePathBytes: 4096,
          maxArtifactFileBytes: 268435456,
          maxArtifactAggregateBytes: 536870912,
          maxBlobReferences: 4096,
          maxReferencedBlobBytes: 67108864,
        }
      );
      assert.ok(Object.isFrozen(OMP_SESSION_LIMITS), 'limits must not be mutable at runtime');
    });

    it('rejects before allocation when the declared session size exceeds maxSessionBytes', function () {
      const partition = makeSessionPartition({ storageRoot });
      expectCode(
        () => verifyWithLimits(partition, { maxSessionBytes: 4 }),
        'session-bytes-exceeded',
        'declared session size'
      );
    });

    it('enforces maxSessionRecords', function () {
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ n: 1 }, { n: 2 }, { n: 3 }],
      });
      expectCode(
        () => verifyWithLimits(partition, { maxSessionRecords: 2 }),
        'session-records-exceeded',
        'record count'
      );
    });

    it('enforces maxArtifactEntries, maxArtifactDepth, and maxArtifactAggregateBytes', function () {
      const wide = makeSessionPartition({ storageRoot, artifacts: ['a.txt', 'b.txt', 'c.txt'] });
      expectCode(
        () => verifyWithLimits(wide, { maxArtifactEntries: 2 }),
        'artifact-entries-exceeded',
        'entry count'
      );
      expectCode(
        () => verifyWithLimits(wide, { maxArtifactAggregateBytes: 4 }),
        'artifact-aggregate-bytes-exceeded',
        'aggregate bytes'
      );

      const deep = makeSessionPartition({ storageRoot, artifacts: ['a/b/c/d.txt'] });
      expectCode(
        () => verifyWithLimits(deep, { maxArtifactDepth: 2 }),
        'artifact-depth-exceeded',
        'tree depth'
      );
    });

    it('enforces maxArtifactFileBytes and maxRelativePathBytes', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['payload.bin'] });
      fs.writeFileSync(path.join(partition.artifactsDir, 'payload.bin'), 'x'.repeat(512));
      expectCode(
        () => verifyWithLimits(partition, { maxArtifactFileBytes: 16 }),
        'artifact-file-bytes-exceeded',
        'artifact file bytes'
      );
      expectCode(
        () => verifyWithLimits(partition, { maxRelativePathBytes: 2 }),
        'relative-path-bytes-exceeded',
        'relative path bytes'
      );
    });
  });

  describe('fresh-session readiness', function () {
    it('checkPartitionPathReady never reads the transcript or the tree', function () {
      const partition = makeSessionPartition({ storageRoot });
      fs.rmSync(partition.sessionFilePath);
      // A fresh session's partition is legitimately empty at `ready`; the path check must pass.
      const ready = checkPartitionPathReady(partition.partitionPath);
      assert.deepStrictEqual(ready.partitionIdentity, partition.identity());
    });
  });
});
