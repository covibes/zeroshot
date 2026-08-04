UPDATE THIS FILE when making architectural changes, adding patterns, or changing conventions.

# Zeroshot: Multi-Agent Coordination Engine

Operational rules and references for automated agents working on this repo. Install:
`npm i -g @the-open-engine/zeroshot` or `npm link` (dev).

## CRITICAL RULES

- Never spawn without permission. Do not run `zeroshot run <id>` unless the user explicitly asks to run it.
- Never use git in validator prompts. Validate files directly.
- Never ask questions. Agents run non-interactively; make autonomous decisions.
- Never edit `CLAUDE.md` unless explicitly asked to update docs.
- Detached (`-d`) runs must forward all `zeroshot run` options via `ZEROSHOT_RUN_OPTIONS` (see `buildDaemonEnv` + `buildStartOptions`) so PR/worktree config cannot be dropped.
- `main` is the single development and release trunk. Target normal PRs at `main`; never recreate a
  long-lived `dev -> main` release-promotion flow.
- Pull request titles are Conventional Commit headers because squash merge makes the title the
  released commit. `fix:`/`perf:` publish patches, `feat:` publishes minors, breaking syntax
  publishes majors, and `docs:`/`chore:` intentionally publish nothing.
- The checked-in package version is always `0.0.0-development`. Release tags, npm metadata, and
  GitHub Releases are authoritative; release automation must never commit versions back to `main`.
- Curated notes live at `docs/releases/vX.Y.Z.md`. Recovery may operate only from an immutable
  `vX.Y.Z` tag whose exact commit is an ancestor of `main`, and it must never overwrite an existing
  npm version or GitHub Release.

Worker git operations are allowed only with isolation (`--worktree`, `--docker`, `--pr`, `--ship`). They are forbidden without isolation.

Read-only safe commands: `zeroshot list`, `zeroshot status`, `zeroshot logs`

Destructive commands (need permission): `zeroshot kill`, `zeroshot clear`, `zeroshot purge`

## Where to Look

| Concept                               | File                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Conductor classification              | `src/conductor-bootstrap.js`                                                                                                     |
| Base templates                        | `cluster-templates/base-templates/`                                                                                              |
| Message bus                           | `src/message-bus.js`                                                                                                             |
| Ledger (SQLite)                       | `src/ledger.js`                                                                                                                  |
| Guidance topics                       | `src/guidance-topics.js`                                                                                                         |
| Guidance mailbox helper               | `src/ledger.js`                                                                                                                  |
| Guidance live injection               | `src/orchestrator.js`                                                                                                            |
| Trigger evaluation                    | `src/logic-engine.js`                                                                                                            |
| Agent wrapper                         | `src/agent-wrapper.js`                                                                                                           |
| Providers registry                    | `src/providers/index.js`                                                                                                         |
| Provider implementations              | `src/providers/`                                                                                                                 |
| Provider engine registry              | `src/agent-cli-provider/provider-registry.ts`                                                                                    |
| Gateway runner                        | `src/agent-cli-provider/gateway-runner.ts`                                                                                       |
| Gateway tools/policy                  | `src/agent-cli-provider/gateway-tools.ts`                                                                                        |
| OMP release/version pinning           | `src/agent-cli-provider/omp-release.ts`                                                                                          |
| OMP RPC codec (JSONL/chunking)        | `src/agent-cli-provider/omp-rpc-protocol.ts`                                                                                     |
| OMP RPC lifecycle driver              | `src/agent-cli-provider/omp-rpc-driver.ts`                                                                                       |
| OMP RPC frame normalization           | `src/agent-cli-provider/omp-rpc-events.ts`                                                                                       |
| OMP session launch types              | `src/agent-cli-provider/omp-rpc-session.ts`                                                                                      |
| OMP config safety overlay             | `src/omp-config-overlay.js`                                                                                                      |
| OMP detached RPC watcher              | `task-lib/rpc-watcher.js`                                                                                                        |
| Provider detection                    | `lib/provider-detection.js`                                                                                                      |
| Provider capabilities                 | `src/providers/capabilities.js`                                                                                                  |
| Claude settings overlay               | `src/worktree-claude-config.js`                                                                                                  |
| Detached/foreground cleanup ownership | `src/command-cleanup-ownership.js` (re-exported by `task-lib/command-spec-cleanup.js` and used directly by `contract-invoke.ts`) |
| Shared watcher output path            | `task-lib/watcher-output-runtime.js`                                                                                             |
| Provider session reuse                | `src/agent/provider-session.js`                                                                                                  |
| Start-cluster helper                  | `lib/start-cluster.js`                                                                                                           |
| Legacy worker facade                  | `lib/cluster-worker/`                                                                                                            |
| Legacy worker executable              | `bin/zeroshot-cluster-worker.js`                                                                                                 |
| Private hosted capsule runtime        | `zeroshot-rust/src/hosted_oecp/`, `zeroshot-rust/hosted-node/`                                                                   |
| Hosted capsule image/manifest         | `docker/zeroshot-oecp/`, `scripts/hosted-oecp-image.js`                                                                          |
| Docker mounts/env                     | `lib/docker-config.js`                                                                                                           |
| Container lifecycle                   | `src/isolation-manager.js`                                                                                                       |
| Settings                              | `lib/settings.js`                                                                                                                |
| Cluster wire/domain types             | `crates/openengine-cluster-protocol/`                                                                                            |
| Admission wire semantics              | `crates/openengine-cluster-protocol/src/admission.rs`                                                                            |
| Graph AST/bindings/guards             | `crates/openengine-cluster-protocol/src/graph.rs`                                                                                |
| Closed payload algebra                | `crates/openengine-cluster-protocol/src/payload.rs`                                                                              |
| Closed payload validation             | `crates/openengine-cluster-protocol/src/payload_value.rs`                                                                        |
| Compiled IR/identity                  | `crates/openengine-cluster-protocol/src/canonical.rs`                                                                            |
| Artifact receipts                     | `crates/openengine-cluster-protocol/src/artifact.rs`                                                                             |
| Graph diagnostics/bounds              | `crates/openengine-cluster-protocol/src/diagnostic.rs`                                                                           |
| Shared wire-value bounds              | `crates/openengine-cluster-protocol/src/value.rs`                                                                                |
| Cluster server crate                  | `crates/openengine-cluster-server/`                                                                                              |
| Graph verifier facade                 | `crates/openengine-cluster-server/src/graph_verifier.rs`                                                                         |
| Graph verifier analysis               | `crates/openengine-cluster-server/src/graph_verifier/`                                                                           |
| Native product construction           | `zeroshot-rust/`                                                                                                                 |
| Native release targets                | `distribution/zeroshot-rust-targets.json`                                                                                        |
| Native npm binary shim                | `npm/zeroshot-rust/`                                                                                                             |
| Native distribution tooling           | `scripts/rust-distribution.js`                                                                                                   |
| Native distribution decision          | `docs/zeroshot-rust-distribution.md`                                                                                             |
| Native cluster ledger                 | `zeroshot-rust/src/cluster_ledger.rs`                                                                                            |
| Ledger store port/fake                | `zeroshot-rust/src/cluster_ledger/store.rs`, `store/fake.rs`                                                                     |
| SQLite ledger store                   | `zeroshot-rust/src/cluster_ledger/store/sqlite.rs`, `store/sqlite/`                                                              |
| SQLite append/query helpers           | `zeroshot-rust/src/cluster_ledger/store/sqlite/{operations,queries}.rs`                                                          |
| Ledger records/replay                 | `zeroshot-rust/src/cluster_ledger/record.rs`, `replay.rs`                                                                        |
| Full-v1 pure graph reducer            | `zeroshot-rust/src/full_v1_reducer.rs`                                                                                           |
| Protocol ledger adapters              | `zeroshot-rust/src/cluster_ledger/adapters.rs`                                                                                   |
| Artifact store port/fake              | `zeroshot-rust/src/artifact_store.rs`, `artifact_store/fake.rs`                                                                  |
| Product-local artifact CAS            | `zeroshot-rust/src/artifact_store/local_cas.rs`, `local_cas/`                                                                    |
| Required-proof contracts              | `zeroshot-rust/src/required_proof.rs`                                                                                            |
| Issue provider contracts              | `zeroshot-rust/src/issue_provider.rs`, `issue_provider/`                                                                         |
| Source provider contracts             | `zeroshot-rust/src/source_code_provider.rs`, `source_code_provider/`                                                             |
| Provider value bounds                 | `zeroshot-rust/src/provider_value.rs`, `provider_value/`                                                                         |
| Native worker catalog                 | `zeroshot-rust/src/worker_catalog.rs`                                                                                            |
| Execution runtime seam                | `zeroshot-rust/src/execution.rs`, `execution/types.rs`                                                                           |
| Local runtime + drivers               | `zeroshot-rust/src/execution/{local,driver}.rs`                                                                                  |
| Local process runner                  | `zeroshot-rust/src/execution/process.rs`                                                                                         |
| Fair scheduler                        | `zeroshot-rust/src/scheduler.rs`                                                                                                 |
| Durable workspace leases              | `zeroshot-rust/src/workspace_lease.rs`, `workspace_lease/`                                                                       |
| Workspace lease stores                | `zeroshot-rust/src/workspace_lease/store/{fake,sqlite}.rs`                                                                       |
| Workspace resource adapters           | `zeroshot-rust/src/workspace_lease/{resource,adapters,borrowed}.rs`                                                              |
| Native safe faults                    | `zeroshot-rust/src/fault.rs`                                                                                                     |
| Native fault taxonomy                 | `zeroshot-rust/src/fault/taxonomy.rs`                                                                                            |
| Native diagnostic redaction           | `zeroshot-rust/src/fault/redaction.rs`                                                                                           |
| Native product error projection       | `zeroshot-rust/src/product_errors.rs`                                                                                            |
| Native observability                  | `zeroshot-rust/src/observability.rs`                                                                                             |
| Native daemon discovery               | `zeroshot-rust/src/daemon_discovery.rs`                                                                                          |
| Native daemon authorization           | `zeroshot-rust/src/daemon_auth.rs`                                                                                               |
| Native loopback listener              | `zeroshot-rust/src/daemon_listener.rs`                                                                                           |
| Admission coordinator                 | `crates/openengine-cluster-server/src/admission.rs`                                                                              |
| Admission durable ports               | `crates/openengine-cluster-server/src/admission/ports.rs`                                                                        |
| Admission snapshot folding            | `crates/openengine-cluster-server/src/admission/snapshot.rs`                                                                     |
| Lifecycle state machine               | `crates/openengine-cluster-server/src/lifecycle.rs`                                                                              |
| Lifecycle durable ports               | `crates/openengine-cluster-server/src/lifecycle/ports.rs`                                                                        |
| Watch event stream/handle             | `crates/openengine-cluster-server/src/watch.rs`                                                                                  |
| Watch observation port                | `crates/openengine-cluster-server/src/watch/ports.rs`                                                                            |
| Watch minimal test fixture            | `crates/openengine-cluster-server/src/watch/fixtures.rs`                                                                         |
| Watch wire types/framing              | `crates/openengine-cluster-protocol/src/watch.rs`                                                                                |
| Client watch/reconnect                | `crates/openengine-cluster-client/src/watch.rs`                                                                                  |
| NDJSON stdio binding                  | `crates/openengine-cluster-server/src/stdio.rs`                                                                                  |
| NDJSON watch client                   | `crates/openengine-cluster-client/src/ndjson_watch.rs`                                                                           |
| Connection core/admission             | `crates/openengine-cluster-server/src/connection.rs`, `connection/`                                                              |
| JSON-RPC envelope/routing             | `crates/openengine-cluster-server/src/dispatch.rs`                                                                               |
| Protocol method registry              | `crates/openengine-cluster-server/src/method_registry.rs`                                                                        |
| NDJSON response pump                  | `crates/openengine-cluster-client/src/ndjson_pump.rs`                                                                            |
| Cluster typed transports              | `crates/openengine-cluster-client/`                                                                                              |
| TypeScript cluster client             | `src/cluster/`                                                                                                                   |
| Hosted session coordinator            | `src/hosted-session/`                                                                                                            |
| Hosted target capsule adapter         | `src/hosted-target/`                                                                                                             |
| Named target registry and sessions    | `src/target/`                                                                                                                    |
| TypeScript protocol emitter           | `scripts/generate-cluster-types.js`                                                                                              |
| Cluster fixtures/artifacts            | `crates/openengine-cluster-testkit/`                                                                                             |
| Portable backend conformance          | `crates/openengine-cluster-testkit/src/conformance.rs`                                                                           |
| Scripted admission fixtures           | `crates/openengine-cluster-testkit/src/admission.rs`                                                                             |
| Fixture inspection controls           | `crates/openengine-cluster-testkit/src/admission/inspection.rs`                                                                  |
| Scripted lifecycle helpers            | `crates/openengine-cluster-testkit/src/lifecycle.rs`                                                                             |
| Lifecycle fixture params              | `crates/openengine-cluster-testkit/src/lifecycle/params.rs`                                                                      |
| In-memory observation store           | `crates/openengine-cluster-testkit/src/watch.rs`                                                                                 |
| Admission transcript output           | `crates/openengine-cluster-testkit/src/admission_artifacts.rs`                                                                   |
| Watch/subscription artifacts          | `crates/openengine-cluster-testkit/src/watch_artifacts.rs`                                                                       |
| Negative graph vectors                | `crates/openengine-cluster-testkit/src/negative_graph_fixtures.rs`                                                               |
| Verifier vectors                      | `crates/openengine-cluster-testkit/src/graph_verifier_artifacts.rs`                                                              |
| Graph contract prose                  | `docs/openengine-cluster-protocol/v1/graph-contract.md`                                                                          |
| Admission contract prose              | `docs/openengine-cluster-protocol/v1/admission.md`                                                                               |
| Lifecycle contract prose              | `docs/openengine-cluster-protocol/v1/lifecycle.md`                                                                               |
| Watch contract prose                  | `docs/openengine-cluster-protocol/v1/watch.md`                                                                                   |
| Generated graph fixtures              | `protocol/openengine-cluster/v1/fixtures/graph/`                                                                                 |
| Generated watch fixtures              | `protocol/openengine-cluster/v1/fixtures/watch/`                                                                                 |

The unpublished hosted OECP runtime is a one-run compatibility capsule, not native-v2. It advertises
only `openengine.graph.single-worker/v1` and runs exactly `legacy.zeroshot.ship@1` with one attempt.
Its fixed `/workspace` must be prepared without `.git`, credentials, provider configuration,
symlinks, or host-path authority. Before worker launch, the runtime retains the sole preconnected
one-shot proxy-cleanup and delivery channels; the child inherits neither those descriptors nor a
usable listener. The untrusted Node tree receives only the fixed loopback proxy sentinels and a
bounded list/read/atomic-write tool loop—never shell, subprocess, or arbitrary network tools—and a
text-only response with no real workspace mutation cannot succeed. The complete tree is reaped
after proxy admission/credential cleanup and before the trusted `WorkspaceDeliveryPort` runs.
Delivery is idempotent and secret-free; `Finished` follows cleanup and delivery, and any defect
replaces successful output with a closed failure. Keep the runtime,
binary, image, and manifest private: never add npm/public CLI exports, full-v1 claims, raw credential
routes, target/auth/store APIs, provider selection, or local fallback.

Provider-specific settings, defaults, validation, and static capabilities derive from the provider
registry; do not add parallel provider lists. Opt-in native CLI capabilities must keep requested
and effective state distinct and fail closed unless local help/version evidence proves the control.
Structured-output recovery eligibility is also registry-derived: every engine whose `jsonSchema`
capability is `true` or `experimental` must implement its provider-owned, fail-closed recovery
adapter. Recovery always runs as a fresh nested turn with provider sessions, MCP, approval bypass,
write-capable tools, network tools, and user-defined agents/configuration disabled.

Cluster Protocol Rust types are the source of truth. Files under
`protocol/openengine-cluster/v1/` are generated projections; update them with
`cargo run -p openengine-cluster-testkit --bin generate-cluster-protocol -- --write` and
verify byte-for-byte drift with `npm run protocol:check`. These generator-formatted artifacts
are excluded from Prettier; never format them independently.
Native release metadata and npm installer code stay outside the Rust-only `zeroshot-rust/`
package. `distribution/zeroshot-rust-targets.json` is the authoritative release target list;
the workflow matrix and checksum coverage must match it exactly.
The published Node bindings are the standalone `@the-open-engine/zeroshot/cluster` and
`@the-open-engine/zeroshot/hosted-session` subpaths. Hosted-session owns only short-lived access
renewal and authenticated reconnect over the public cluster client; provider capsule APIs remain
outside it. `Connection` exclusively owns request IDs and transport teardown; watch reconnect
consumes an old stream exactly once on an application-supplied fresh connection. Keep `src/cluster/`
isolated from product internals, and regenerate its wire types from the authoritative protocol
artifacts with `npm run protocol:generate`.
Named target commands load compiled modules from `lib/target/`; package and development preparation
must run `build:target`, never import raw TypeScript from the Node CLI. OAuth routes and client
identity come from the versioned, same-origin hosted-target discovery document and its advertised
OAuth metadata; never reconstruct provider routes in `cli/` or `src/cluster/`.
The hosted-client vertical is descriptor-driven: `discoverTarget` validates the complete
`openengine.hosted-target/v1` document before target settings mutate, `TargetSessionManager` is the
sole owner of each target's locked rotating refresh family and audience access cache, and
`createTargetAdapter` is the sole capsule-adapter constructor. Hosted-session accepts that adapter
and a capsule ID, so every initial/replacement OECP connection obtains fresh access. The immutable
Zero Cloud #55 corpus lives at `tests/fixtures/zero-cloud-44`, pinned to commit
`e8e746d` and digest
`sha256:6636d50cd60067241a50d1ee027d86fc1738aa933f086d8bb2c496c5be31b85e`; never hand-author a
parallel hosted wire contract. `build:cluster` emits hosted-target and hosted-session CJS, ESM, and
declarations; packed runtime modules must not import source `.ts` files.
The protocol and server crates own wire contracts, backend traits, the dispatcher, and transports.
Portable external conformance is the immutable public catalog in the testkit and covers only
backend-neutral behavior observable through public dispatcher and typed subscription surfaces.
The existing integration binaries remain the richer reference regression suite; their
implementation-specific vectors are not represented as portable external certification.
`zeroshot-rust/` owns the concrete `NativeBackend`, product-local `NativeBackendFactory`
construction root, product-private artifact byte-store port/local CAS, product-private,
secret-free issue/source provider contracts, and native-profile daemon discovery,
authorization, and loopback-listener lifecycle. Artifact stages, bytes, roots, filesystem paths,
locks, and manifests remain product-private; only verified protocol `ArtifactRef` receipts cross
the engine boundary. `LocalCasArtifactStore` takes an explicit root, is a single-writer local
filesystem store, and must preserve ref-first release plus synchronized blob-then-ref publication.
Issue and source registries and identifiers remain independent; neither is a worker/model provider.
Mutating source calls carry an exclusively borrowed, non-serializable verified-workspace capability;
their serializable intent and closed operation-specific receipts contain only canonical workspace,
pre-effect, branch/revision, review, policy/conclusion, and idempotency identities. Successful or
uncertain effects reconcile only through exact authoritative post-effect inspection.
Required-command proof gates, immutable attempt intents/receipts, acceptance references, and
artifact re-verification remain product-private in `required_proof.rs`. Graph-visible selection is
limited to an admitted gate ID and repository/base/head revision bindings. Explicit environment
entries use the fixed non-secret name/value set, and proof output artifact lineage must match the
native `run:<sequence>` and attempt. Proof persistence uses the existing `ClusterLedger`
record/fold and mutation-receipt path, while output bytes, paths, environment credentials, and
command execution remain outside both ledger and protocol.
Keep protocol, transport, daemon, compatibility, adapter, credential resolution, ledger, and
workspace behavior outside it.
`worker_catalog` is the native product's sole hand-authored, versioned worker-provider inventory.
It owns bounded provider policy and deterministic identity only; keep role contracts, registries,
configuration, credential acquisition, executable codecs, concrete drivers, protocol descriptors,
and Node registry synchronization outside it.
Daemon locators are owner-only connection hints, never liveness evidence. Startup holds the
profile lock only through stale authenticated-initialize probing and atomic bind/publication.
Unix locator reads open `O_NOFOLLOW` first and enforce owner UID, mode 0600, and link count.
Windows uses reparse-point-safe handles, a protected current-user-only DACL, handle link counts,
and write-through atomic replacement. On either platform, extra links are insecure while an opened
locator concurrently unlinked to zero links may yield its complete prior value; never reclassify
that proven unlink-after-open race as corruption.
Upgrade authorization uses domain-separated client/server challenge proofs: capability and daemon
nonce are never transmitted, the server proof is verified before initialize, and the exact route,
profile digest, nonce, and rotating 256-bit capability must be proven before backend construction.
Probe results are closed: authenticated initialize is `Alive`, connection refusal or conclusive
invalid-owner/protocol proof is `DefinitelyStale`, and capacity/reset/timeout ambiguity is
`Indeterminate`; only `DefinitelyStale` authorizes locator removal and handoff. The response
envelope is exactly correlated and its result is decoded and canonicalized through the
authoritative protocol `InitializeResult`; partial or unknown result fields are not liveness.
Pre-auth handshake task/FD ownership, authenticated liveness, and ordinary active sessions each
have independent finite capacity. Full ordinary capacity cannot consume reserved liveness.
These are resource bounds, not an availability claim against unbounded sustained unauthenticated
arrivals on the single endpoint, which cannot be classified before reading the upgrade. Graceful
shutdown uses one absolute deadline across acceptance stop, abort/reap, and matching locator
cleanup; timeout paths still attempt cleanup and report the defined failure. Every accepted daemon
session and liveness handshake enters through the server crate's `ConnectionBinding`, with an
immutable profile-digest principal and tenant identity resolved before backend access; the daemon
host never constructs `ConnectionContext` directly and reuses the server WebSocket dispatcher.
Keep protocol definitions, compatibility,
credential resolution, ledger/catalog/recovery, runtime/scheduler/pools, exporter, CLI,
hosted/cloud control-plane, Node-daemon, and workspace behavior outside these modules.
`ExecutionRuntime`, `LocalExecutionRuntime`, `LocalProcessRunner`, and the daemon-scoped fair
scheduler are engine-private seams. They own local dispatch placement, fencing, deadlines,
workspace conflict arbitration, cancellation, and local-process containment only. They do not own
ledger mutation, durable attempt state, protocol methods, provider catalog/configuration,
credential resolution, workspace lifecycle, real CLI/ACP/Gateway drivers, built-in registration,
or `NativeBackend` composition. Runtime command/control values remain serializable, secret-free,
and input-free after control reconstruction.
`LocalProcessRunner` is also the sole contained stdio-session seam: recovery is registered before
spawn, stdout and diagnostics stay bounded, and close/release owns termination and reaping exactly
once. Provider framing and candidate decoding remain in the provider drivers.
Windows children stay suspended until assignment to their kill-on-close Job Object; never reopen
the pre-assignment execution window.
`WorkspaceLeaseManager` is the engine-private durable authority for borrowed, worktree, and Docker
workspace preparation and cleanup. It persists the deterministic `WorkspaceLeaseId`, owner fence,
stable mode inputs, and `CreatePending` before effects; uncertain create/cleanup advances only from
authoritative `WorkspaceResourcePort` inspection through owner-fenced store CAS. A matching owned
resource may move directly from `CreatePending` to `CleanupRequired`, allowing correct-owner cleanup
to remain retryable without a separate restart call. Production lease state uses the Linux-only
`SqliteWorkspaceLeaseStore`; other targets fail closed before opening or creating a database. The
store canonicalizes relative/symlink spellings to one database, rejects multiple hard links, and
revalidates both the pinned file and canonical pathname identity. Its operation fence is a global
OS lock on an independently opened, identity-checked descriptor for that sole database inode;
replaceable companion pathnames are never lock authority. Every rusqlite connection opens through
the retained `/proc/self/fd` path for that verified database descriptor, then revalidates both the
descriptor and canonical pathname before any application pragma/query; path races may fail closed
before rows or effects and must be cleanly retryable. The fence serializes authoritative absence
through the following effect across store instances and processes. Lease IDs reuse `ResourceId`;
execution isolation adds the already-committed `ExecutionId` and never creates a second scheduling
identity. Borrowed roots are never owned or deleted. Fingerprinting opens the canonical root once
with no-follow semantics, traverses descendants descriptor-relatively, hashes collision-free
platform path bytes, and revalidates every named descriptor identity. Owned roots require Linux
descriptor-relative filesystem support, are fixed beneath a canonical private
`<product-root>/zeroshot/workspaces` base, and must already satisfy owner-only permissions; never
chmod an arbitrary supplied root. Each worktree creates a complete, synced lease/owner marker in a
private staging container before atomically publishing its inner source directory. Abandoned
staging and deterministic inner/public/staging cleanup quarantines are authoritative recovery
states: restart finishes correct-owner scaffolding removal through identity-checked quarantine
names, while conflicting names, content, or identities are preserved as mismatches. Linux has no
identity-conditional directory unlink, so the final name-based `unlinkat` relies on the private
0700 product root and lease operation fence for supported manager writers; uncooperative
same-UID namespace mutation is outside the local adapter trust boundary and requires process/UID
isolation or a broker. Keep the immediate name/inode recheck so cooperative and recovery races fail
closed. Worktree effects receive non-cloneable, non-serializable scoped operations backed by pinned
directory descriptors; never expose a host pathname, descriptor number, or retained handle to
source materialization. Docker effects receive pinned mount descriptors rather than mutable host
pathnames. Docker mount handles are atomically created/opened relative to that pinned base with
no-follow semantics. Docker socket handles and socket/symlink targets are denied.
Persisted lease values contain no credentials, runtime IDs, arbitrary handles,
or host paths. Cleanup state never mutates graph outcomes.
Native engine faults must be constructed only by `FaultFactory` from closed `ModuleEvidence`.
Decoded faults must match the canonical semantics derived from their required primary source frame.
Raw diagnostic values are replaced wholesale with typed markers and remain ephemeral; never put
them in `EngineFault`, observations, protocol responses, persistence, or exports. Observability is
injected through `ObservationSink` and uses only the fixed metrics and closed dimensions in
`observability.rs`; retry disposition is descriptive data, not retry authorization. Do not install
global telemetry state or caller-defined labels.
`product_errors.rs` is the sole product-command/daemon-control error projection. It maps
`EngineFault` only from its canonical safe code, summary, and action and maps authoritative
protocol/backend errors directly through an allowlist; never reclassify protocol failures as
engine faults. Its closed code, exit status, daemon-control status, messages, actions, and strict
text/JSON renderers contain no source frames, diagnostics, provider/process data, paths, URLs,
commands, stderr, session identities, or credentials. Keep routing, CLI parsing, export,
telemetry, and retry authorization outside this module.
A lost node-instance session terminates the affected execution; its descriptive fault disposition
must never authorize retry or replacement-session recovery.
`ClusterLedger` is the only native durable domain authority. Its closed/versioned record algebra,
identity allocation, replay, lifecycle/CAS/idempotency rules, and safe-fault consequences stay
above the backend-neutral `LedgerStore` port. Control and verified I/O share one ordered hash
chain and transaction. Semantic validation and append CAS use the same folded position/hash; never
reread a newer prefix while committing payloads derived from an older one.
Reducer-owned loser voids require an opaque authorization bound to the admitted compiled IR,
verified input, durable execution history, execution, reason, and a folded position/hash capability
issued only by that `ClusterLedger`; caller-selected positions, identities, or reasons cannot
authorize an `ExecutionVoid` append.
Process-local authority identity participates only in ledger mutation validation; semantic
`Reduction` equality remains deterministic across equivalent ledgers and process reopen.
Every committed mutation ends in a hash-chained `MutationReceipt` record that exactly
matches its atomic idempotency projection, so missing or forged projection rows fail replay. Matching
receipt retries return an explicit replay outcome; receipt equality cannot distinguish a new commit from a concurrent
identical retry. `SqliteLedgerStore` is the sole v1 production store. SQLite creation initializes
a private same-directory database and atomically publishes the digest-named path, so losing
creators never remove the winning resource. Projections are
rebuildable and may not become a second journal. Persist only canonical engine records, verified
I/O, safe faults, effect intent/reconciliation, and cleanup receipts—never provider sessions,
reasoning, tools, raw diagnostics, stdout, or stderr.
Initial resource creation and its owner fence are one store operation. Guarded appends check
cancellation inside the store transaction immediately before their first write, after idempotent
receipt lookup. SQLite removal leaves an explicit empty tombstone until file unlink; missing live
metadata without that tombstone is corruption and must never authorize replacement.
Full-v1 reduction accepts only verifier-produced `VerifiedGraph` values containing authoritative
`CompiledGraphIr` and durable ordered outcomes. It never accepts compiled IR directly.
It is a pure authored-order fold: ledger position is the only concurrent
tie-break, map indices and positive attempts are part of the central ledger execution context, and
early-join loser voids are central ledger control records. Keep scheduling capacity, clocks, tasks,
channels, runtime/provider/artifact concerns, public protocol methods, and automatic retry outside
the reducer.
Graph syntax, payload subtyping, compiled IR, diagnostics, and artifact receipt Rust types remain
authoritative protocol contracts. `ProductionGraphVerifier` is the one reusable production
semantic verifier for `openengine.graph.full/v1`; it resolves workers through `WorkerRegistry` and
adds proven `StructuralBounds` without replacing the authoritative AST/IR. It does not admit,
store, schedule, or execute graphs. `ScriptedVerifier` remains a test-only admission fixture.
Full-v1 ceilings are fixed public constants beside `ProductionGraphVerifier`, not product
configuration. Node timeouts use the wire `PositiveInteger` range and have no 24-hour verifier
ceiling.
Full-v1 finite control enumeration couples each executable's signals and error as mutually
exclusive outcomes, including per-item map aggregates. Choice residual assignments govern output
channel availability; terminal alternatives do not flow into later nodes. Mapped control flow
preserves per-item execution correlation: guaranteed sequential, full-completion parallel, and
do-while descendants emit an outcome, while conditional descendants emit one exactly on their
selected residual route. An `otherwise` node is illegal when earlier branches exhaust the legal
control space and is excluded from flow analysis.
`k_of_n` and `k_of_map` labels never widen their selectors' closed domains. Executable writes
remain success-conditional until residual control excludes every runtime error; state reads and
promotions preserve that outcome provenance. Definition flow carries exact path/type guarantees
from required initial input through nested groups. A successful output/diagnostic binding defines
only its required selected path and required descendants, never optional producer paths.
V1 has no whole-payload binding: executable inputs and `succeed` outputs must be `null` or records.
Scalar, enum, and array payloads remain valid in other algebra positions and as nested record
fields. A map body write to a promoted `array<T>` path writes one `T` at the current input index;
the result is input-ordered and total, with empty input defining `[]`, while mapped executable
success/error provenance remains until control excludes every mapped runtime error.
Parallel continuation requires all branches for `all`, one for `any`/`first`, and `count` for
`quorum`; quorum flow and promotions are guaranteed only when present in every jointly satisfiable
size-`count` completion set. Shared guard correlations can make independently possible branch
completions mutually exclusive and must be preserved during that analysis. Correlate
`joined=reached|quorum_unreachable` for `all`/`any`/`quorum` with the required branch-completion
predicate; mapped join controls retain that correlation with branch controls per item before their
counts are aggregated. Impossible status/control combinations are excluded from guard analysis. Parallel failure labels
`quorum_unreachable` and `no_satisfier` restore the incoming pre-par definitions and expose no
winner or branch-promotion data. Unguarded continuation cannot consume success-only parallel
writes. Preserve target-granular conditional ownership through nested parallels, choice merges,
and later sequential writers; descendant writes must invalidate stale ancestor type facts.
For `first`, only a completing branch that guarantees the controls read by `when` and satisfies the
predicate is a winner; correlate `raced=satisfied|no_satisfier` with those winner assignments.
The admission coordinator provides stateful plan/apply/get semantics through injected ports.
Testkit scripted approval and `running` phase mean admitted state, not native verification or a
production full-graph executor.
`AdmissionStore` and `ObservationStore` remain separate ports. A watch-capable
`AdmissionCoordinator` requires both; never satisfy the observation boundary with a runtime
placeholder that rejects every subscription.
The NDJSON server caps and continuously reaps per-connection request/subscription tasks;
`subscription/cancel` bypasses admission. The client response pump must never await a
per-subscription consumer: local queue overflow closes that stream as `SLOW_CONSUMER` from its
exact caller-delivered cursor and cancels the server subscription. Watch request IDs are allocated
by the shared transport, never by individual watch-client facades.
Outbound Cluster WebSocket TLS is client-only: rustls 0.23/tokio-rustls 0.26 is the sole workspace
TLS stack, and only `openengine-cluster-client` enables tokio-tungstenite's rustls native-root
feature. System roots are mandatory by default; private roots and the off-by-default
`bundled-roots` feature only augment them and never hide system-store load failures. Every `ws://`
dial, including loopback, requires `WebSocketDialOptions::allow_plaintext(true)` per connection.
Endpoint preflight rejects non-ws(s), userinfo, query, and fragment before network I/O; redirects
are never followed or downgraded. Keep `serve_websocket` plaintext/front-proxy terminated and keep
TLS out of `zeroshot-rust`. Do not introduce native-tls: its Linux `openssl-sys` dependency breaks
cross-compilation and static-musl builds.
Connection identity is binding-injected and never wire-carried. Every accepted NDJSON or WebSocket
binding resolves exactly one immutable `ConnectionIdentity` before decoding its first frame;
principal and tenant are opaque typed IDs, expiry is required, and binding attributes remain opaque
to the dispatcher. Check expiry at every request decode boundary before admission/backend work
(`4401` for WebSocket; one terminal diagnostic then close for NDJSON). Protocol params named
`principal`, `tenant`, or `expiresAt` remain strict unknown fields and must never alter context.
Tenant partitioning is exclusively a backend decision: the dispatcher neither adds nor removes it.
`ConnectionBinding` must preserve the host-supplied cancellation signal in the backend-visible
context; identity resolution must not replace the host's connection/shutdown ownership.
Each binding parses inbound JSON once into the duplicate-preserving connection frame. Preserve the
legacy typed-request classification used for duplicate-ID and task-slot admission before the strict
envelope outcome; malformed and wrong-version responses still cross that shared admission boundary.
`Dispatcher::dispatch_decoded` owns method lookup before params-shape validation, while
`Dispatcher::dispatch` is only the JSON-RPC envelope decoder.
`method_registry.rs` is the sole source of truth for server method names, unary/subscription kind,
transport requirements, and advertised OpenRPC order/metadata. Bindings resolve subscription kinds
through that registry; the connection core exhaustively maps every `SubscriptionKind` to its runner.
Authoritative admission snapshots fail closed: `empty` has no durable fields, `running` has the
complete matching control/seed tuple, and transient `admitting` preserves one of those two shapes.
Operational suspend is a dispatch gate: existing leases may land verified I/O, but successors wait
for resume. Manual retry admits only a retryable settled frontier after every peer lease settles;
exhausted authored attempts never create a frontier. An accepted retry intent reserves its next
single-use turn and rejects a stale error-successor until that reserved turn begins. Drain waits
without inventing graph hooks and terminalizes after the final verified or failed settlement; force
cancels and voids leases without fabricating output. Each stopped run has one final `finished`
event. Stop acknowledgements never claim rollback or absence of external side effects. These are
deterministic scripted-backend semantics, not a native graph scheduler or worker executor.

The TUI is not included in this release. Use `zeroshot list`, `zeroshot status <id>`,
and `zeroshot logs <id> -f` or `zeroshot logs <id> -w` for monitoring.

### Cluster Worker Contracts

| Concept                    | File                                                       |
| -------------------------- | ---------------------------------------------------------- |
| Worker descriptors         | `crates/openengine-cluster-protocol/src/worker.rs`         |
| Normalized worker outcomes | `crates/openengine-cluster-protocol/src/worker/outcome.rs` |
| Worker registry boundary   | `crates/openengine-cluster-server/src/worker_registry.rs`  |
| Mock worker profiles       | `crates/openengine-cluster-testkit/src/worker_profiles.rs` |

Worker descriptors and registry compatibility checks are contract/pre-admission ports only.
ACP/A2A modules in the testkit are mock conformance profiles, never production transports.
Descriptors must declare all four closed runtime errors (`timeout`, `crash`, `malformed`, `refusal`).
The reserved legacy descriptor is valid only with its canonical request/result payload types, while
mock verifier completions must validate output, signals, diagnostics, and artifacts before emission.
Worker JSON Schema must mirror descriptor cross-field/uniqueness validation and the closed
error-code/reason matrix; registry compatibility must reject verifier contracts on step nodes.

The legacy cluster worker is the bounded Node implementation of `legacy.zeroshot.ship@1`.
Its public facade is exactly `start`, `status`, `events`, `stop`, and `result`; do not add
guidance, permission callbacks, writable attach, raw output, credential fields, or caller launch
flags. Registry resolution must produce a frozen worktree/docker plan before engine allocation.
Lifecycle and terminal truth comes from cluster records plus durable ledger topics; PID state is
diagnostic only. Explicit stop is bounded by the registry shutdown deadline and never claims that
provider or tool side effects were rolled back.
Completion events require a canonical result or explicit bounded summary, and failure events require
a valid closed code/reason pair; missing or corrupt terminal data fails as `malformed`. Engine status
observation is synchronous and fails closed when durable truth cannot be read.
Profile resolution, artifact staging, engine start, and receipt collection remain cancellable under
the registry execution bound; stop may win before engine allocation. A caller shutdown deadline
bounds stop acknowledgement, not cleanup ownership: the engine adapter must still stop a cluster
that allocates late while start remains pending, then release its orchestrator exactly once so
process EOF cannot retain engine handles. The executable may wait for that cleanup only until its
own shutdown deadline; at the deadline it invokes the internal release port and exits.
Artifact input has no echo-only default resolver. The current engine allocates isolation first,
then runs the injected resolver before agents start; the resolver must materialize read-only content
inside that workspace. Cancelled profile, staging, and receipt operations retain late cleanup
ownership through their injected `release`/`cleanup` hooks. Late operation and cleanup failures must
reach the cleanup-failure reporter (default: process warning); never detach them with an empty catch.

## CLI Quick Reference

```bash
# Flag cascade: --ship -> --pr -> --worktree
zeroshot run 123                  # Local, no isolation
zeroshot run 123 --worktree       # Git worktree isolation
zeroshot run 123 --pr             # Worktree + create PR
zeroshot run 123 --pr --pr-base main # PR base: main, worktree base: origin/main (incl. -d)
zeroshot run 123 --ship           # Worktree + PR + auto-merge
zeroshot run 123 --docker         # Docker container isolation
zeroshot run 123 -d               # Background (daemon) mode

# Management
zeroshot list                     # All clusters (--json)
zeroshot status <id>              # Cluster details
zeroshot logs <id> [-f|-w]        # Stream logs
zeroshot resume <id> [prompt]     # Resume failed cluster
zeroshot stop <id>                # Graceful stop
zeroshot kill <id>                # Force kill

# Utilities
zeroshot export <id>              # Export conversation
zeroshot agents list              # Available agents
zeroshot settings                 # View/modify settings
zeroshot providers                # Provider status and defaults
```

UX modes:

- Foreground (`zeroshot run`): streams logs, Ctrl+C stops cluster.
- Daemon (`-d`): background, Ctrl+C detaches.
- Attach (`zeroshot attach`): connect to daemon, Ctrl+C detaches only.

Settings: `defaultProvider`, `providerSettings` (claude/codex/gateway/gemini/opencode/pi/copilot), legacy `maxModel`, `defaultConfig`, `logLevel`, robustness (`maxRetries`, `backoffBaseMs`, `backoffMaxMs`, `jitterFactor`, `maxRestartAttempts`, `maxTotalRestarts`, `staleWarningsBeforeKill`).

Provider engines are registry-owned: adding an engine means one entry in `src/agent-cli-provider/provider-registry.ts`, plus the provider-specific adapter and tests. Docker credential mount/env presets, CLI aliases, visible preset lists, and any nontrivial availability probe rules must derive from that registry entry; do not add new provider identity lists or provider preset lists elsewhere.

OMP's supported version, package identity, and release asset digests are pinned once in `omp-release.ts`; the RPC codec and any registry/version-probing/Docker-build code import it. Never recopy the version string, asset names, or digests elsewhere.

OMP's `rpc-stdio` invoke lane uses one shared lifecycle driver, `runOmpRpcTask` (`omp-rpc-driver.ts`), for both foreground (`contract-invoke.ts`) and detached (`task-lib/rpc-watcher.js`) execution, so the two paths produce identical result semantics. Spawn evidence is persisted (via the caller's `onSpawn` hook) before the first stdin write, and is reported only once the child process is confirmed spawned (the Node `'spawn'` event) — never synthesized from a pre-spawn/undefined pid, which would let ownership-based termination signal an unrelated process. Output is normalized-events-only: raw RPC frames, prompt text, and control payloads are never logged, only `OutputEvent`s (`omp-rpc-events.ts`). The detached watcher's prompt never enters its argv (`ps` and `/proc/<pid>/cmdline` expose argv to every local user for the watcher's whole lifetime); `task-lib/runner.js` hands it over the private, length-prefixed stdin pipe in `src/watcher-prompt-channel.js`, and the watcher fails closed — no OMP spawn, ownership-aware cleanup still runs — when that channel is absent, truncated, over the pinned 1 MiB frame contract, or closed before a complete payload. The per-task OMP config overlay (`omp-config-overlay.js`) and its cleanup are ownership-checked by the shared `src/command-cleanup-ownership.js` owner used by both cleanup call sites; a failed or unsafe cleanup leaves the task's cleanup receipt intact (durably retryable) instead of silently discarding it. Provider `dockerIsolation`/`worktreeIsolation` capabilities are gated in `orchestrator.js` and `preflight.js` before any container/worktree is created, not after.

OMP session persistence (issue #866): fresh runs pass `--session-dir <partition>`; verified resume
adds `--resume <partition>/<file>` as the exact absolute path Zeroshot already verified, never a
bare `--resume`/`--continue` or an ID search; `--no-session` is reserved for the sessionless
Docker lane, which stays fresh-only. Each session lives in its own random, secret-free UUID
partition under `<storageRoot>/omp-sessions/<uuid>/` (`task-lib/omp-storage-root.js` resolves
`storageRoot` to the owning cluster's `storageDir` or the standalone `TASKS_DIR`, never derived
from prompt text or cwd). Partition allocation is row-before-directory: `task-lib/runner.js`
persists the task's provisional `ompSessionOwnership` row before the partition directory is ever
created on disk, so a crash between the two leaves a provisional row pointing at a path with
nothing there yet.

A _thrown_ materialization failure in that window is not left to recovery. `spawnTask` catches it,
retires the record to `cleanup-required`, and drives the task row to a terminal status before
re-raising — a live-looking `running` row holding a live provisional claim would be permanently
unreclaimable, since cleanup refuses any partition another row still claims provisionally. The same
applies to every other durable boundary that ends a task with no watcher left to reach
`finalizeOmpOwnership`: `zeroshot task kill` (killed/stale), `zeroshot clear`, and
`zeroshot kill-all` all call `retireOmpOwnershipAtTerminalBoundary` _before_ their terminal status
write. That helper is idempotent and never throws, so a retried kill or a crash-recovery replay
converges and a store failure cannot turn "the task is killed" into an unhandled rejection.
Retirement is decided by the boundary alone — never by whether the partition directory happens to
exist, which cannot distinguish a partial mkdir from a clean failure. An _unconfirmed_ termination
is deliberately not a boundary: a failed kill leaves the claim in place, because the provider may
still be writing.

CAS blobs are **not** Zeroshot's and are not inside the partition. OMP externalizes large payloads
to a shared, machine-wide content-addressed store and leaves a _nested_ `blob:sha256:<64-lower-hex>`
reference string inside the session JSONL records (v17.2.1
`packages/coding-agent/src/session/blob-store.ts`, `session-loader.ts`). That store's root is
`@oh-my-pi/pi-utils::getBlobsDir()` — `~/.omp/agent/blobs` modulo OMP's `PI_CONFIG_DIR` /
`PI_CODING_AGENT_DIR` / profile / XDG semantics — mirrored in `src/omp-blob-root.js`. Verification
parses the JSONL, collects canonical nested refs, and checks the referenced blobs _there_; a
missing, non-canonical, or digest-mismatched reference is an invalid continuation. A blob may
legitimately carry more than one hard link (`blob-store.ts` hardlinks a typed `<hash>.<ext>`
sidecar), so blobs are content-verified rather than link-count-verified. **No cleanup surface ever
writes to or deletes anything under that root**, and `deleteOmpSessionPartition` refuses outright
any path that resolves inside it.

`src/omp-session-verifier.js` implements the two-phase lazy-file contract against the fixed
`OMP_SESSION_LIMITS` (`src/omp-session-limits.js`): existing (resume) partitions are fully verified
before spawn and again from the `ready` hook right before the prompt; fresh partitions are only
path-checked at `ready` and are descriptor/header/tree-verified after terminal materialization,
where the transcript's own session header (`{type:"session", id, cwd, ...}`) must name the session
OMP reported and the workspace the task was canonicalized against. Every check is
**descriptor-pinned**: a path is opened once with `O_NOFOLLOW|O_NONBLOCK` (plus `O_DIRECTORY` for
directories) and every type/owner/link/size/identity check and every byte read comes from
`fstat`/`read` on that same descriptor — there is no lstat→open→stat pathname sequence and no
re-open of a mutable name after validation, so a substituted file cannot be the one that gets read.
`O_NONBLOCK` is load-bearing: without it a FIFO planted in a partition would block the open forever
instead of failing verification. Directory listings re-pin and compare identity around the
enumeration, turning a substituted directory into a hard failure rather than a silent traversal.
Files are streamed in fixed-size chunks — never loaded proportional to file size — bounding both
the declared size and the bytes actually observed while reading.

Names are handled as **raw bytes** wherever the platform has raw bytes to give. A POSIX filename is
an opaque byte string, not text: two distinct files can carry names that are both invalid UTF-8 and
that Node's string decoding collapses to the same run of U+FFFD, so hashing the re-encoded string
would give two different artifact trees one manifest digest — a collision whose filenames an
attacker chooses. Entries are therefore enumerated with `encoding: 'buffer'`, and every relative
path is assembled, bounded (`maxRelativePathBytes` is measured on the raw bytes), separator-checked
by byte, sorted with `Buffer.compare`, and length-prefix-hashed as bytes; child paths are opened
from those same bytes with no string round trip. Windows has no such thing — the OS gives UTF-16,
Node's fs rejects Buffer paths there — so it keeps the string path with the identical manifest
layout.

Verification stays bounded against hostile input, not merely against well-formed input.
`maxSessionBytes` bounds the _file_, so a 256 MiB transcript with no newline in it is one record; a
fixed `MAX_SESSION_RECORD_BYTES` (derived, not configurable: it is `maxReferencedBlobBytes`, the
issue's own answer to how large one addressable unit of session content may be) caps what a single
record may buffer, checked before the append it would authorize. The remaining per-record
allocation is exactly that bound plus what `JSON.parse` necessarily materializes from it (one
UTF-16 string and the parsed value) — O(record bound), independent of file size, record count, and
newline placement. The blob-reference walk is **iterative**: V8's `JSON.parse` accepts nesting far
deeper than any call stack, so a recursive walk over the parsed value raises
`RangeError: Maximum call stack size exceeded` from inside a streaming read callback rather than
failing verification. Directory enumeration uses `opendir` and stops as soon as it has read more
names than the artifact-entry budget could allow, instead of `readdir` materializing every name in
a hostile directory before any bound can apply.

Ownership is an owner-fenced state machine persisted as `task.ompSessionOwnership`
(`task-lib/store.js` schema v5, `task-lib/omp-session-ownership.js`):
`provisional -> committed | cleanup-required`. The schema (`omp-session-ownership-schema.js`) is
**closed** and revalidated/canonicalized on every read and write — unknown keys anywhere, a
non-UUID partition id, a non-canonical or relative path, a `partitionPath` that is not
`<storageRoot>/omp-sessions/<partitionId>`, a session file name that is not a direct-child
`*.jsonl`, or a partially populated identity/session pair all reject the whole record, and
`validateOwnedByTask` additionally fences a record to the row it was read from. Every transition is
a **full-value** SQL compare-and-swap (the canonical serialization is byte-stable, which is what
makes that possible), so a duplicate or re-entrant completion call can never clobber a state a
concurrent writer already advanced past; `updateTask` only writes the column when the caller
explicitly supplies it, so an unrelated row update cannot clobber a CAS either. Every device/inode
in this schema, in the `--omp-resume` descriptor (`task-lib/commands/run.js`), and in the agent's
`providerSession.ompSession` snapshot (`src/agent/provider-session.js`) must _already be_ a
canonical unsigned decimal string. None of those three ever coerces: `String(value.device)` accepted
a JSON number, a boxed String, or a one-element array and then wrote the coerced result, so a
value that had never contained the canonical form would compare equal to a persisted record that
did — the exact-identity check would have been asserting against a value the normalizer invented.

`parseOmpSessionOwnership` collapses SQL NULL and unreadable bytes to the same `null`, and those
mean opposite things: NULL is exact truth that nothing was allocated, while unreadable bytes may be
the last remaining pointer to a real partition. `inspectStoredOmpSessionOwnership` is the closed
raw-presence seam that separates them (it reports `{present, valid}` and never hands the raw text
back — nothing may parse or act on malformed JSON), surfaced on the task record as
`ompSessionOwnershipPresent`. Every cleanup surface retains such a row, its record, and its
partition with an actionable warning; cluster clear reports it separately, since the owner tuple is
exactly what is unreadable and it cannot be attributed to a cluster at all. Owner queries read the
column as an opaque string and validate in JS rather than using SQLite `json_extract()`, which
raises "malformed JSON" for a non-JSON value — one corrupted row anywhere in the table would
otherwise make the partition fence _throw_ for every partition.

A standalone task's detached watcher run is its own terminal boundary and commits directly once
output is validated; a cluster-agent task's watcher only records the verified materialization
evidence and leaves the row `provisional` — only the spawning agent's post-hook success boundary
(`src/agent/agent-lifecycle.js#finalizeProviderSessionAfterCommit`, after
`executeOnCompleteHookWithRetry` succeeds) may advance it to `committed`. That function is also
where **commit-then-snapshot** ordering lives: the snapshot inside a completion result was computed
against a still-provisional row and is null for OMP by construction, so the record is committed,
the commit is _checked_, and the snapshot is rebuilt from the re-read row before it reaches the
agent or `TASK_COMPLETED`. Publishing the completion-time snapshot instead would make every cluster
OMP session silently non-reusable.

Resume is an **atomic owner transfer**, not a second claim. `transferOmpSessionOwnership` moves the
prior committed owner's lineage onto the resumed task's provisional row and clears the prior row in
one transaction, both sides fenced on their exact current JSON, and the watcher runs it from the
`ready` hook strictly _before_ the prompt is written. A partition therefore never has two committed
owners; the resumed row stays `provisional` until its own success boundary, so a half-finished
continuation is never published as resumable. Note what that does _not_ say: the authoritative live
claimant during a resumed turn is `provisional` **by design** — the partition has **no** committed
owner for that whole span — and it is regularly named by **several rows at once** (a resumed row
exists before its transfer runs; two competing resumes leave three). Any comment, test message, or
doc claiming a committed owner exists during an active resumed turn is wrong. After the transfer the
resumed row holds the _only_ copy of the lineage, so every post-transfer failed/cancelled/uncertain
boundary must retire it to `cleanup-required`: leaving it `provisional` would strand the partition
behind the authoritative fence forever, and there is never a second committed owner to fall back to.

Before the prompt, the resume checkpoint additionally requires the **echoed** session identity to
be complete and exact. `get_state` may legitimately report only a subset (docs/rpc.md) and later
`session_info_update` frames are merged onto prior evidence, but at the one checkpoint that
transfers a lineage and writes a prompt, "OMP did not say" is not agreement: disk state cannot
answer which session the running process attached to. Both `sessionId` and `sessionFile` must be
present and exactly equal to the full recorded id and the full absolute recorded path. A prefix is
not agreement either — OMP resolves `--resume` ids by prefix (`session-manager.ts`), which is
precisely the ambiguity this rejects.
Cleanup consults `findAuthoritativeOwnersForPartition` — every `provisional` or `committed` claim,
not the committed ones alone — so neither a resume that crashed before its transfer nor a
competitor that lost the transfer can delete a session another row is still using. Before any of
that, the resume
descriptor (built from the agent's `providerSession.ompSession` plus the prior owner's task id) is
cross-checked field-by-field against that persisted row in `task-lib/runner.js`; a conflict, a
storage-root change, or a workspace that is not the recorded `canonicalWorkspace` fails closed
before a task row exists. The watcher then compares the **complete** committed tuple — full session
id, full session file path (never a basename), partition and session-file inode identity, artifact
manifest digest, and an `executionFingerprint` (`src/omp-execution-fingerprint.js`) binding the
pinned OMP release, the config-overlay content digest, the requested `--model`/`--thinking`/
`--approval-mode` selectors, and the concrete provider/model/thinking level OMP reported. That
fingerprint has exactly one implementation, `src/omp-execution-fingerprint.js`; do not add a second
digest helper beside the ownership schema, where only its own unit test would exercise it and it
could silently drift from the contract production uses. Every failed, cancelled, or uncertain
boundary marks the row `cleanup-required`.

Manual resume (`task-lib/commands/resume.js`) requires `state === 'committed'` **and is
standalone-only**: a `cluster-agent` owner is refused before a task row or a partition claim
exists. A cluster-agent lineage can only be committed by the agent process that owns it (the
post-hook boundary above), so a detached `zeroshot task resume` that accepted one would move the
whole lineage onto a row no parent agent knows about — the prior owner's record cleared by the
transfer, the resumed row uncommittable by anyone, the partition unreclaimable, and the real owner
silently falling back to fresh context.

All three cleanup surfaces go through `task-lib/omp-session-cleanup.js`: standalone task `clean`,
cluster clear (`cli/index.js#deleteClusterData`, which reclaims partitions owned by that cluster's
agents under its own `storageDir`), and global `purge` (cluster clear then `clean --all`). Deletion
is validated against the persisted owner — uid, storage-root identity, partition identity — and
closes the check/use race by **staging before deleting**: the partition is renamed, inside its own
parent, to a deterministic `.zeroshot-deleting-<partition-id>-<owner-identity-digest>` name and
only then re-pinned and removed. A crash after rename or failed `rm -r` retries that exact staged
directory when the canonical name is absent. Canonical/staged conflicts, owner or partition
identity mismatches, and unsafe paths fail closed while preserving the row and tree for inspection.

Two non-obvious constraints govern that path. First, **more than one row can name one partition**:
a resumed row is inserted before its transfer runs, so a crash in between leaves two, and two
competing resumes of one committed session leave three (the prior owner plus both candidates, only
one of which can win the transfer). Cleanup therefore fences on every _authoritative_
(`provisional` or `committed`) claim other than its own row — `findAuthoritativeOwnersForPartition`,
not the committed rows alone. A committed-only fence is wrong in the exact case that matters: right
after a successful transfer the winner is `provisional` and _no_ row is committed, so a retired
losing competitor would see nothing and delete the winner's live session. `cleanup-required` is
deliberately not authoritative — treating it as one would deadlock two retired rows against each
other and strand the partition forever. Every unreadable or invalid non-null ownership row is
global unknown authoritative evidence because its partition cannot be proven; it blocks all
partition deletion across clean, cluster clear, and purge until an operator repairs that row.
Second, the fence is a task-store **write transaction**
(`BEGIN IMMEDIATE`) spanning exactly "no other authoritative claim" → "the partition no longer
answers to its canonical name". `stageOmpSessionPartitionForDeletion` (rename) runs inside it and
`removeStagedOmpSessionPartition` (`rm -r`) runs after it, so no resume can slip into the gap and
no unbounded recursive delete is held under a write lock.

Standalone `clean` (`task-lib/commands/clean.js`) has two further ordering rules. The **live-task
retention boundary comes before every cleanup side effect**, independent of `commandCleanup`: a
running task's partition is a live provider process's working directory, and the check used to sit
inside the command-cleanup branch — i.e. after the partition had already been staged and
recursively deleted — so `clean --all` could destroy a live session belonging to any task that
happened to carry no cleanup receipt. And `clean` performs **no whole-table rewrite**: rows are
removed individually through `removeTaskIfUnchanged`, fenced on the status and exact ownership
bytes of the snapshot they were validated against. On the retained path,
`clearTaskCommandCleanup` compares-and-swaps the exact serialized receipt cleanup processed, so a
concurrent replacement receipt survives rather than being erased by an unconditional column clear.

OMP's Docker isolation is env/broker-only, zero-automatic-mount, and sessionless — never same-shaped as the mount-based providers. Its registry `docker` entry has no `mount`: `~/.omp`, `agent.db`, WAL/SHM files, and host refresh tokens are never mounted or copied into the container. The **automatic** env allowlist is exactly 5 names (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OMP_AUTH_BROKER_TOKEN`, `OMP_AUTH_BROKER_URL`, `OPENAI_API_KEY`) per the maintainer's authoritative clarification (verified via `gh api repos/the-open-engine/zeroshot/issues/comments/5160272623`, which supersedes PLAN*READY's original nine-name draft) — deliberately narrower than OMP's full adapter `credentialEnvKeys` inventory (used for host inspection/redaction only). `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, and every other credential or path are never forwarded automatically — but they are **usable**: a registry-known credential outside the allowlist authenticates the container once (and only once) it is in the *explicit* plan (`dockerEnvPassthrough` / an explicitly listed preset / `--mount`). "Requires explicit opt-in" is the rule; "permanently unusable" would be a bug. A **path** credential (its forwarded value is an absolute container path, e.g. `GOOGLE_APPLICATION_CREDENTIALS`) additionally requires an explicit mount that actually provides that container path — a host path that merely exists proves nothing about what the container can read. OAuth users should prefer the auth broker so host refresh/access tokens never cross automatically. Auth is checked against the \_effective* container env/mount plan (`IsolationManager#_buildCredentialPlan` -> `#_assertProviderCredentialPlan` + `lib/docker-config.js#validateProviderEnvAuth`), never host presence, and the plan carries **actual values**, not presence flags — so a forced-empty passthrough (`dockerEnvPassthrough: ["OPENAI_API_KEY="]`, which really does reach `docker run -e OPENAI_API_KEY=`) and a whitespace-only value both fail closed instead of reading as authenticated. `OMP_AUTH_BROKER_URL` must parse as an absolute http(s) URL (registry `docker.envAuth.requireUrl`; per OMP v17.2.1 `docs/environment-variables.md` it is the broker's base URL and OMP hard-errors on a broker URL with no resolvable token), and a malformed URL or a half-set broker pair is a hard defect no other credential compensates for. Values are internal: every error/warning names variables and configuration paths only. Because OMP declares no `docker.mount`, unsatisfied or malformed auth throws — fail closed, no fallback to another provider — while every mount-based provider keeps today's non-fatal warning; and the check runs **before** `_removeContainerByName()` and `_prepareIsolatedWorkspace()`, so failed auth leaves no container or workspace side effect (same pre-effect ordering as the platform probe). Remediation for an env-only provider must never recommend mounting its host auth store (`credentialPaths[0]`, i.e. `~/.omp`) — that would contradict the whole contract; it prefers the broker pair and uses a generic custom-path example instead (`IsolationManager#_credentialRemediation`). `IsolationManager#createContainer` only creates and mounts the Claude credential/hook config dir (`_createClusterConfigDir`, `~/.claude`) when the _running_ provider is `claude` — that mount used to be unconditional for every provider, which was an unintended Claude-credential side channel into every other provider's container (OMP included); scoping it to `claude` closes that leak for OMP and every other non-Claude provider, since no other CLI reads `~/.claude/settings.json` or its credentials anyway. The Dockerfile's registry-fed `PROVIDER_CONFIG_ROOTS` build layer (after `USER node`) separately creates OMP's own `configRoots` (`~/.omp`) owner-only as the existing non-root `node` user; OMP is never run as root, and this is unrelated to the Claude config dir. The registry also owns `docker.platform` (`linux/amd64` for OMP only — the base image's AWS/Terraform/kubectl/Helm/Infracost/TFLint/tfsec layers are hard-coded x86-64, so this is not a native-arm64 claim); `IsolationManager.assertPlatformSupported` runs as a pre-effect probe (before any worktree/container/image side effect) in `orchestrator.js#_initializeIsolation`/`_ensureIsolationForResume`, `agent-lifecycle.js#createValidatorIsolation`, and `preflight.js#validateDockerRequirement`, and requires either a native-matching Docker server architecture or a Buildx builder advertising that platform — never a silent install of a foreign-arch binary into the shared base image. Buildx's `Platforms:` line is parsed into **exact** comma-delimited tokens (`IsolationManager.parseBuildxPlatforms`, trailing preferred-marker `*` stripped, every builder node's line collected): a substring test would accept a builder advertising only the variant `linux/amd64/v2` as if it could run `linux/amd64`. `IsolationManager.imageForProvider` derives the per-provider variant from the base reference's **name** component only — `IsolationManager.parseImageReference` strips a `@sha256:…` digest and a `:tag` while keeping a `registry:port/` (a colon before the last `/` is a port, not a tag), because appending `-<provider>-<hash>` after a digest or tag produces an invalid reference and the isolated run can never start. The tag hash covers the **full** base reference alongside the install command and platform, so two different pins of one base name never share a cached tag and a pinned-version or platform change busts the cache. Docker stays sessionless even though `sessionResume` is now `true` for OMP (issue #866 made host, worktree, detached cluster-agent, and standalone manual resume real — see the OMP session persistence section above). The capability flag and the container lane are independent: `buildSpawnEnv`/`spawnClaudeTaskIsolated` set `ZEROSHOT_OMP_SESSIONLESS=1` for an isolated run, `task-lib/runner.js#resolveOmpSessionPlan` therefore allocates no session partition and persists no ownership row, and the adapter launches `--no-session` with no `--session-dir`/`--resume`. `agentCanReuseSession` (`src/agent/provider-session.js`) independently rejects reuse for any isolated agent before a resume descriptor is even constructed. Same-container next task and container recreation both rebuild full context from scratch, never referencing a prior OMP session ID.

Model gateways stay behind the single bundled `gateway` engine. Do not add `openrouter`, `ollama`, `vllm`, `hermes`, or similar model-only targets as standalone provider ids.

Exactly one registry entry must set `default: true`; `getDefaultProviderId()` (`src/agent-cli-provider/provider-registry.ts`, re-exported from `lib/provider-names.js`) is the sole default-provider authority — settings, agent resolution, CLI, and setup code fall back to it, never a hardcoded provider literal. Historical-output parsers and legacy provider-less persisted watcher/task records keep their existing Claude-literal compatibility path and are never reinterpreted via the marker.

ACP-native engines use one shared stdio adapter lane. New ACP engines must be added with registry metadata plus helper fixtures only; do not add engine-specific ACP parsers or invoke runners.
ACP fixtures must use protocol-shaped chunk payloads: `agent_message_chunk.content` is a single `ContentBlock` object, and thought deltas are covered with `agent_thought_chunk` fixtures so parser tests catch spec drift.

## Architecture

Pub/sub message bus + SQLite ledger. Agents subscribe to topics, execute on trigger match, publish results.

```
Agent A -> publish() -> SQLite Ledger -> LogicEngine -> trigger match -> Agent B executes
```

### Core Primitives

| Primitive    | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| Topic        | Named message channel (`ISSUE_OPENED`, `VALIDATION_RESULT`) |
| Trigger      | Condition to wake agent (`{ topic, action, logic }`)        |
| Logic Script | JS predicate for complex conditions                         |
| Hook         | Post-task action (publish message, execute command)         |

Restart persistence: orchestrator publishes `AGENT_RESTART_ATTEMPT` to the ledger so restart limits survive orchestrator restarts.

Provider task ownership: task watchers persist an owned termination boundary with each active task.
POSIX providers run in a dedicated process group; Windows providers use the exact root PID with
`taskkill /T`. Recovery must terminate that recorded boundary before retrying work. Command cleanup
ownership is persisted with the task and may run only after that boundary is confirmed terminal.
Cleanup ownership transfers only when the detached task row durably records the wrapper's unique
spawn-ownership token; process spawn and human-readable task-ID output are not receipts. Failures
before that receipt leave cleanup with the caller. Watcher completion clears a cleanup receipt only
after an initialized cleanup owner actually succeeds. Cleanup metadata is a closed one-to-one receipt:
Claude settings overlays must be owned temporary directories, and Codex output-schema files must be
exact regular, non-symlink UUID JSON files directly inside canonical `zeroshot-schema-*` temp
directories. Unsafe or uninitialized cleanup remains persisted and warning-visible.
Killed/stale recovery consumes the persisted cleanup, and recursive cleanup is restricted to
Zeroshot-owned provider overlays. A terminal task that retains cleanup ownership after a failed
watcher cleanup retries that persisted cleanup through `kill` without signaling the already-terminal
provider boundary; success clears the receipt and failure keeps it retryable. If watcher termination
cannot confirm that boundary, the task remains nonterminal with its PID, process group, strategy,
and cleanup ownership intact; retry and cleanup stay blocked until a later kill confirms termination.
Cancellation before PID publication is a durable task intent. Both watcher paths check it before
provider spawn and immediately after publishing the owned PID boundary; callers retain their task
handle until terminal state and command cleanup are both confirmed.
Provider continuation is agent- and generation-owned and becomes durable only after logical output
validation and the `onComplete` hook succeed. A requested resume is successful only when the
watcher captures that exact same nonempty provider session ID; absent or forked identity fails the
attempt before hooks and forces the retry to rebuild full context. Watchers track every unique
session ID observed in a task; once two IDs differ, the persisted capture is permanently ambiguous
even if a later event repeats the requested ID. Persist SQLite rowid high-water and applied-guidance
cursors as canonical decimal strings, bind them to SQLite as `BigInt`, and never coerce them through
JavaScript `Number`. Persist those cursors and a bounded SHA-256 selected-prompt identity with the
observed provider session; never persist the selected prompt text. Restored
continuations fail closed unless the final durable `TASK_COMPLETED` boundary and all provenance
match. Full and continuation source/guidance reads are bounded through the captured high-water;
continuations query strictly after their prior sequence and de-duplicate the exact triggering
message by ledger ID. Timestamps are display/filter metadata, not continuation cursors: concurrent
writers can share one millisecond. If the installed CLI cannot resume, rebuild full context or fail
before launch—never send a continuation delta to a fresh provider session.

Provider session reuse is explicit-ID and agent-owned. Watcher-observed IDs are distinct from
requested resume IDs. Commit continuation only after logical/structured success and bind it to the
completed task, agent, generation, provider, cwd, and worktree. A resumed turn sends only new
trigger/guidance context; it never replays static prompts or ISSUE_OPENED/PLAN_READY packs already in
the provider session. Persist continuation in that agent's `agentStates` entry, never in native
`ClusterLedger`, never select a cwd-wide "latest" session, and never share across agents. Durable
restore fails closed unless the last lifecycle boundary is the exact matching `TASK_COMPLETED`;
live, failed, retry/backoff, provider-switch, unsupported, Docker, and workspace-drift states start
fresh.

### Guidance Messaging

- Topics: `USER_GUIDANCE_CLUSTER`, `USER_GUIDANCE_AGENT` (see `src/guidance-topics.js`).
- Mailbox helper: `ledger.queryGuidanceMailbox()` with `messageBus.queryGuidanceMailbox()` passthrough.
- Live injection: `Orchestrator.sendGuidanceToAgent()` uses `agent.injectInput()` to attempt PTY stdin; always persists `USER_GUIDANCE_AGENT` with `metadata.delivery` (`status: injected|unsupported`, `method: pty`, `taskId`, `reason`).
- Safe-point queue fallback: `AgentWrapper._buildContext()` pulls queued guidance via `collectQueuedGuidance()` and injects a delimited block in `agent-context-builder` between Instructions and Output Schema. Durable sequence: `agent.lastGuidanceAppliedId`.

### Agent Configuration (Minimal)

```json
{
  "id": "worker",
  "role": "implementation",
  "modelLevel": "level2",
  "triggers": [{ "topic": "ISSUE_OPENED", "action": "execute_task" }],
  "prompt": "Implement the requested feature...",
  "hooks": {
    "onComplete": {
      "action": "publish_message",
      "config": { "topic": "IMPLEMENTATION_READY" }
    }
  }
}
```

### Provider Model Levels

- Use `modelLevel` (`level1`/`level2`/`level3`) for provider-agnostic configs.
- Set `provider` per agent or `defaultProvider`/`forceProvider` at cluster level.
- Provider names use CLI identifiers: `claude`, `codex`, `gemini`, `opencode`, `pi`, `copilot` (legacy `anthropic`/`openai`/`google` map to these).
- `model` remains a provider-specific escape hatch.
- Claude/Codex/Opencode only: `reasoningEffort` (`low|medium|high|xhigh|max`).
- Configure non-catalog Opencode model IDs only through
  `providerSettings.opencode.levelOverrides.<level>.model`; direct agent model IDs remain
  catalog-validated.
- Provider-level selections crossing nested `zeroshot task run` boundaries carry only their level.
  Local children re-resolve the concrete model from effective settings. Docker children receive a
  temporary settings file containing only the requested OpenCode level and model; its path and
  bootstrap marker are removed before provider spawn. Never trust a public environment overlay,
  caller-supplied provenance, or a direct/hidden model argument for configured models.

### Logic Script API

```javascript
// Ledger (auto-scoped to cluster)
ledger.query({ topic, sender, since, limit });
ledger.findLast({ topic });
ledger.count({ topic });

// Cluster
cluster.getAgents();
cluster.getAgentsByRole('validator');

// Helpers
helpers.allResponded(agents, topic, since);
helpers.hasConsensus(topic, since);
```

Context strategies now support `since: 'last_agent_start'` to scope history to the most recent
iteration start for the executing agent. Acceptable values: `cluster_start`, `last_task_end`,
`last_agent_start`, or an ISO timestamp string.

## Conductor: 2D Classification

Classifies tasks on Complexity x TaskType, routes to parameterized templates.

| Complexity | Description            | Validators |
| ---------- | ---------------------- | ---------- |
| TRIVIAL    | 1 file, mechanical     | 0          |
| SIMPLE     | 1 concern              | 1          |
| STANDARD   | Multi-file             | 3          |
| CRITICAL   | Auth/payments/security | 5          |

| TaskType | Action                |
| -------- | --------------------- |
| INQUIRY  | Read-only exploration |
| TASK     | Implement new feature |
| DEBUG    | Fix broken code       |

Base templates: `single-worker`, `worker-validator`, `debug-workflow`, `full-workflow`.

## Isolation Modes

| Mode     | Flag         | Use When                                           |
| -------- | ------------ | -------------------------------------------------- |
| Worktree | `--worktree` | Quick isolated work, PR workflows                  |
| Docker   | `--docker`   | Full isolation, risky experiments, parallel agents |

Worktree: lightweight git branch isolation (<1s setup).
Docker: fresh git clone in container, credentials mounted, auto-cleanup.

## Docker Mount Configuration

Configurable credential mounts for `--docker` mode. See `lib/docker-config.js`.

| Setting                | Type          | Default  | Description                                           |
| ---------------------- | ------------- | -------- | ----------------------------------------------------- | ---------------------------------------- |
| `dockerMounts`         | `Array<string | object>` | `['gh','git','ssh']`                                  | Presets or `{host, container, readonly}` |
| `dockerEnvPassthrough` | `string[]`    | `[]`     | Extra env vars (supports `VAR`, `VAR_*`, `VAR=value`) |
| `dockerContainerHome`  | `string`      | `/root`  | Container home for `$HOME` expansion                  |

Mount presets: infrastructure presets plus provider ids from `src/agent-cli-provider/provider-registry.ts`.

Provider CLIs in Docker require credential mounts; Zeroshot warns when missing.

Env var syntax:

- `VAR` -> pass if set in host env
- `VAR_*` -> pass all matching (e.g., `TF_VAR_*`)
- `VAR=value` -> always set to value
- `VAR=` -> always set to empty string

Config priority: CLI flags > `ZEROSHOT_DOCKER_MOUNTS` env > settings > defaults.

```bash
# Persistent config
zeroshot settings set dockerMounts '["gh","git","ssh","aws"]'

# Per-run override
zeroshot run 123 --docker --mount ~/.custom:/root/.custom:ro

# Disable all mounts
zeroshot run 123 --docker --no-mounts
```

## Adversarial Tester (STANDARD+ only)

Core principle: tests passing != implementation works. The ONLY verification is: USE IT YOURSELF.

1. Read issue -> understand requirements
2. Look at code -> figure out how to invoke
3. Run it -> did it work?
4. Try to break it -> edge cases
5. Verify each requirement -> evidence (command + output)

## Persistence

| File                        | Content               |
| --------------------------- | --------------------- |
| `~/.zeroshot/clusters.json` | Cluster metadata      |
| `~/.zeroshot/<id>.db`       | SQLite message ledger |

All production writes to the global settings file must use `lib/settings.js::mutateSettings`.
Callers provide only their intended mutation; they must never write a previously loaded full
snapshot. The shared primitive re-reads under one `proper-lockfile` lock and publishes by
same-directory atomic rename. Global settings reads remain lock-free.

Clusters survive crashes. Resume: `zeroshot resume <id>`.

## Known Limitations

Bash subprocess output not streamed: Claude CLI returns `tool_result` after subprocess completes.
Long scripts show no output until done.

Strict structured-output Codex tasks use the attachable PTY watcher. Claude strict
structured-output tasks keep the non-PTY watcher because PTY notifications can be
interpreted as streaming commands; use `zeroshot logs` for those tasks.
Attach sockets use the shared short runtime namespace from `src/attach/socket-paths.js`;
never reconstruct their path from `HOME` in a watcher or client.

### Kubernetes / Network Storage (SQLite Ledger)

Zeroshot’s message ledger is SQLite (`~/.zeroshot/<id>.db`). On Kubernetes, putting this on a
network filesystem (EFS/NFS/CephFS) can cause severe latency and lock contention.

Mitigations (env vars):

- `ZEROSHOT_SQLITE_JOURNAL_MODE=DELETE` (or `TRUNCATE`) for network filesystems that don’t like WAL
- `ZEROSHOT_SQLITE_WAL_AUTOCHECKPOINT_PAGES=1000` (default) to avoid per-write checkpoint storms
- `ZEROSHOT_SQLITE_BUSY_TIMEOUT_MS=5000` (default) to reduce `SQLITE_BUSY` flakiness under contention

Operational rule: don’t run multiple pods against the same `~/.zeroshot` volume unless you
really know what you’re doing—SQLite is not a multi-writer, multi-node database.

## Fixed Bugs (Reference)

### Template Agent CWD Injection (2026-01-03)

Bug: `--ship` mode created worktree but template agents (planning, implementation, validator)
ran in main directory instead, polluting it with uncommitted changes.

Root cause: `_opAddAgents()` didn't inject cluster's worktree cwd into dynamically spawned
template agents. Initial agents got cwd via `startCluster()`, but template agents loaded
later via conductor classification missed it.

Fix: added cwd injection to `_opAddAgents()` and resume path in `orchestrator.js`.
Test: `tests/worktree-cwd-injection.test.js`.

### PR Mode Completion Hang (2026-01-15)

Bug: PR-mode clusters stayed running after PR creation/merge because no
`CLUSTER_COMPLETE` was ever published.

Root cause: `git-pusher` relied on `output.publishAfter` without an onComplete
hook, so the orchestrator never received the completion signal.

Fix: added `onComplete` publish of `CLUSTER_COMPLETE` in
`src/agents/git-pusher-agent.json`.
Test: `tests/integration/orchestrator-flow.test.js`.

### Foreground Resume Exit Delay (2026-07-17)

Bug: foreground `zeroshot resume` could print cluster completion but remain alive until a
five-second task-shutdown timer expired.

Root cause: agent shutdown raced in-flight execution against a bounded timeout without clearing the
losing timer, and the resume CLI omitted the foreground orchestrator cleanup used by `run`.

Fix: clear the bounded-wait timer, close non-daemon resume orchestrators in `finally`, and make
orchestrator close release snapshotter, message-bus, and ledger resources.
Tests: `tests/unit/agent-lifecycle-stop.test.js` and
`tests/e2e/resume-detach-daemon.test.js`.

## Enforcement Philosophy

**ENFORCE > DOCUMENT. If enforceable, don't document.**

Preference: Type system > ESLint > Pre-commit hook > Documentation

Error messages ARE the documentation. Write them with what + fix.

## Anti-Patterns (Zeroshot-Specific)

### 1. Running Zeroshot Without Permission

```bash
# ❌ FORBIDDEN
agent: "I'll run zeroshot on issue #123"
zeroshot run 123

# ✅ CORRECT
agent: "Would you like me to run zeroshot on issue #123?"
# Wait for user consent
```

WHY: Multi-agent runs consume significant API credits.

### 2. Git Commands in Validator Prompts

```bash
# ❌ FORBIDDEN
validator_prompt: "Run git diff to verify changes..."

# ✅ CORRECT
validator_prompt: "Read src/index.js and verify function exists..."
```

WHY: Multiple agents modify git state concurrently. Validator reads stale state.

### 3. Asking Questions in Autonomous Workflows

```javascript
// ❌ FORBIDDEN
await AskUserQuestion('Should I use approach A or B?');

// ✅ CORRECT
// Decision: Using approach A because requirement specifies X
```

WHY: Zeroshot agents run non-interactively.

### 4. Worker Git Operations Without Isolation

```bash
# ❌ FORBIDDEN
zeroshot run 123  # Pollutes main directory

# ✅ CORRECT
zeroshot run 123 --worktree  # Isolated
zeroshot run 123 --pr        # Worktree + PR
zeroshot run 123 --docker    # Full isolation
```

WHY: Prevents contamination, enables parallel work.

### 5. Using Git Stash

```bash
# ❌ FORBIDDEN
git stash  # Hides work from other agents

# ✅ CORRECT
git add -A && git commit -m "WIP: feature implementation"
git switch other-branch
```

WHY: WIP commits are visible, never lost, squashable.

## Behavioral Rules

### Git Workflow (Multi-Agent)

Use WIP commits instead of stashing:

```bash
git add -A && git commit -m "WIP: save work"  # Instead of git stash
git switch <branch>                            # Instead of git checkout
git restore <file>                             # Instead of git checkout --
```

Bind issue context before inserting shell-quoted Git configuration into prompt commands. Never run
global placeholder replacement over a completed command prompt: Git-valid names can contain
placeholder-like text.

### Test-First Workflow

Write tests BEFORE or WITH code:

```bash
touch src/new-feature.js
touch tests/new-feature.test.js  # FIRST
# Write failing tests → Implement → Pass
```

### Validation Workflow

Rust APIs are mechanically capped at four parameters by `clippy.toml`. The only
symbol-level exceptions are frozen pre-6.7.2 public compatibility declarations
and their exact implementations, each carrying a rationale. Opcore remains at
six because it has no per-symbol override; new and internal APIs must use request
structs rather than raising or bypassing the Clippy ceiling.

Run validation for:

- Significant changes (>50 lines)
- Refactoring across files
- When user explicitly requests

Trust pre-commit hooks for trivial changes.
`npm run test:unit` uses a temporary home and settings path; operator settings must not affect it.

```bash
npm run lint
npm run test
```

Mocha config: `.mocharc.cjs` applies defaults; passing explicit `*.test.js` files on the CLI skips the default `tests/**/*.test.js` spec.
The Mocha bootstrap isolates unit tests from live `ZEROSHOT_*` run options and user settings;
tests must not depend on ambient cluster state or `~/.zeroshot/settings.json`.
`ZEROSHOT_HOME` is immutable inside a Mocha worker because `task-lib/config.js` caches the task-store
root at module load; alternate-home scenarios must run in an isolated child process.

Workers are now explicitly ordered to treat every `VALIDATION_RESULT` line as non-negotiable law before typing again. Failing to read and address each validator complaint before claiming completion will be rejected automatically.

## CI Failure Diagnosis

Multiple CI jobs fail → Diagnose each independently.

1. Get exact status: `gh api repos/the-open-engine/zeroshot/actions/runs/{RUN_ID}/jobs`
2. Read ACTUAL error: `gh api repos/the-open-engine/zeroshot/actions/jobs/{JOB_ID}/logs`
3. Fix ONE error → Push → Rerun → Repeat

## Release Pipeline Convention

- `main` is the only development and release branch.
- Feature branches merge directly to `main` through its merge queue.
- Main requires `check` + `install-matrix`; semantic-release runs only after the exact merged
  `main` commit passes CI.
- Conventional squash-commit titles select patch/minor/major. Documentation and chore commits may
  intentionally produce no release.
- The checked-in `0.0.0-development` manifest version is deliberately non-authoritative;
  semantic-release derives and writes the published version from Git tags in its release workspace.
- There is no release-promotion PR and no `dev -> main` synchronization step.

Do NOT assume single root cause.

## CLAUDE.md Writing Rules

**Scope:** Narrowest possible.

**Content Priority:**

1. CRITICAL gotchas (caused real bugs)
2. "Where to Look" routing tables
3. Anti-patterns with WHY
4. Commands/troubleshooting

**DELETE:** Tutorial content, directory trees, interface definitions

**Format:** Tables over prose, ❌/✅ examples with WHY

## Mechanical Enforcement

| Antipattern                | Enforcement        |
| -------------------------- | ------------------ |
| Dangerous fallbacks        | ESLint ERROR       |
| Manual git tags            | Pre-push hook      |
| Git in validator prompts   | Config validator   |
| Multiple impl files (-v2)  | Pre-commit hook    |
| Spawn without permission   | Runtime check      |
| Git stash usage            | Pre-commit hook    |
| lint-staged backup stashes | Pre-commit wrapper |
| Rust formatting drift      | Pre-commit hook    |
| Rust APIs over 4 params    | Clippy error       |
