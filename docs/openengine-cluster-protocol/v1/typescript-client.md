# Cluster Protocol v1 TypeScript client

This document defines the TypeScript client's public surface: import paths, the injectable
WebSocket factory, and the two client-side guarantees that diverge from a naive per-call
implementation -- shared request-id allocation and stale-transport-free watch reconnect. The Rust
client and the wire types in `watch.md`/`data-plane.md` remain the sole protocol authority; this
package only binds them to TypeScript. Generated wire types live in `src/cluster/generated/` and
are produced solely by `scripts/generate-cluster-wire-types.js` from
`protocol/openengine-cluster/v1/*.json` -- never hand-edited.

## Import paths

The client is published as the `@the-open-engine/zeroshot/cluster` subpath, resolvable from
CommonJS, ESM, and TypeScript alike; the package's existing default entrypoint and deep imports are
unchanged.

```js
// CommonJS
const { connectCluster } = require('@the-open-engine/zeroshot/cluster');
```

```js
// ESM
import { connectCluster } from '@the-open-engine/zeroshot/cluster';
```

```ts
// TypeScript
import { connectCluster, type ClusterConnection } from '@the-open-engine/zeroshot/cluster';
```

## Connecting

```ts
import { connectCluster } from '@the-open-engine/zeroshot/cluster';

const connection = await connectCluster('wss://cluster.example.com/v1');
const status = await connection.client.get();
const watch = await connection.watch({ runId: status.status.currentRunId ?? undefined });

for await (const delivered of watch) {
  console.log(delivered.runId, delivered.cursor, delivered.event);
}

connection.close();
```

`connectCluster` dials one WebSocket, wraps it in a single `ConnectionMultiplexer`, and returns a
`ClusterClient` plus factories for the three subscription methods (`watch`, `logs`, `attach`) --
all sharing that one transport and its id space.

## WebSocket factory injection

Node >=18 has no global `WebSocket`, so the default factory lazily `import()`s the `ws` package the
first time it actually needs to dial (never eagerly, so a browser bundle can tree-shake that branch
out). Node >=22 and browsers use the global `WebSocket` instead. Inject a factory to point at a
custom implementation (a test double, a proxy-aware socket, a browser-specific wrapper):

```ts
import { connectCluster, type WebSocketFactory } from '@the-open-engine/zeroshot/cluster';

const webSocketFactory: WebSocketFactory = (url, protocols) => new MyWebSocket(url, protocols);

const connection = await connectCluster('wss://cluster.example.com/v1', { webSocketFactory });
```

A factory returns anything satisfying `WebSocketLike` (readyState, `send`, `close`, and DOM-style
`addEventListener`/`removeEventListener` for `open`/`message`/`close`/`error`), synchronously or as
a `Promise`.

## Shared-transport request-id allocation

Every `ClusterClient` and subscription factory built on one `ConnectionMultiplexer` mints unary and
subscription-establish request ids from that multiplexer's single shared counter -- never from a
per-client counter. Two `ClusterClient`s constructed over the same transport (for example, one held
by application code and one held internally by a reconnect path) can issue concurrent calls without
ever colliding on request id, because id allocation is owned by the connection, not by however many
clients sit on top of it.

## Watch reconnect

`WatchSubscriptionStream.reconnect(freshClient)` re-establishes a `watch` subscription after its
underlying transport has failed or been closed. It always dials through `freshClient`'s own
transport -- never the original, presumed-dead one -- replays from the last event this stream
actually admitted (or, if it never admitted one, from the coherent tail cursor captured at this
stream's own establishment), and carries its `(runId, cursor)` de-duplication set across the
boundary so a redelivered boundary event is suppressed, not yielded twice:

```ts
import { connectCluster } from '@the-open-engine/zeroshot/cluster';

let connection = await connectCluster(url);
let watch = await connection.watch({ runId });

async function reconnect() {
  connection = await connectCluster(url);
  watch = await watch.reconnect(connection.client);
}
```

## Cancellation

Unary calls accept an `AbortSignal` via `{signal}`; firing it sends `$/cancelRequest` and rejects
the call's promise exactly once with an `AbortError`, even under concurrent double-abort.
Subscriptions expose `.cancel()`, and their async iterator's `return()` (invoked by `for await...of`
`break`/`return`/`throw`) routes through the same idempotent guard -- either path, or both at once,
sends `subscription/cancel` exactly once.

`logs` and `agent/attach` subscriptions never expose a cursor or a `reconnect` method: both are
non-resumable on the wire, matching their Rust contract exactly.
