# Cluster Protocol v1 admission

This document defines the stateful `plan`, `apply`, and `get` admission contract. The Rust wire
types are authoritative. Admission accepts only `GraphSpec`; it does not execute graph nodes.

## Methods

`plan({graph})` invokes the configured verifier and returns `{ok, diagnostics, bounds?}`. `bounds`
is present only after approval. Planning is pure in the graph: it never reads cluster state or an
idempotency record and never writes the control journal or verified-I/O ledger.

`apply({graph, input?, dryRun?, ifGeneration?, idempotencyKey?})` defaults `dryRun` to false.

- Dry run omits `input` and `idempotencyKey`, verifies the graph, and returns a deterministic node
  diff against the committed compiled IR. It creates no generation, run, cursor, journal entry,
  seed entry, or idempotency record.
- Committed apply requires a non-empty idempotency key of at most 256 non-control characters.
- A create or changed compiled identity requires `input`, validates it against the graph's closed
  `initialInput` payload type, assigns a new run ID, and commits generation 1 or the next
  JavaScript-safe generation.
- An unchanged compiled identity omits `input`, preserves generation and run ID, and records only
  the idempotency receipt. Supplying a new root input for an unchanged graph is `resubmit`'s job,
  not `apply`'s; see [`lifecycle.md`](./lifecycle.md#resubmit).

`get({atCursor?})` returns the committed `GraphSpec`, status, and cursor from one atomic aggregate
snapshot. The logical control journal and verified-I/O seed ledger must identify the same current
run and cursor. An `empty` snapshot has no spec, compiled IR, generation, run, cursor, or seed. A
`running` or `finished` snapshot has all six, uses a positive generation, and has a seed matching
its run and admission cursor. Its operational lifecycle snapshot has a matching durable latest
cursor and metadata; lifecycle events advance that cursor without changing the admission cursor.
Transient `admitting` preserves either the complete prior committed snapshot or the complete empty
snapshot; it never exposes partially staged state. `initialize` and `get` fail closed when a store
violates these invariants. Operational lifecycle semantics are defined in
[`lifecycle.md`](./lifecycle.md); they do not synthesize a native graph executor.

## Diff and identity

Graph equality is the verifier-returned `CompiledGraphIr::identity()`. Diff arrays contain stable
node names and are lexically sorted. `added`, `removed`, and `changed` compare canonical normalized
node bytes; duplicate names in verifier output are rejected. A bounds-only identity change can
therefore start a new run with an empty node diff.

## CAS and idempotency

`ifGeneration: 0` asserts an empty cluster. Positive `N` asserts current generation `N`. Omission
is upsert. Final CAS evaluation occurs inside the atomic commit and conflicts report
`GENERATION_CONFLICT` plus the current generation.

The idempotency fingerprint is SHA-256 over canonical JSON containing the method and validated
parameters, excluding `idempotencyKey`. Object keys are recursively sorted. Same key and same
fingerprint returns the original receipt with `deduped:true`; different parameters return
`IDEMPOTENCY_REUSE` without verification or writes. Keys share one namespace across apply, update,
and stop, so cross-method reuse also conflicts. Racing first uses may both verify, but only one
commits.

## Atomicity and cancellation

One aggregate-store transaction allocates the append order for the control receipt, verified seed,
and idempotency receipt. Implementations check the injected cancellation signal while holding the
final transaction boundary and before any effect. Invalid input, stale CAS, conflicting key reuse,
verifier rejection, or pre-commit cancellation leaves the previous snapshot untouched. Once commit
succeeds, response loss or later cancellation cannot roll it back; retrying the key recovers the
receipt.

Stable domain codes are `GRAPH_INVALID`, `SCHEMA_VIOLATION`, `GENERATION_CONFLICT`,
`IDEMPOTENCY_REUSE`, `INVALID_PHASE`, and `CANCELLED`. JSON-RPC numeric classes remain unchanged;
details contain only diagnostics and current public state.

## Fixture boundary

`ScriptedVerifier` and `InMemoryAdmissionStore` in the testkit are deterministic fixtures. Their
approval is a scripted verifier assertion, and phase `running` records admitted run state only.
Neither fixture advertises native verification or production execution of
`openengine.graph.full/v1`.
