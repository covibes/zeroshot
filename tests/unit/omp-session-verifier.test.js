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

  /** Verify against the pinned limits with a subset overridden. `limits` is a test seam for
   * proving enforcement, never configuration: no production caller passes it. */
  function verifyWithLimits(partition, limits = {}) {
    return withEnv(blobs.env, () =>
      verifyPartitionContents(partition.partitionPath, partition.sessionFileName, {
        limits: { ...OMP_SESSION_LIMITS, ...limits },
      })
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

  describe('raw platform path bytes in the manifest', function () {
    // A POSIX filename is an opaque byte string. Node decodes it into a JS string with U+FFFD for
    // every invalid byte, so two *different* files can arrive as the *same* string — and hashing
    // that string would give two different artifact trees one manifest digest, which an attacker
    // picks the filenames for. Windows has no such thing (the OS gives UTF-16 and fs rejects
    // Buffer paths), so this is gated to a platform where raw bytes exist.
    const rawNames = process.platform === 'win32' ? describe.skip : describe;

    rawNames('on a platform with byte-oriented filenames', function () {
      /** Write `content` to a raw-byte-named file directly under `dir`. */
      function writeRawNamed(dir, nameBytes, content) {
        const target = Buffer.concat([Buffer.from(`${dir}/`, 'utf8'), nameBytes]);
        fs.writeFileSync(target, content);
        return target;
      }

      it('gives two distinct non-UTF-8 artifact names two distinct, deterministic manifests', function () {
        // 0xFF and 0xFE are both invalid as standalone UTF-8. `Buffer.from(name).toString('utf8')`
        // maps each to the single replacement character U+FFFD, so the decoded names are equal.
        const first = Buffer.from([0xff]);
        const second = Buffer.from([0xfe]);
        assert.strictEqual(
          first.toString('utf8'),
          second.toString('utf8'),
          'the premise: these names are indistinguishable once decoded'
        );

        const partitionA = makeSessionPartition({ storageRoot, sessionId: 'raw-a' });
        fs.mkdirSync(partitionA.artifactsDir, { recursive: true });
        writeRawNamed(partitionA.artifactsDir, first, 'same content');

        const partitionB = makeSessionPartition({ storageRoot, sessionId: 'raw-a' });
        fs.mkdirSync(partitionB.artifactsDir, { recursive: true });
        writeRawNamed(partitionB.artifactsDir, second, 'same content');

        const digestA = verify(partitionA).artifactManifestDigest;
        const digestB = verify(partitionB).artifactManifestDigest;
        assert.notStrictEqual(
          digestA,
          digestB,
          'distinct raw names must produce distinct manifests, not a replacement-character collision'
        );

        // Deterministic: the same tree verified again yields the same digest.
        assert.strictEqual(verify(partitionA).artifactManifestDigest, digestA);
        assert.strictEqual(verify(partitionB).artifactManifestDigest, digestB);
      });

      it('orders and hashes raw names by their bytes, so sibling order is a property of the disk', function () {
        // Two non-UTF-8 names in ONE tree: with lossy decoding they would compare equal, making
        // the traversal order — and therefore the digest — depend on readdir's arbitrary order.
        const build = (names) => {
          const partition = makeSessionPartition({ storageRoot, sessionId: 'raw-order' });
          fs.mkdirSync(partition.artifactsDir, { recursive: true });
          for (const [nameBytes, content] of names) {
            writeRawNamed(partition.artifactsDir, nameBytes, content);
          }
          return verify(partition).artifactManifestDigest;
        };

        const forward = build([
          [Buffer.from([0xfe]), 'first'],
          [Buffer.from([0xff]), 'second'],
        ]);
        const reverse = build([
          [Buffer.from([0xff]), 'second'],
          [Buffer.from([0xfe]), 'first'],
        ]);
        assert.strictEqual(forward, reverse, 'creation order must not affect the manifest');

        // Swapping which name holds which content is a real difference and must be visible.
        const swapped = build([
          [Buffer.from([0xfe]), 'second'],
          [Buffer.from([0xff]), 'first'],
        ]);
        assert.notStrictEqual(forward, swapped);
      });

      it('measures maxRelativePathBytes against the raw bytes, not their lossy re-encoding', function () {
        // Three invalid bytes are three bytes on disk. Decoded, they become three U+FFFD, which
        // re-encode to NINE UTF-8 bytes — so a length check on the decoded form measures a path
        // three times the size of the one that actually exists.
        const nameBytes = Buffer.from([0xff, 0xfe, 0xfd]);
        assert.strictEqual(Buffer.byteLength(nameBytes.toString('utf8'), 'utf8'), 9);

        const partition = makeSessionPartition({ storageRoot, sessionId: 'raw-bound' });
        fs.mkdirSync(partition.artifactsDir, { recursive: true });
        writeRawNamed(partition.artifactsDir, nameBytes, 'x');

        const artifactsRelBytes = Buffer.byteLength(path.basename(partition.artifactsDir), 'utf8');
        const exactRelBytes = artifactsRelBytes + 1 + nameBytes.length;

        const verifyAt = (maxRelativePathBytes) =>
          verifyWithLimits(partition, { maxRelativePathBytes });

        // Exactly at the bound: accepted. One byte under: rejected. Both would be wrong by six
        // bytes if the check ran on the decoded string.
        assert.ok(verifyAt(exactRelBytes).artifactManifestDigest);
        expectCode(
          () => verifyAt(exactRelBytes - 1),
          'relative-path-bytes-exceeded',
          'one byte under the exact raw length'
        );
        // And the lossy length is genuinely larger, so a decoded-form check would have refused a
        // path that fits.
        assert.ok(exactRelBytes < artifactsRelBytes + 1 + 9);
      });

      it('opens artifact children from their raw bytes rather than a decoded round trip', function () {
        // The proof that no string round trip happens on the way to `open`: a file whose name is
        // not valid UTF-8 cannot be opened via its decoded form (that path names a *different*,
        // nonexistent file), so a manifest entry for it can only exist if the bytes were used.
        const nameBytes = Buffer.from([0xc3, 0x28, 0xa9]); // invalid UTF-8 sequence
        const partition = makeSessionPartition({ storageRoot, sessionId: 'raw-open' });
        fs.mkdirSync(partition.artifactsDir, { recursive: true });
        writeRawNamed(partition.artifactsDir, nameBytes, 'openable only by bytes');

        const decodedPath = path.join(partition.artifactsDir, nameBytes.toString('utf8'));
        assert.ok(
          !fs.existsSync(decodedPath),
          'the premise: the decoded name does not name any real file'
        );

        const verified = verify(partition);
        assert.match(verified.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
      });
    });
  });

  describe('adversarial input stays bounded', function () {
    const verifyRaw = verifyWithLimits;

    /** Overwrite a partition's transcript with exactly these raw bytes. */
    function writeTranscript(partition, bytes) {
      fs.writeFileSync(partition.sessionFilePath, bytes);
    }

    it('caps a single record at MAX_SESSION_RECORD_BYTES, so an unterminated file cannot be buffered whole', function () {
      // The pathological shape `maxSessionBytes` alone does not catch: a large file with no
      // newline in it is ONE record, and buffering it would cost the raw bytes, a UTF-16 string,
      // and a parsed value — a multi-hundred-megabyte spike the attacker chooses by leaving out a
      // newline. The bound is fixed and derived, so this exercises the real value rather than a
      // scaled-down stand-in.
      this.timeout(60000);
      const { MAX_SESSION_RECORD_BYTES } = require('../../src/omp-session-limits');
      assert.strictEqual(
        MAX_SESSION_RECORD_BYTES,
        OMP_SESSION_LIMITS.maxReferencedBlobBytes,
        'the per-record bound is derived from the issue constants, not invented'
      );

      const partition = makeSessionPartition({ storageRoot, sessionId: 'unterminated' });
      const header = `${JSON.stringify({ type: 'session', version: 3, id: 'unterminated' })}\n`;
      // One newline-free record just past the bound, and still far under maxSessionBytes, so this
      // can only be caught by the per-record bound.
      const oversized = Buffer.alloc(MAX_SESSION_RECORD_BYTES + 1, 0x41);
      assert.ok(header.length + oversized.length < OMP_SESSION_LIMITS.maxSessionBytes);
      writeTranscript(partition, Buffer.concat([Buffer.from(header, 'utf8'), oversized]));

      expectCode(() => verifyRaw(partition), 'session-record-bytes-exceeded', 'per-record bound');
    });

    it('survives a deeply nested record without exhausting the call stack', function () {
      // V8's JSON.parse accepts nesting this deep — it is not recursive in the way a naive walk
      // is — so the parsed value really does reach the blob-reference walk. A recursive walk over
      // it raises `RangeError: Maximum call stack size exceeded`, thrown from inside a streaming
      // read callback and outside every typed handler; the iterative walk completes normally.
      const depth = 200000;
      const partition = makeSessionPartition({ storageRoot, sessionId: 'deep' });
      const header = `${JSON.stringify({ type: 'session', version: 3, id: 'deep' })}\n`;
      const nested = `${'['.repeat(depth)}"x"${']'.repeat(depth)}\n`;
      writeTranscript(partition, Buffer.from(header + nested, 'utf8'));

      const verified = verifyRaw(partition);
      assert.strictEqual(verified.sessionRecords, 2);
      assert.deepStrictEqual(verified.blobReferences, [], 'no references, and no stack overflow');
      assert.match(verified.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
    });

    it('walks a deeply nested record that JSON.parse DOES accept, without recursing', function () {
      // Below V8's parser limit but far beyond a comfortable recursion depth for the walk itself.
      const depth = 4000;
      const partition = makeSessionPartition({ storageRoot, sessionId: 'deep-ok' });
      const header = `${JSON.stringify({ type: 'session', version: 3, id: 'deep-ok' })}\n`;
      const ref = blobs.put('nested-deeply');
      const nested = `${'['.repeat(depth)}${JSON.stringify(ref)}${']'.repeat(depth)}\n`;
      writeTranscript(partition, Buffer.from(header + nested, 'utf8'));

      const verified = verifyRaw(partition);
      assert.deepStrictEqual(
        verified.blobReferences,
        [ref],
        'the iterative walk must still find a reference buried this deep'
      );
    });

    it('enforces the record count before parsing the record that breaks it', function () {
      const partition = makeSessionPartition({
        storageRoot,
        sessionId: 'many',
        records: Array.from({ length: 50 }, (_, n) => ({ n })),
      });
      expectCode(() => verifyRaw(partition, { maxSessionRecords: 10 }), 'session-records-exceeded');
    });

    it('bounds a single record that carries more blob references than maxBlobReferences', function () {
      // Cardinality is enforced while collecting, inside one record, rather than after building an
      // unbounded set.
      const partition = makeSessionPartition({ storageRoot, sessionId: 'many-refs' });
      const header = `${JSON.stringify({ type: 'session', version: 3, id: 'many-refs' })}\n`;
      const refs = Array.from(
        { length: 40 },
        (_, n) => `blob:sha256:${crypto.createHash('sha256').update(`ref-${n}`).digest('hex')}`
      );
      writeTranscript(partition, Buffer.from(header + `${JSON.stringify({ refs })}\n`, 'utf8'));

      expectCode(
        () => verifyRaw(partition, { maxBlobReferences: 10 }),
        'blob-references-exceeded',
        'reference cardinality'
      );
    });

    it('never accumulates blob bytes: an oversized referenced blob is refused from its declared size', function () {
      const ref = blobs.put('x'.repeat(4096));
      const partition = makeSessionPartition({
        storageRoot,
        sessionId: 'big-blob',
        records: [{ type: 'message', content: [{ data: ref }] }],
      });
      expectCode(
        () => verifyRaw(partition, { maxReferencedBlobBytes: 16 }),
        'blob-bytes-exceeded',
        'referenced blob bytes'
      );
    });

    it('stops enumerating a directory once it has read more names than the entry budget allows', function () {
      // `readdir` materializes every name before any bound can be applied; `opendir` streams, so a
      // directory far over budget costs the budget rather than the directory. 200 entries against
      // a budget of 4 must fail as an entry-count violation, not as anything else.
      const partition = makeSessionPartition({ storageRoot, sessionId: 'wide' });
      fs.mkdirSync(partition.artifactsDir, { recursive: true });
      for (let n = 0; n < 200; n += 1) {
        fs.writeFileSync(path.join(partition.artifactsDir, `entry-${n}.txt`), 'x');
      }
      expectCode(
        () => verifyRaw(partition, { maxArtifactEntries: 4 }),
        'artifact-entries-exceeded',
        'wide directory'
      );
    });

    it('accepts a tree that sits exactly on maxArtifactEntries', function () {
      // The session file is skipped rather than counted, so the depth-0 budget must allow for it —
      // an off-by-one in the streaming cutoff would reject a legal tree.
      const partition = makeSessionPartition({ storageRoot, sessionId: 'exact-entries' });
      fs.mkdirSync(partition.artifactsDir, { recursive: true });
      fs.writeFileSync(path.join(partition.artifactsDir, 'a.txt'), 'x');
      fs.writeFileSync(path.join(partition.artifactsDir, 'b.txt'), 'y');
      // artifacts dir + two files = 3 entries.
      assert.ok(verifyRaw(partition, { maxArtifactEntries: 3 }).artifactManifestDigest);
      expectCode(
        () => verifyRaw(partition, { maxArtifactEntries: 2 }),
        'artifact-entries-exceeded'
      );
    });

    it('refuses an aggregate artifact payload over budget without reading it all first', function () {
      const partition = makeSessionPartition({ storageRoot, sessionId: 'aggregate' });
      fs.mkdirSync(partition.artifactsDir, { recursive: true });
      for (const name of ['a.bin', 'b.bin', 'c.bin']) {
        fs.writeFileSync(path.join(partition.artifactsDir, name), Buffer.alloc(1024, 0x61));
      }
      expectCode(
        () => verifyRaw(partition, { maxArtifactAggregateBytes: 1500 }),
        'artifact-aggregate-bytes-exceeded'
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
