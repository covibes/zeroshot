# Cluster Protocol v1 durable watch

This document defines the durable observation contract: retained per-run events, opaque cursors,
generic subscription framing, and snapshot-tail reconnect. The Rust wire types are authoritative.
This document defines the wire types and in-process Rust client/server behavior. The shared
connection/session/subscription machinery lives in `openengine-cluster-server`'s transport-neutral
`connection` core; the NDJSON stdin/stdout binding remains in its `stdio` module, and the production
WebSocket binding -- framing, close codes, `$/cancelRequest`, and the hosted data-plane boundary --
is defined in [`data-plane.md`](./data-plane.md).

## Method and framing

`watch({runId?, fromCursor?})` establishes a subscription and returns one normal JSON-RPC result,
`{subscriptionId, runId?, atCursor?}`. `runId` and `atCursor` are both null while the subscription
is parked (no run resolved yet — omitted `runId` with no current run). Otherwise `atCursor` is the
coherent tail cursor captured at subscription establishment.

Subscription delivery reuses one generic framing shared by future subscription-based methods (for
example logs/attach), not method-specific wire names:

- server notification `event` — carries `EventNotification{subscriptionId, runId, cursor, event}`;
- client notification `subscription/cancel` — carries `SubscriptionCancelParams{subscriptionId}`;
- terminal server notification `subscription/closed` — carries
  `SubscriptionClosedNotification{subscriptionId, reason, lastDeliveredCursor?}`.

There is no `watch/event`, `watch/cancel`, or `watch/closed` method on the wire. `watch` itself
returns exactly one JSON-RPC response for its request ID; every subsequent item is a notification.

## Event algebra

`Cursor` is an opaque string; it carries no sequence number, offset, or timestamp ordering key on
the wire. `WatchEvent` is a closed, tagged (`type`) enum:

- `phase{status, admission?}` — folds the observable cluster status (admission commit, update,
  suspend/resume, stop-request). The admission transition (`admission.runId/spec/seedInput`) is
  present only on the event that also commits the run.
- `node_begin{node, input}` / `node_end{node, outcome}` — a structured `NodeAddress{node, attempt}`
  plus verified input or a normalized `WorkerOutcome`. This is a testkit-only synthetic hook for
  golden vectors; it is not derived from real node dispatch, since no native graph executor exists
  yet.
- `bookmark` — advances the cursor with no public fold change (internal dispatch/lease turn
  bookkeeping).
- `fault{fault}` — a durable, closed, bounded, backend-neutral `BackendFault` projection (bounded
  code, consequence, retry disposition, action, severity, engine-owned summary, safe source
  frames, and opaque event identity). It correlates to the enclosing `EventNotification.runId`
  plus its own optional opaque `executionRef`; retry disposition and action are descriptive only
  and never authorize a retry, and emission never itself changes terminal semantics -- it folds to
  no public status change, exactly like `bookmark`. Raw messages, paths, URLs, headers, commands,
  provider codes, credentials, session IDs, and arbitrary maps are unrepresentable. Native
  `EngineFault` mapping is out of scope here and tracked by a later issue, the same way
  `node_begin`/`node_end`'s synthetic hook is.
- `finished{finalStatus, stopMode?}` — always the last event for a run.

A continuous watch from a run's first cursor through its `finished` event, after `(runId, cursor)`
deduplication, folds to the same public state as an authoritative `get` at the same cursor.

## At-least-once delivery and reconnect

Delivery is at-least-once: the same physical `(runId, cursor)` record may be redelivered (for
example after a slow-consumer reconnect). Duplicates are legal; the Rust client
(`ReconnectingEventStream`) deduplicates by `(runId, cursor)` before yielding an event, and that
dedup set survives reconnect.

Each subscription has a bounded live-delivery queue (`DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY = 1024`
by default). Overflow closes only that subscription with
`subscription/closed{reason: "SLOW_CONSUMER", lastDeliveredCursor}`; the server records
`lastDeliveredCursor` only for an event actually yielded by the in-process stream or written by the
transport, never from a caller-supplied acknowledgement. Reconnecting with
`watch({runId, fromCursor: lastDeliveredCursor})` replays from that cursor (inclusive) through the
current tail with no gap, then switches to live delivery; client-side dedup removes the
redelivered boundary event. Cancelling a subscription (dropping the client's watch handle, or
`subscription/cancel`) only removes that subscription's live-delivery registration; it never
mutates admission or lifecycle cluster state.

## Snapshot-tail handoff

Subscription establishment is atomic: resolve the requested run (explicit `runId`, or the current
run when omitted), capture the coherent retained replay tail, and register live delivery, all under
one store critical section. No event committed after that section releases can fall in a gap
between the captured tail and the first live-delivered event. Replay from the requested cursor
through the captured tail is then read in bounded pages (never the whole retained suffix at once);
live events remain bounded by the subscription's queue and are delivered strictly after replay, in
cursor order.

`get.atCursor` is null for empty state; `watch({fromCursor: null})` with no current run parks and
attaches to the next committed run. An explicit `fromCursor` that never appears in the resolved
run's retained history, or an explicit unknown `runId`, returns `NOT_FOUND`.

## Retained history and deletion boundary

Per-run history is retained across supersession by a new run until an explicit tombstone. A
tombstoned run returns `GONE` from `watch`; a superseded but non-tombstoned run remains watchable
by explicit `runId`. There is no implicit retention limit or automatic expiry in this slice — an
authoritative delete/retention contract is future scope, and the testkit's `tombstone_run` helper
exists only as that future contract's boundary prerequisite.

## Fixture boundary

`InMemoryAdmissionStore` in the testkit is a deterministic, in-process fixture: retained history
and live subscriber fan-out live entirely in process memory behind one store mutex, purely for
conformance testing. It is not a production ledger, does not persist across process restarts, and
its `node_begin`/`node_end` and `emit_fault_event` golden-vector hooks are synthetic, decoupled from
real graph execution and real backend fault reporting respectively. A native ledger's
`ObservationStore` projection (consuming these wire types unchanged) is owned by a later issue.
