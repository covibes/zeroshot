// Non-configurable bounds for OMP session partition verification (src/omp-session-verifier.js).
// Every value is pinned exactly as specified by issue #866; do not derive these from settings or
// environment — a configurable ceiling here would let a compromised/misbehaving OMP process (or a
// hostile resumed partition) negotiate its own verification budget.
interface OmpSessionLimits {
  readonly maxSessionBytes: number;
  readonly maxSessionRecords: number;
  readonly maxArtifactEntries: number;
  readonly maxArtifactDepth: number;
  readonly maxRelativePathBytes: number;
  readonly maxArtifactFileBytes: number;
  readonly maxArtifactAggregateBytes: number;
  readonly maxBlobReferences: number;
  readonly maxReferencedBlobBytes: number;
}

const OMP_SESSION_LIMITS: Readonly<OmpSessionLimits> = Object.freeze({
  maxSessionBytes: 268435456,
  maxSessionRecords: 1000000,
  maxArtifactEntries: 4096,
  maxArtifactDepth: 16,
  maxRelativePathBytes: 4096,
  maxArtifactFileBytes: 268435456,
  maxArtifactAggregateBytes: 536870912,
  maxBlobReferences: 4096,
  maxReferencedBlobBytes: 67108864,
});

/**
 * The largest single JSONL record the verifier will buffer, DERIVED from the constants above
 * rather than chosen — it is `maxReferencedBlobBytes`, and it is not a new knob (there is nothing
 * to configure and no caller may override it).
 *
 * Why a per-record bound is needed at all: `maxSessionBytes` bounds the *file*, not a line within
 * it. A hostile 256 MiB session with no newline in it is one record, and buffering it would cost
 * the raw bytes, a concatenated copy, a UTF-16 string for JSON.parse, and the parsed value — a
 * multi-hundred-megabyte spike driven entirely by the attacker's choice of where to put newlines.
 *
 * Why this value: `maxReferencedBlobBytes` is the issue's own answer to "how large may one
 * addressable unit of session content be". OMP externalizes anything bigger than a message to the
 * shared CAS store (blob-store.ts) and leaves only a 76-byte `blob:sha256:<hex>` reference in the
 * record, so a legitimate record is orders of magnitude smaller than this; the bound exists to cap
 * the pathological case, not to constrain real transcripts.
 *
 * Remaining allocation, exactly: verification buffers at most MAX_SESSION_RECORD_BYTES of raw
 * record bytes, and `JSON.parse` necessarily materializes that record as one UTF-16 string plus its
 * parsed value. Peak per-record cost is therefore O(MAX_SESSION_RECORD_BYTES) and independent of
 * `maxSessionBytes`, the record count, and the file's newline placement. Nothing else in the
 * verifier accumulates session, artifact, or blob bytes.
 */
const MAX_SESSION_RECORD_BYTES = OMP_SESSION_LIMITS.maxReferencedBlobBytes;

export = { OMP_SESSION_LIMITS, MAX_SESSION_RECORD_BYTES };
