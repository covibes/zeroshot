// Non-configurable bounds for OMP session partition verification (src/omp-session-verifier.js).
// Every value is pinned exactly as specified by issue #866; do not derive these from settings or
// environment — a configurable ceiling here would let a compromised/misbehaving OMP process (or a
// hostile resumed partition) negotiate its own verification budget.
const OMP_SESSION_LIMITS = Object.freeze({
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

module.exports = { OMP_SESSION_LIMITS };
