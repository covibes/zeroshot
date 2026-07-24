# Cluster Protocol v1 operational lifecycle

This contract adds operational `update` and `stop` controls to an admitted run. The Rust protocol
types are authoritative. The deterministic testkit backend proves the state machine and durable
records; it is not a native graph scheduler, worker executor, or process-freezing runtime.

## Initialize capabilities

`initialize` returns `capabilities.graphProfiles`, a deterministic, duplicate-free array of
supported graph profiles in canonical ascending order (`openengine.graph.full/v1` before
`openengine.graph.single-worker/v1`). The default is an empty array: a backend advertises a
profile only once its own certification issue upgrades its production factory to claim that
profile. Testkit-scripted capability vectors exist to verify wire shape and dispatcher plumbing;
they make no production claim about any backend's actual conformance.

## Update

`update({labels?, logLevel?, suspended?, ifGeneration, idempotencyKey})` requires at least one
operational field. `labels` is a complete replacement map with at most 64 bounded key/value pairs;
`logLevel` is one of `trace`, `debug`, `info`, `warn`, or `error`; `suspended` is boolean. The closed
request rejects graph, input, policy, worker, null, and unknown fields. Update preserves the graph,
compiled identity, root input, generation, run ID, and admission cursor.

Suspension is a durable dispatch gate, not a process freeze. It denies every new successor permit
but leaves existing leases alive. An existing black-box call may finish while suspended and append
its verified output. Resume returns the gate to `active`, after which successor dispatch continues
from the latest durable cursor.

## Stop

`stop({mode, ifGeneration, idempotencyKey})` accepts `drain` or `force`.

- Drain closes the dispatch gate and waits for every existing lease. The final verified or failed
  settlement atomically appends the single terminal `finished` record. With no in-flight lease,
  stop finishes immediately. Drain invokes no `onComplete` or other hook absent from the authored
  graph contract.
- Force closes the gate, signals every lease cancellation token, records each cancelled turn as
  structural void state with no outcome, and appends the single terminal `finished` record. A force
  request escalates an existing drain; a drain request never downgrades force.

The terminal `finished` record is the last lifecycle event. Late dispatch, completion, update, and
new stop mutations are rejected without appending lifecycle or verified-I/O records. Exact replay
of a previously accepted idempotency key remains available and cannot append a second terminal
record.

## Retry

`retry({ifGeneration, idempotencyKey})` is the single authoritative same-run manual retry. Unlike
`update` and `stop`, `retry` carries no turn, input, or other execution selector: the server always
targets its own store-tracked latest unconsumed failed dispatch frontier. A closed request rejects
`mode`, `turnId`, `executionId`, `session`, `workspacePath`, `provider`, and any other unknown field.

Only a pending retryable failed frontier admits retry. Every other observable state fails closed
with `NO_RETRYABLE_FRONTIER` and a closed `reason`: `exhausted` (no turn has failed or the authored
attempt allowance is exhausted), `success` (the frontier turn already completed), `active` (one or
more turns are still leased), or `consumed` (the frontier was already retried). A stale generation
returns `GENERATION_CONFLICT`; a terminal graph or a non-`active` dispatch state (suspended,
draining, force-stopping, stopped) returns `INVALID_PHASE`.

Retry reuses the exact recorded verified input, admitted target, workspace policy, and deadline of
the original run; it never accepts caller-supplied replacement data and never allocates a new run
ID or generation. It mints and durably reserves one new internal turn identity for the retried
attempt. Until that reserved retry turn is dispatched, a stale error-successor dispatch is rejected.
A concurrent error-successor may instead win first by atomically clearing the failed frontier, in
which case retry fails closed; exactly one side is accepted. Dispatching the reserved retry turn
consumes the intent, and every turn identity remains single-use across failures as well as successes.
Retry is a same-run intent record only; it does not itself establish a new dispatch lease or invoke
a worker, and no automatic or background code path in this protocol ever calls it.

## Resubmit

`resubmit({ifGeneration, ifRunId, idempotencyKey, replacementInput?})` mints a new run from a
terminal retained run at the same graph generation. Unlike `update`, `stop`, and `retry`, resubmit
carries a run CAS (`ifRunId`) in addition to the generation CAS, and an optional `replacementInput`.
A closed request rejects `mode`, `turnId`, `provider`, `config`, `source`, and any other unknown or
execution-selector field.

Only a terminal run (`phase: finished`) admits resubmit; every other phase fails closed with
`INVALID_PHASE`. A stale `ifGeneration` returns `GENERATION_CONFLICT`; a stale `ifRunId` (the
cluster has since moved to a different run) returns `RUN_CONFLICT`. A `replacementInput` that fails
the graph's closed `initialInput` payload-type validation returns `SCHEMA_VIOLATION`.

Resubmit always allocates a new run ID and cursor; it never changes generation or the admitted
graph or compiled IR. With no `replacementInput`, it reuses the prior run's exact recorded verified
seed input. With a `replacementInput`, that value is verified against the graph's `initialInput`
schema and becomes the new run's verified seed. The prior run and its watch history remain readable
and terminally immutable; resubmit appends no records to it.

## Delete

`delete({ifGeneration, ifRunId?, idempotencyKey})` is the authoritative terminal-cluster deletion
with an exclusive cleanup fence. A closed request rejects `mode`, `turnId`, `provider`, `config`,
`source`, `replacementInput`, and any other unknown or execution-selector field.

Only an empty cluster (`phase: empty`) or a terminal run (`phase: finished`) admits delete; every
other phase — including a delete already held pending cleanup — fails closed with `INVALID_PHASE`.
This single rule covers both non-terminal rejection and competing-delete-during-cleanup rejection,
since the held cleanup fence's phase is never `empty` or `finished`. `ifRunId` is optional: omit it
(or pass no run) to match an empty cluster's absent current run, exactly as a stale `ifGeneration`
returns `GENERATION_CONFLICT` and a stale `ifRunId` returns `RUN_CONFLICT`.

On an empty cluster, delete is a history-free no-op: it returns `deleted:false`, `phase:empty`, and
mutates nothing. On a terminal run, delete commits exclusive ownership before any external cleanup:
it either finalizes immediately (`deleted:true`, `phase:empty`) or, if cleanup is not yet
authoritatively confirmed, holds the resource in the `deleting` phase (`deleted:false`,
`phase:deleting`) with its generation, run ID, and cursor observable but otherwise unchanged. The
`deleting` phase fences `apply`, `resubmit`, `dispatch`, and any competing `delete` until every
backend-owned resource is confirmed absent — delete never claims to have rolled back those external
effects itself. While cleanup is indeterminate, no history is erased and the resource never reports
empty. Only once cleanup is authoritatively confirmed does delete remove the deleted run's durable
lineage: `get` becomes empty, the deleted run's watch history reports `GONE`, and the next `apply`'s
generation resets to `1`. A repeated delete after removal is again a history-free no-op.

## CAS, idempotency, and acknowledgements

All five mutation methods require an exact generation CAS; resubmit and delete additionally require
an exact (for delete, optional) run CAS. Fingerprints bind the method and canonical validated
parameters except `idempotencyKey`. Same-key replay returns the original receipt with
`deduped:true`; changed parameters or cross-method key reuse returns `IDEMPOTENCY_REUSE`.

Stop receipts acknowledge the accepted mode, effective monotonic mode, and durable lifecycle
state. They do not claim that external side effects were rolled back, that cancellation made an
already-started call side-effect-free, or that a worker never observed the request. Force prevents
late output from becoming verified protocol output; it cannot undo effects outside this protocol.

## Status and fixture boundary

Admitted status includes labels, log level, dispatch state, optional stop mode, and in-flight count.
The resource phase remains `running` during active, suspended, and draining operation, becomes
`finished` exactly once, and — only while a terminal run's delete cleanup is indeterminate — holds
`deleting` before returning to `empty`. `InMemoryAdmissionStore` serializes admission and lifecycle
mutations under one mutex solely for deterministic conformance tests, and its pending-cleanup fence
is resolved by a test-only hook standing in for a future backend cleanup executor. Scripted
`running`, `finished`, and `deleting` states do not imply native node execution, production
cancellation, or a real cleanup executor.
