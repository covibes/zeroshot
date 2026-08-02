// Two-phase lazy-file verification for OMP session partitions (issue #866).
//
// Partition contract (Zeroshot-owned): a session partition is `<storageRoot>/omp-sessions/<uuid>/`,
// passed to OMP as `--session-dir`. OMP writes `<fileSafeTimestamp>_<sessionId>.jsonl` directly
// inside it and, per `packages/coding-agent/src/session/session-manager.ts`
// (`artifactsDirectoryFor`), keeps that session's artifact tree in the sibling directory whose name
// is the session file's name minus the `.jsonl` suffix. Zeroshot verifies the whole partition
// subtree, which is a superset of that pair and therefore also catches anything unexpected.
//
// CAS blobs are NOT part of the partition. OMP externalizes large payloads to a *shared*,
// machine-wide content-addressed store (`blob-store.ts`, rooted at `pi-utils::getBlobsDir()` —
// `~/.omp/agent/blobs` modulo OMP's config-root/profile/XDG semantics, mirrored in
// src/omp-blob-root.js) and leaves a *nested* `blob:sha256:<64-lower-hex>` reference string inside
// the session JSONL records. So verification parses the JSONL, collects canonical nested refs, and
// checks the referenced blobs at that real shared root. Nothing here ever writes to or deletes
// from it (see src/omp-session-partition.js, which refuses any path resolving inside it).
//
// Every filesystem check below is descriptor-pinned: a path is opened once with O_NOFOLLOW (plus
// O_DIRECTORY for directories) and every subsequent type/owner/link/size/identity check and every
// byte read comes from `fstat`/`read` on that same descriptor. There is no lstat -> open -> stat
// pathname sequence and no re-open of a mutable name after validation, so the substituted-file
// race (CodeQL js/file-system-race) cannot apply: the object we checked is the object we read.
// Directory listings additionally re-pin and compare identity around `readdir`, which reports a
// substitution as a verification failure rather than silently traversing the replacement.
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { OMP_SESSION_LIMITS } = require('./omp-session-limits');
const { resolveOmpBlobsDir } = require('./omp-blob-root');

const BLOB_REF_PREFIX = 'blob:sha256:';
const CANONICAL_BLOB_REF_PATTERN = /^blob:sha256:[a-f0-9]{64}$/u;
const SESSION_FILE_NAME_PATTERN = /^[^/\\]+\.jsonl$/u;
const NEWLINE = 0x0a;
const STREAM_CHUNK_BYTES = 1 << 16;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
// O_NONBLOCK is what keeps "reject sockets/devices/FIFOs" from being a liveness hole: opening a
// FIFO read-only blocks until a writer appears, so a partition containing one would otherwise hang
// verification forever instead of failing it. With O_NONBLOCK the open returns immediately and the
// fstat below rejects the non-regular type. No effect on regular files or directories.
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

class OmpSessionVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OmpSessionVerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OmpSessionVerificationError(code, message);
}

function identityOf(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(a, b) {
  return Boolean(a) && Boolean(b) && a.device === b.device && a.inode === b.inode;
}

function isSymlink(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertOwnerHeld(stat, targetPath) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('not-owner-held', `${targetPath} is not owned by the current user.`);
  }
}

/**
 * Open `targetPath` without ever following a final symlink and return the descriptor together with
 * the `fstat` that describes *that descriptor* — never a second pathname lookup. Callers must
 * `closeSync(fd)`.
 */
function openPinned(targetPath, { directory = false, missingCode, notTypeCode }) {
  let fd;
  try {
    fd = fs.openSync(
      targetPath,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0)
    );
  } catch (error) {
    // Diagnostic classification only — the open already failed, so nothing proceeds on the basis
    // of this lstat. It exists because O_NOFOLLOW|O_DIRECTORY reports a symlink-to-directory as
    // ENOTDIR on Linux, and "is a symlink" is a far more actionable message than "is not a
    // directory" for the operator reading a refused resume.
    if (error.code === 'ELOOP' || error.code === 'EMLINK' || isSymlink(targetPath)) {
      fail('symlink-rejected', `${targetPath} is a symlink.`);
    }
    if (error.code === 'ENOTDIR') {
      fail(notTypeCode, `${targetPath} is not a directory.`);
    }
    if (error.code === 'EISDIR') {
      fail(notTypeCode, `${targetPath} is a directory, not a regular file.`);
    }
    fail(missingCode, `${targetPath} could not be opened: ${error.message}`);
  }
  let stat;
  try {
    stat = fs.fstatSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fail(missingCode, `${targetPath} could not be stat'ed from its descriptor: ${error.message}`);
  }
  // O_DIRECTORY/O_NOFOLLOW already excluded the wrong-type and symlink cases on platforms that
  // implement them; re-assert from the descriptor so a platform lacking the flags still fails
  // closed rather than silently accepting a socket/device/FIFO.
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    fs.closeSync(fd);
    fail(
      notTypeCode,
      `${targetPath} is not a ${directory ? 'real directory' : 'regular file'} (mode ${stat.mode.toString(8)}).`
    );
  }
  try {
    assertOwnerHeld(stat, targetPath);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return { fd, stat };
}

function withPinned(targetPath, options, body) {
  const pinned = openPinned(targetPath, options);
  try {
    return body(pinned);
  } finally {
    fs.closeSync(pinned.fd);
  }
}

/**
 * List a directory whose identity is already pinned, re-pinning afterwards and comparing identity.
 * `readdir` has no descriptor-taking form in Node, so this is the one unavoidable name lookup —
 * bracketing it with the identity comparison turns a substitution into a hard verification failure
 * instead of a silent traversal of the replacement tree.
 */
function readdirPinned(dirPath, expectedIdentity) {
  let children;
  try {
    children = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    fail('artifact-read-failed', `${dirPath} could not be listed: ${error.message}`);
  }
  withPinned(
    dirPath,
    { directory: true, missingCode: 'partition-missing', notTypeCode: 'not-a-directory' },
    ({ stat }) => {
      if (!sameIdentity(identityOf(stat), expectedIdentity)) {
        fail('identity-substituted', `${dirPath} was substituted while it was being listed.`);
      }
    }
  );
  return children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function assertDirectChildName(name, code = 'invalid-relative-path') {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    fail(code, `Invalid direct-child name: ${JSON.stringify(name)}`);
  }
}

function assertSessionFileName(name) {
  assertDirectChildName(name, 'invalid-session-file-name');
  if (!SESSION_FILE_NAME_PATTERN.test(name)) {
    fail(
      'invalid-session-file-name',
      `Session file name must be a direct-child *.jsonl basename: ${JSON.stringify(name)}`
    );
  }
}

/** Read the whole of an already-pinned descriptor in fixed-size chunks, never allocating
 * proportional to the file size, enforcing `maxBytes` against bytes *observed while reading* (not
 * just the descriptor's declared size) and feeding each chunk to `onChunk`. */
function streamDescriptor(fd, maxBytes, onChunk, overflow) {
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let observed = 0;
  let position = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, STREAM_CHUNK_BYTES, position);
    if (read === 0) break;
    position += read;
    observed += read;
    if (observed > maxBytes) overflow(observed);
    onChunk(buffer.subarray(0, read));
  }
  return observed;
}

function collectCanonicalBlobRefs(value, sink, limits) {
  if (typeof value === 'string') {
    if (!value.startsWith(BLOB_REF_PREFIX)) return;
    if (!CANONICAL_BLOB_REF_PATTERN.test(value)) {
      // OMP's parseBlobRef only warns and falls back to treating a malformed ref as literal data
      // (blob-store.ts). Zeroshot cannot: a continuation whose externalized payload is
      // unaddressable is not a continuation we can prove, so this fails closed.
      fail('blob-reference-noncanonical', `Non-canonical blob reference ${JSON.stringify(value)}.`);
    }
    sink.add(value);
    if (sink.size > limits.maxBlobReferences) {
      fail('blob-references-exceeded', 'Session exceeds maxBlobReferences.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCanonicalBlobRefs(item, sink, limits);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) collectCanonicalBlobRefs(value[key], sink, limits);
  }
}

/**
 * Stream the session JSONL from its pinned descriptor: bound bytes/records, hash the raw content,
 * parse each record, verify the session header record, and collect every canonical nested blob
 * reference. A record is buffered only until its terminating newline; the aggregate byte bound
 * already caps how large any single record can get, so this never exceeds the declared session
 * budget.
 */
function streamSessionJsonl(fd, describePath, limits) {
  const hash = createHash('sha256');
  const blobRefs = new Set();
  let records = 0;
  let header = null;
  let pending = [];
  let pendingBytes = 0;

  function consumeRecord() {
    records += 1;
    if (records > limits.maxSessionRecords) {
      fail('session-records-exceeded', `${describePath} exceeds maxSessionRecords.`);
    }
    const line = Buffer.concat(pending, pendingBytes).toString('utf8');
    pending = [];
    pendingBytes = 0;
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail(
        'session-record-unparseable',
        `${describePath} record ${records} is not valid JSON: ${error.message}`
      );
    }
    if (header === null) header = parsed;
    collectCanonicalBlobRefs(parsed, blobRefs, limits);
  }

  const bytes = streamDescriptor(
    fd,
    limits.maxSessionBytes,
    (chunk) => {
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== NEWLINE) continue;
        pending.push(Buffer.from(chunk.subarray(start, i)));
        pendingBytes += i - start;
        start = i + 1;
        consumeRecord();
      }
      if (start < chunk.length) {
        pending.push(Buffer.from(chunk.subarray(start)));
        pendingBytes += chunk.length - start;
      }
      hash.update(chunk);
    },
    () => fail('session-bytes-exceeded', `${describePath} observed bytes exceed maxSessionBytes.`)
  );
  if (pendingBytes > 0) consumeRecord(); // trailing unterminated record

  return {
    bytes,
    records,
    digest: `sha256:${hash.digest('hex')}`,
    header,
    blobRefs: [...blobRefs].sort(),
  };
}

/** The session's first record is OMP's session header (`{type:"session", version, id, cwd, ...}` —
 * session-manager.ts `#resetToNewSession`). Its `id` is the authoritative session identity written
 * to disk and its `cwd` is the workspace the session belongs to. */
function parseSessionHeader(header, describePath) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    fail('session-header-missing', `${describePath} has no session header record.`);
  }
  if (header.type !== 'session') {
    fail(
      'session-header-invalid',
      `${describePath} first record is type ${JSON.stringify(header.type)}, not "session".`
    );
  }
  if (typeof header.id !== 'string' || header.id.length === 0) {
    fail('session-header-invalid', `${describePath} session header has no id.`);
  }
  return {
    sessionId: header.id,
    cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? path.resolve(header.cwd) : null,
    version: header.version ?? null,
  };
}

/** Verify one referenced blob at the *shared* OMP CAS root. Unlike partition files a blob may
 * legitimately carry more than one hard link: `blob-store.ts#ensureDisplayPath` hardlinks
 * `<hash>` to a typed `<hash>.<ext>` sidecar for OS image openers. Content is what is
 * authoritative here, and it is checked against the digest the reference names. */
function verifyBlobReference(ref, blobsDir, limits) {
  const hex = ref.slice(BLOB_REF_PREFIX.length);
  const blobPath = path.join(blobsDir, hex);
  return withPinned(
    blobPath,
    { missingCode: 'blob-missing', notTypeCode: 'blob-not-regular' },
    ({ fd, stat }) => {
      if (stat.size > limits.maxReferencedBlobBytes) {
        fail('blob-bytes-exceeded', `Referenced blob ${ref} exceeds maxReferencedBlobBytes.`);
      }
      const hash = createHash('sha256');
      streamDescriptor(
        fd,
        limits.maxReferencedBlobBytes,
        (chunk) => hash.update(chunk),
        () => fail('blob-bytes-exceeded', `Referenced blob ${ref} exceeds maxReferencedBlobBytes.`)
      );
      if (hash.digest('hex') !== hex) {
        fail('blob-digest-mismatch', `Referenced blob ${ref} content does not match its digest.`);
      }
      return blobPath;
    }
  );
}

function verifyBlobReferences(blobRefs, limits, blobsDirOptions) {
  if (blobRefs.length === 0) return { blobsDir: null, verified: [] };
  if (blobRefs.length > limits.maxBlobReferences) {
    fail('blob-references-exceeded', 'Session exceeds maxBlobReferences.');
  }
  const blobsDir = resolveOmpBlobsDir(blobsDirOptions);
  for (const ref of blobRefs) verifyBlobReference(ref, blobsDir, limits);
  return { blobsDir, verified: blobRefs };
}

/** Walk the partition subtree (everything except the session file itself), descriptor-pinning
 * every entry, and return the manifest entries in a deterministic order. */
function collectArtifactEntries(partitionPath, partitionIdentity, sessionFileName, limits) {
  const entries = [];
  const aggregate = { count: 0, bytes: 0 };

  function visit(absDir, dirIdentity, relDir, depth) {
    if (depth > limits.maxArtifactDepth) {
      fail('artifact-depth-exceeded', `Artifact tree exceeds maxArtifactDepth at ${relDir || '.'}.`);
    }
    for (const child of readdirPinned(absDir, dirIdentity)) {
      if (depth === 0 && child.name === sessionFileName) continue;
      assertDirectChildName(child.name);
      const absPath = path.join(absDir, child.name);
      const relPath = relDir ? `${relDir}/${child.name}` : child.name;
      if (Buffer.byteLength(relPath, 'utf8') > limits.maxRelativePathBytes) {
        fail('relative-path-bytes-exceeded', `${relPath} exceeds maxRelativePathBytes.`);
      }
      aggregate.count += 1;
      if (aggregate.count > limits.maxArtifactEntries) {
        fail('artifact-entries-exceeded', 'Artifact tree exceeds maxArtifactEntries.');
      }

      if (child.isSymbolicLink()) {
        fail('symlink-rejected', `${relPath} is a symlink.`);
      }
      if (child.isDirectory()) {
        const childIdentity = withPinned(
          absPath,
          { directory: true, missingCode: 'artifact-missing', notTypeCode: 'not-a-directory' },
          ({ stat }) => identityOf(stat)
        );
        entries.push({ relPath, type: 'dir', size: 0, contentDigest: '' });
        visit(absPath, childIdentity, relPath, depth + 1);
        continue;
      }
      if (!child.isFile()) {
        fail(
          'not-a-regular-single-link-file',
          `${relPath} is neither a regular file nor a directory.`
        );
      }

      const entry = withPinned(
        absPath,
        { missingCode: 'artifact-missing', notTypeCode: 'not-a-regular-single-link-file' },
        ({ fd, stat }) => {
          if (stat.nlink > 1) {
            fail('not-a-regular-single-link-file', `${relPath} has more than one hard link.`);
          }
          if (stat.size > limits.maxArtifactFileBytes) {
            fail('artifact-file-bytes-exceeded', `${relPath} exceeds maxArtifactFileBytes.`);
          }
          const hash = createHash('sha256');
          const observed = streamDescriptor(
            fd,
            limits.maxArtifactFileBytes,
            (chunk) => hash.update(chunk),
            () => fail('artifact-file-bytes-exceeded', `${relPath} exceeds maxArtifactFileBytes.`)
          );
          return {
            relPath,
            type: 'file',
            size: observed,
            contentDigest: `sha256:${hash.digest('hex')}`,
          };
        }
      );

      aggregate.bytes += entry.size;
      if (aggregate.bytes > limits.maxArtifactAggregateBytes) {
        fail('artifact-aggregate-bytes-exceeded', 'Artifact tree exceeds maxArtifactAggregateBytes.');
      }
      entries.push(entry);
    }
  }

  visit(partitionPath, partitionIdentity, '', 0);
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

/**
 * Full structural verification of a partition expected to already hold a session.
 * `expectedPartitionIdentity` (when supplied) is compared against the pinned directory before
 * anything inside it is read, so a partition directory swapped since it was recorded fails before
 * its contents can influence the manifest.
 *
 * `limits` and `blobsDirOptions` are seams for tests to prove enforcement and to point at a
 * fixture blob store — NOT configuration. No production caller passes either: the bounds are the
 * pinned OMP_SESSION_LIMITS (a negotiable ceiling would let a hostile partition pick its own
 * verification budget) and the blob root is whatever OMP itself would resolve.
 */
function verifyPartitionContents(
  partitionPath,
  sessionFileName,
  { expectedPartitionIdentity = null, limits = OMP_SESSION_LIMITS, blobsDirOptions } = {}
) {
  assertSessionFileName(sessionFileName);

  const partitionIdentity = withPinned(
    partitionPath,
    { directory: true, missingCode: 'partition-missing', notTypeCode: 'not-a-directory' },
    ({ stat }) => identityOf(stat)
  );
  if (expectedPartitionIdentity && !sameIdentity(partitionIdentity, expectedPartitionIdentity)) {
    fail(
      'partition-identity-mismatch',
      `${partitionPath} identity ${partitionIdentity.device}:${partitionIdentity.inode} does not match the recorded owner.`
    );
  }

  const sessionFilePath = path.join(partitionPath, sessionFileName);
  const session = withPinned(
    sessionFilePath,
    { missingCode: 'session-file-missing', notTypeCode: 'not-a-regular-file' },
    ({ fd, stat }) => {
      if (stat.nlink > 1) {
        fail('hard-link-rejected', `${sessionFilePath} has more than one hard link.`);
      }
      if (stat.size > limits.maxSessionBytes) {
        fail(
          'session-bytes-exceeded',
          `${sessionFilePath} declared size ${stat.size} exceeds maxSessionBytes.`
        );
      }
      return { identity: identityOf(stat), ...streamSessionJsonl(fd, sessionFilePath, limits) };
    }
  );

  const header = parseSessionHeader(session.header, sessionFilePath);
  const blobs = verifyBlobReferences(session.blobRefs, limits, blobsDirOptions);
  const artifactEntries = collectArtifactEntries(
    partitionPath,
    partitionIdentity,
    sessionFileName,
    limits
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
    partitionPath,
    partitionIdentity,
    sessionFilePath,
    sessionFileName,
    sessionFileIdentity: session.identity,
    sessionBytes: session.bytes,
    sessionRecords: session.records,
    sessionHeader: header,
    blobReferences: blobs.verified,
    blobsDir: blobs.blobsDir,
    artifactManifestDigest: `sha256:${manifestHash.digest('hex')}`,
  };
}

/** Lightweight check at spawn/`ready` for a *fresh* partition: the partition path is a real,
 * owner-held, descriptor-pinned directory whose identity still matches what was recorded (when
 * known). It deliberately does not walk the tree or read the session file — neither exists yet at
 * this point in a fresh session's lifecycle. */
function checkPartitionPathReady(partitionPath, { expectedPartitionIdentity = null } = {}) {
  const identity = withPinned(
    partitionPath,
    { directory: true, missingCode: 'partition-missing', notTypeCode: 'not-a-directory' },
    ({ stat }) => identityOf(stat)
  );
  if (expectedPartitionIdentity && !sameIdentity(identity, expectedPartitionIdentity)) {
    fail(
      'partition-identity-mismatch',
      `${partitionPath} identity does not match the recorded owner.`
    );
  }
  return { partitionPath, partitionIdentity: identity };
}

/** Full verification of an existing (resume) partition: before spawn and again before prompt. */
function verifyExistingOmpPartition(partitionPath, sessionFileName, options = {}) {
  return verifyPartitionContents(partitionPath, sessionFileName, options);
}

/** Full verification after terminal materialization of a fresh session, before its ownership
 * record may be committed as resumable. */
function verifyFreshMaterialization(partitionPath, sessionFileName, options = {}) {
  return verifyPartitionContents(partitionPath, sessionFileName, options);
}

module.exports = {
  BLOB_REF_PREFIX,
  CANONICAL_BLOB_REF_PATTERN,
  OmpSessionVerificationError,
  checkPartitionPathReady,
  verifyExistingOmpPartition,
  verifyFreshMaterialization,
  verifyPartitionContents,
};
