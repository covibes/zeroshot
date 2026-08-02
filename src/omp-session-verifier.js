// Two-phase lazy-file verification for OMP session partitions (issue #866). Every check below is
// structural (path/type/size/digest), never a parse of OMP's own session semantics: Zeroshot does
// not depend on OMP's internal JSONL schema, only on the partition being an owner-held directory
// tree of regular, single-link, size-bounded files with no symlink/socket/device escape and no
// dangling blob reference.
//
// Partition contract (Zeroshot-owned, not an OMP-documented format): a session partition is
// `<storageRoot>/omp-sessions/<uuid>/`, containing the session JSONL file plus zero or more
// sibling artifact entries. An artifact file's entire content may instead be a CAS pointer of the
// exact form `blob:sha256:<64-lower-hex>`, which is resolved against the shared blob store at
// `<storageRoot>/omp-sessions/.blobs/<hex>` — a sibling of every UUID partition, never deleted by
// per-task cleanup (see deleteOmpSessionPartition in src/omp-session-partition.js).
const { createHash } = require('crypto');
const {
  lstatSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
} = require('fs');
const path = require('path');
const { OMP_SESSION_LIMITS } = require('./omp-session-limits');

const BLOB_STORE_DIRNAME = '.blobs';
const BLOB_POINTER_PATTERN = /^blob:sha256:[a-f0-9]{64}$/;
const NEWLINE = 0x0a;
const STREAM_CHUNK_BYTES = 1 << 16;
const POINTER_PROBE_BYTES = 128;

class OmpSessionVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OmpSessionVerificationError';
    this.code = code;
  }
}

function assertOwnedByCurrentUser(stat, targetPath) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new OmpSessionVerificationError(
      'not-owner-held',
      `${targetPath} is not owned by the current user.`
    );
  }
}

function assertOwnedDirectory(targetPath) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    throw new OmpSessionVerificationError(
      'partition-missing',
      `${targetPath} does not exist: ${error.message}`
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new OmpSessionVerificationError(
      'not-a-directory',
      `${targetPath} is not a real directory.`
    );
  }
  assertOwnedByCurrentUser(stat, targetPath);
  return stat;
}

function assertDirectChildName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    throw new OmpSessionVerificationError(
      'invalid-relative-path',
      `Invalid direct-child name: ${JSON.stringify(name)}`
    );
  }
}

function assertRegularSingleLinkFile(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    throw new OmpSessionVerificationError(
      'file-missing',
      `${filePath} does not exist: ${error.message}`
    );
  }
  if (stat.isSymbolicLink()) {
    throw new OmpSessionVerificationError('symlink-rejected', `${filePath} is a symlink.`);
  }
  if (!stat.isFile()) {
    throw new OmpSessionVerificationError(
      'not-a-regular-file',
      `${filePath} is not a regular file.`
    );
  }
  if (stat.nlink > 1) {
    throw new OmpSessionVerificationError(
      'hard-link-rejected',
      `${filePath} has more than one hard link.`
    );
  }
  assertOwnedByCurrentUser(stat, filePath);
  return stat;
}

/** Streams the session file in fixed-size chunks (never allocates proportional to file size)
 * counting bytes/newline-delimited records and hashing content, enforcing bounds as it goes. */
function streamCountJsonlFile(filePath, limits) {
  const declared = statSync(filePath);
  if (declared.size > limits.maxSessionBytes) {
    throw new OmpSessionVerificationError(
      'session-bytes-exceeded',
      `${filePath} declared size ${declared.size} exceeds maxSessionBytes.`
    );
  }

  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    const hash = createHash('sha256');
    let bytesRead = 0;
    let records = 0;
    let lastByte = -1;
    for (;;) {
      const n = readSync(fd, buffer, 0, STREAM_CHUNK_BYTES, null);
      if (n === 0) break;
      bytesRead += n;
      if (bytesRead > limits.maxSessionBytes) {
        throw new OmpSessionVerificationError(
          'session-bytes-exceeded',
          `${filePath} observed bytes exceed maxSessionBytes.`
        );
      }
      for (let i = 0; i < n; i += 1) {
        if (buffer[i] === NEWLINE) records += 1;
      }
      lastByte = buffer[n - 1];
      if (records > limits.maxSessionRecords) {
        throw new OmpSessionVerificationError(
          'session-records-exceeded',
          `${filePath} exceeds maxSessionRecords.`
        );
      }
      hash.update(buffer.subarray(0, n));
    }
    if (bytesRead > 0 && lastByte !== NEWLINE) records += 1; // trailing unterminated record
    if (records > limits.maxSessionRecords) {
      throw new OmpSessionVerificationError(
        'session-records-exceeded',
        `${filePath} exceeds maxSessionRecords.`
      );
    }
    return { bytes: bytesRead, records, digest: `sha256:${hash.digest('hex')}` };
  } finally {
    closeSync(fd);
  }
}

/** Streams a file in fixed-size chunks (never allocates proportional to file size), hashing its
 * content and enforcing maxBytes against bytes actually observed while reading — not just the
 * declared `stat().size` — so a file that grows between stat and read (TOCTOU) still cannot force
 * an unbounded allocation. */
function streamFileDigestHex(filePath, maxBytes, errorCode, describePath) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    const hash = createHash('sha256');
    let bytesRead = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, STREAM_CHUNK_BYTES, null);
      if (n === 0) break;
      bytesRead += n;
      if (bytesRead > maxBytes) {
        throw new OmpSessionVerificationError(
          errorCode,
          `${describePath} observed bytes exceed the declared bound.`
        );
      }
      hash.update(buffer.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function resolveBlobReference(storageRoot, pointer, limits, blobAggregate) {
  const hex = pointer.slice('blob:sha256:'.length);
  const blobFile = path.join(storageRoot, 'omp-sessions', BLOB_STORE_DIRNAME, hex);
  let stat;
  try {
    stat = lstatSync(blobFile);
  } catch {
    throw new OmpSessionVerificationError('blob-missing', `Referenced blob ${pointer} is missing.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new OmpSessionVerificationError(
      'blob-not-regular',
      `Referenced blob ${pointer} is not a regular single-link file.`
    );
  }
  if (stat.size > limits.maxReferencedBlobBytes) {
    throw new OmpSessionVerificationError(
      'blob-bytes-exceeded',
      `Referenced blob ${pointer} exceeds maxReferencedBlobBytes.`
    );
  }
  blobAggregate.count += 1;
  if (blobAggregate.count > limits.maxBlobReferences) {
    throw new OmpSessionVerificationError(
      'blob-references-exceeded',
      'Partition exceeds maxBlobReferences.'
    );
  }
  const actualPointer = `blob:sha256:${streamFileDigestHex(blobFile, limits.maxReferencedBlobBytes, 'blob-bytes-exceeded', pointer)}`;
  if (actualPointer !== pointer) {
    throw new OmpSessionVerificationError(
      'blob-digest-mismatch',
      `Referenced blob ${pointer} content does not match its digest.`
    );
  }
}

function collectArtifactEntries(partitionPath, sessionFileName, storageRoot, limits) {
  const entries = [];
  const fileAggregate = { count: 0, bytes: 0 };
  const blobAggregate = { count: 0 };

  function visit(absDir, relDir, depth) {
    if (depth > limits.maxArtifactDepth) {
      throw new OmpSessionVerificationError(
        'artifact-depth-exceeded',
        `Artifact tree exceeds maxArtifactDepth at ${relDir || '.'}.`
      );
    }
    const children = readdirSync(absDir, { withFileTypes: true })
      .filter((child) => !(depth === 0 && child.name === sessionFileName))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const child of children) {
      const absPath = path.join(absDir, child.name);
      const relPath = relDir ? `${relDir}/${child.name}` : child.name;
      if (Buffer.byteLength(relPath, 'utf8') > limits.maxRelativePathBytes) {
        throw new OmpSessionVerificationError(
          'relative-path-bytes-exceeded',
          `${relPath} exceeds maxRelativePathBytes.`
        );
      }

      fileAggregate.count += 1;
      if (fileAggregate.count > limits.maxArtifactEntries) {
        throw new OmpSessionVerificationError(
          'artifact-entries-exceeded',
          'Artifact tree exceeds maxArtifactEntries.'
        );
      }

      const stat = lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        throw new OmpSessionVerificationError('symlink-rejected', `${relPath} is a symlink.`);
      }
      if (stat.isDirectory()) {
        assertOwnedByCurrentUser(stat, absPath);
        entries.push({ relPath, type: 'dir', size: 0, contentDigest: '' });
        visit(absPath, relPath, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        throw new OmpSessionVerificationError(
          'not-a-regular-single-link-file',
          `${relPath} must be a regular, single-link file.`
        );
      }
      assertOwnedByCurrentUser(stat, absPath);
      if (stat.size > limits.maxArtifactFileBytes) {
        throw new OmpSessionVerificationError(
          'artifact-file-bytes-exceeded',
          `${relPath} exceeds maxArtifactFileBytes.`
        );
      }

      // A blob pointer is short and fixed-length ('blob:sha256:' + 64 hex = 76 bytes), so only a
      // small file can possibly be one; reading up to POINTER_PROBE_BYTES is bounded regardless of
      // maxArtifactFileBytes. Anything larger is hashed by streaming — never loaded whole.
      const pointer =
        stat.size <= POINTER_PROBE_BYTES ? readFileSync(absPath).toString('utf8') : null;
      let contentDigest;
      if (pointer && BLOB_POINTER_PATTERN.test(pointer)) {
        resolveBlobReference(storageRoot, pointer, limits, blobAggregate);
        contentDigest = pointer;
      } else {
        contentDigest = `sha256:${streamFileDigestHex(absPath, limits.maxArtifactFileBytes, 'artifact-file-bytes-exceeded', relPath)}`;
      }

      fileAggregate.bytes += stat.size;
      if (fileAggregate.bytes > limits.maxArtifactAggregateBytes) {
        throw new OmpSessionVerificationError(
          'artifact-aggregate-bytes-exceeded',
          'Artifact tree exceeds maxArtifactAggregateBytes.'
        );
      }

      entries.push({ relPath, type: 'file', size: stat.size, contentDigest });
    }
  }

  visit(partitionPath, '', 0);
  return entries;
}

function lengthPrefixed(value) {
  const buf = Buffer.from(String(value), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function hashManifestEntry(hash, { relPath, type, size, contentDigest }) {
  hash.update(lengthPrefixed(relPath));
  hash.update(lengthPrefixed(type));
  hash.update(lengthPrefixed(size));
  hash.update(lengthPrefixed(contentDigest || ''));
}

function verifyPartitionContents(partitionPath, sessionFileName) {
  assertDirectChildName(sessionFileName);
  assertOwnedDirectory(partitionPath);

  const sessionFilePath = path.join(partitionPath, sessionFileName);
  const sessionStat = assertRegularSingleLinkFile(sessionFilePath);
  const session = streamCountJsonlFile(sessionFilePath, OMP_SESSION_LIMITS);

  const storageRoot = path.dirname(path.dirname(partitionPath));
  const artifactEntries = collectArtifactEntries(
    partitionPath,
    sessionFileName,
    storageRoot,
    OMP_SESSION_LIMITS
  );

  const manifestHash = createHash('sha256');
  hashManifestEntry(manifestHash, {
    relPath: sessionFileName,
    type: 'file',
    size: session.bytes,
    contentDigest: session.digest,
  });
  for (const entry of artifactEntries) hashManifestEntry(manifestHash, entry);

  return {
    sessionFilePath,
    sessionFileIdentity: { device: String(sessionStat.dev), inode: String(sessionStat.ino) },
    sessionBytes: session.bytes,
    sessionRecords: session.records,
    artifactManifestDigest: `sha256:${manifestHash.digest('hex')}`,
  };
}

/** Lightweight check at spawn/`ready`: the partition path itself is a real, owner-held directory.
 * Never walks the artifact tree or session file, both of which may be legitimately unpopulated
 * yet for a fresh session at this point in the lifecycle. */
function checkPartitionPathReady(partitionPath) {
  assertOwnedDirectory(partitionPath);
}

/** Full verification of a partition expected to already hold a session: before spawn and before
 * prompt on the resume path. */
function verifyExistingOmpPartition(partitionPath, sessionFileName) {
  return verifyPartitionContents(partitionPath, sessionFileName);
}

/** Full verification after terminal materialization of a fresh session, before its ownership
 * record may be committed as resumable. */
function verifyFreshMaterialization(partitionPath, sessionFileName) {
  return verifyPartitionContents(partitionPath, sessionFileName);
}

module.exports = {
  BLOB_STORE_DIRNAME,
  BLOB_POINTER_PATTERN,
  OmpSessionVerificationError,
  checkPartitionPathReady,
  verifyExistingOmpPartition,
  verifyFreshMaterialization,
};
