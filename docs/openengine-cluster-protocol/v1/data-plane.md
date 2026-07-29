# Cluster Protocol v1 WebSocket data plane

This document defines the production Rust WebSocket binding: the wire framing that carries the
backend-neutral `Dispatcher` and the generic subscription framing defined in
[`watch.md`](./watch.md) through `openengine-cluster-server`'s transport-neutral `connection` core
over one WebSocket connection, plus the boundary between that binding and everything that hosts it.
It adds no protocol method or event semantics of its own beyond `$/cancelRequest`; every method,
event, and generic subscription notification is unchanged from the in-process and NDJSON bindings.

## Framing

One WebSocket text message carries exactly one JSON-RPC object (request, response, or
notification) -- there is no line delimiter and no batching. A binary frame is not a supported
encoding: it closes the connection immediately with code `1003` (unsupported data). A text message
whose UTF-8 byte length exceeds `1,048,576` after frame reassembly closes the connection with code
`1009` (message too big), matching the NDJSON stdio binding's line-length bound. A text message that
fails to parse as JSON-RPC receives a normal `PARSE_ERROR` JSON-RPC error response on the same
connection; unlike the size and encoding violations above, a parse failure does not close the
connection. Ping/pong control frames are answered automatically and otherwise ignored.

Subscription delivery reuses the exact same generic `event`/`subscription/cancel`/
`subscription/closed` notification framing described in `watch.md` -- there are no
WebSocket-specific subscription notification names, and results/events/errors are byte-equivalent
between the in-process, NDJSON, and WebSocket bindings for the same request sequence.

## `$/cancelRequest`

`$/cancelRequest{id}` is a client notification, best-effort cancelling an in-flight unary request by
its `RequestId` on the same connection. It carries no response of its own. An unknown or
already-completed id is a silent no-op: the connection remains fully usable and no error is
surfaced. Cancelling a request that has already committed backend state leaves that committed state
unchanged -- there is no rollback or compensation, only suppression of the (otherwise still
in-flight) response delivery. `$/cancelRequest` targets unary/passthrough requests only; an
established `watch`/`logs`/`agent/attach` subscription is cancelled with `subscription/cancel`
instead, exactly as over NDJSON.

## Connection isolation over a shared backend

One backend instance can be shared by multiple independently accepted WebSocket connections. At
acceptance, the binding invokes its host-owned identity resolver exactly once, before decoding the
first frame, and constructs an immutable `ConnectionContext` containing the resulting typed
`ConnectionIdentity`: opaque principal and tenant identifiers, optional issuance time, required
hard expiry, and binding-specific opaque attributes. Identity has no serde/wire representation.
`principal`, `tenant`, and `expiresAt` keys in protocol params are ordinary unknown fields and fail
typed parameter decoding with `INVALID_PARAMS`; they never change the connection identity.

The binding checks expiry at every inbound request decode boundary. A frame observed at or after
`expires_at_ms` reaches neither admission nor the backend: WebSocket closes with application code
`4401`, while NDJSON writes one terminal diagnostic and closes. The dispatcher never partitions
state. Connections with the same or distinct tenants observe exactly the sharing or isolation
chosen by the backend that receives their read-only contexts.

## Capsule data-plane placement

This binding is the data-plane surface exposed by one capsule: the runtime process or container
that accepts WebSocket connections and serves one backend's `Dispatcher` over them. Everything
upstream of an accepted connection is owned by whatever hosts that capsule, not by this crate:

- provisioning or scheduling the capsule itself;
- TLS termination (this binding speaks plain WebSocket text frames; TLS, if any, terminates in
  front of it);
- resolving the principal, tenant, expiry, and opaque binding attributes supplied to the
  connection's identity resolver;
- billing and usage metering;
- workspace or secret storage/services;
- artifact bytes (this protocol carries status, events, and control -- never artifact payloads);
- issuing or validating the token/credential that authorized the connection.

A hosting process accepts the raw connection and supplies `ConnectionBinding` with its shared
backend, identity resolver, time source, and connection cancellation signal. `serve_websocket`
preserves that cancellation handle while resolving identity and constructing the context before
reading frames; this document defines only what happens from that handoff onward.

## Client dialing and TLS

`openengine-cluster-client::dial_websocket` is the outbound network boundary, separate from the
plaintext server binding above. It accepts only `ws://` and `wss://` endpoints with a host and
rejects userinfo, query strings, and fragments before opening a socket. It connects only to the
validated endpoint supplied by its caller: WebSocket redirect handshake responses are errors, their
`Location` targets are never opened, and `wss://` is never downgraded to `ws://`.

The workspace TLS implementation is rustls 0.23 with tokio-rustls 0.26, selected through
tokio-tungstenite's rustls native-root connector. A `wss://` connection loads platform/system roots
by default and fails closed if they cannot be loaded. Callers may explicitly add private CA roots
for one connection. The optional `bundled-roots` client feature is disabled by default and augments
the successfully loaded system store; bundled roots are never an automatic fallback for an
unavailable system store. A `ws://` endpoint, including loopback, is refused unless that individual
connection uses `WebSocketDialOptions::allow_plaintext(true)`.

Native TLS is intentionally excluded: on Linux it resolves to `openssl-sys`, imposing a system
OpenSSL build dependency that breaks cross-compilation and static-musl builds. TLS features are
enabled only by the dialing client; `openengine-cluster-server::serve_websocket` remains a
plaintext, accepted-stream binding whose production TLS termination stays in its front proxy.

## Future cloud HTTP binding

A future cloud HTTP binding may use the same rustls/tokio-rustls stack inside
`openengine-cluster-server`: accept TCP, perform the TLS handshake with a server `rustls`
configuration, and hand the resulting asynchronous stream to an HTTP server implementation. This
issue does not implement that listener, certificate provisioning, or HTTP binding. `reqwest` is an
HTTP client and cannot serve the binding; selecting an HTTP server remains a separate decision.

## Fixture and test boundary

`crates/openengine-cluster-server/tests/websocket.rs` covers this binding's own framing and
admission behavior directly against raw tungstenite frames.
`crates/openengine-cluster-client/tests/websocket.rs` covers the typed `WebSocketTransport` client
against the same binding. `crates/openengine-cluster-testkit/tests/protocol_websocket.rs` proves
byte-equivalence against the in-process and NDJSON bindings and exercises two independently
authorized connections sharing one backend. Those established framing suites continue to drive
`serve_websocket` over an in-memory duplex pipe. Real loopback TCP, TLS trust, plaintext opt-in,
preflight, and redirect behavior belongs to
`crates/openengine-cluster-client/tests/tls_dialer.rs`.
