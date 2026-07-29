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

| Concept                      | File                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| Conductor classification     | `src/conductor-bootstrap.js`                                            |
| Base templates               | `cluster-templates/base-templates/`                                     |
| Message bus                  | `src/message-bus.js`                                                    |
| Ledger (SQLite)              | `src/ledger.js`                                                         |
| Guidance topics              | `src/guidance-topics.js`                                                |
| Guidance mailbox helper      | `src/ledger.js`                                                         |
| Guidance live injection      | `src/orchestrator.js`                                                   |
| Trigger evaluation           | `src/logic-engine.js`                                                   |
| Agent wrapper                | `src/agent-wrapper.js`                                                  |
| Providers registry           | `src/providers/index.js`                                                |
| Provider implementations     | `src/providers/`                                                        |
| Provider engine registry     | `src/agent-cli-provider/provider-registry.ts`                           |
| Gateway runner               | `src/agent-cli-provider/gateway-runner.ts`                              |
| Gateway tools/policy         | `src/agent-cli-provider/gateway-tools.ts`                               |
| Provider detection           | `lib/provider-detection.js`                                             |
| Provider capabilities        | `src/providers/capabilities.js`                                         |
| Claude settings overlay      | `src/worktree-claude-config.js`                                         |
| Detached task cleanup owner  | `task-lib/command-spec-cleanup.js`                                      |
| Shared watcher output path   | `task-lib/watcher-output-runtime.js`                                    |
| Provider session reuse       | `src/agent/provider-session.js`                                         |
| Start-cluster helper         | `lib/start-cluster.js`                                                  |
| Legacy worker facade         | `lib/cluster-worker/`                                                   |
| Legacy worker executable     | `bin/zeroshot-cluster-worker.js`                                        |
| Docker mounts/env            | `lib/docker-config.js`                                                  |
| Container lifecycle          | `src/isolation-manager.js`                                              |
| Settings                     | `lib/settings.js`                                                       |
| Cluster wire/domain types    | `crates/openengine-cluster-protocol/`                                   |
| Admission wire semantics     | `crates/openengine-cluster-protocol/src/admission.rs`                   |
| Graph AST/bindings/guards    | `crates/openengine-cluster-protocol/src/graph.rs`                       |
| Closed payload algebra       | `crates/openengine-cluster-protocol/src/payload.rs`                     |
| Closed payload validation    | `crates/openengine-cluster-protocol/src/payload_value.rs`               |
| Compiled IR/identity         | `crates/openengine-cluster-protocol/src/canonical.rs`                   |
| Artifact receipts            | `crates/openengine-cluster-protocol/src/artifact.rs`                    |
| Graph diagnostics/bounds     | `crates/openengine-cluster-protocol/src/diagnostic.rs`                  |
| Shared wire-value bounds     | `crates/openengine-cluster-protocol/src/value.rs`                       |
| Cluster server crate         | `crates/openengine-cluster-server/`                                     |
| Graph verifier facade        | `crates/openengine-cluster-server/src/graph_verifier.rs`                |
| Graph verifier analysis      | `crates/openengine-cluster-server/src/graph_verifier/`                  |
| Native product construction  | `zeroshot-rust/`                                                        |
| Native release targets       | `distribution/zeroshot-rust-targets.json`                               |
| Native npm binary shim       | `npm/zeroshot-rust/`                                                    |
| Native distribution tooling  | `scripts/rust-distribution.js`                                          |
| Native distribution decision | `docs/zeroshot-rust-distribution.md`                                    |
| Native cluster ledger        | `zeroshot-rust/src/cluster_ledger.rs`                                   |
| Ledger store port/fake       | `zeroshot-rust/src/cluster_ledger/store.rs`, `store/fake.rs`            |
| SQLite ledger store          | `zeroshot-rust/src/cluster_ledger/store/sqlite.rs`, `store/sqlite/`     |
| SQLite append/query helpers  | `zeroshot-rust/src/cluster_ledger/store/sqlite/{operations,queries}.rs` |
| Ledger records/replay        | `zeroshot-rust/src/cluster_ledger/record.rs`, `replay.rs`               |
| Full-v1 pure graph reducer    | `zeroshot-rust/src/full_v1_reducer.rs`                              |
| Protocol ledger adapters     | `zeroshot-rust/src/cluster_ledger/adapters.rs`                          |
| Artifact store port/fake     | `zeroshot-rust/src/artifact_store.rs`, `artifact_store/fake.rs`         |
| Product-local artifact CAS   | `zeroshot-rust/src/artifact_store/local_cas.rs`, `local_cas/`           |
| Required-proof contracts     | `zeroshot-rust/src/required_proof.rs`                                   |
| Issue provider contracts     | `zeroshot-rust/src/issue_provider.rs`, `issue_provider/`                |
| Source provider contracts    | `zeroshot-rust/src/source_code_provider.rs`, `source_code_provider/`    |
| Provider value bounds        | `zeroshot-rust/src/provider_value.rs`, `provider_value/`                |
| Native worker catalog        | `zeroshot-rust/src/worker_catalog.rs`                                   |
| Execution runtime seam       | `zeroshot-rust/src/execution.rs`, `execution/types.rs`                  |
| Local runtime + drivers      | `zeroshot-rust/src/execution/{local,driver}.rs`                         |
| Local process runner         | `zeroshot-rust/src/execution/process.rs`                                |
| Fair scheduler               | `zeroshot-rust/src/scheduler.rs`                                        |
| Native safe faults           | `zeroshot-rust/src/fault.rs`                                            |
| Native fault taxonomy        | `zeroshot-rust/src/fault/taxonomy.rs`                                   |
| Native diagnostic redaction  | `zeroshot-rust/src/fault/redaction.rs`                                  |
| Native observability         | `zeroshot-rust/src/observability.rs`                                    |
| Admission coordinator        | `crates/openengine-cluster-server/src/admission.rs`                     |
| Admission durable ports      | `crates/openengine-cluster-server/src/admission/ports.rs`               |
| Admission snapshot folding   | `crates/openengine-cluster-server/src/admission/snapshot.rs`            |
| Lifecycle state machine      | `crates/openengine-cluster-server/src/lifecycle.rs`                     |
| Lifecycle durable ports      | `crates/openengine-cluster-server/src/lifecycle/ports.rs`               |
| Watch event stream/handle    | `crates/openengine-cluster-server/src/watch.rs`                         |
| Watch observation port       | `crates/openengine-cluster-server/src/watch/ports.rs`                   |
| Watch minimal test fixture   | `crates/openengine-cluster-server/src/watch/fixtures.rs`                |
| Watch wire types/framing     | `crates/openengine-cluster-protocol/src/watch.rs`                       |
| Client watch/reconnect       | `crates/openengine-cluster-client/src/watch.rs`                         |
| NDJSON stdio binding         | `crates/openengine-cluster-server/src/stdio.rs`                         |
| NDJSON watch client          | `crates/openengine-cluster-client/src/ndjson_watch.rs`                  |
| Connection core/admission    | `crates/openengine-cluster-server/src/connection.rs`, `connection/`     |
| JSON-RPC envelope/routing    | `crates/openengine-cluster-server/src/dispatch.rs`                      |
| NDJSON response pump         | `crates/openengine-cluster-client/src/ndjson_pump.rs`                   |
| Cluster typed transports     | `crates/openengine-cluster-client/`                                     |
| TypeScript cluster client    | `src/cluster/`                                                          |
| TypeScript protocol emitter  | `scripts/generate-cluster-types.js`                                     |
| Cluster fixtures/artifacts   | `crates/openengine-cluster-testkit/`                                    |
| Portable backend conformance | `crates/openengine-cluster-testkit/src/conformance.rs`                  |
| Scripted admission fixtures  | `crates/openengine-cluster-testkit/src/admission.rs`                    |
| Fixture inspection controls  | `crates/openengine-cluster-testkit/src/admission/inspection.rs`         |
| Scripted lifecycle helpers   | `crates/openengine-cluster-testkit/src/lifecycle.rs`                    |
| Lifecycle fixture params     | `crates/openengine-cluster-testkit/src/lifecycle/params.rs`             |
| In-memory observation store  | `crates/openengine-cluster-testkit/src/watch.rs`                        |
| Admission transcript output  | `crates/openengine-cluster-testkit/src/admission_artifacts.rs`          |
| Watch/subscription artifacts | `crates/openengine-cluster-testkit/src/watch_artifacts.rs`              |
| Negative graph vectors       | `crates/openengine-cluster-testkit/src/negative_graph_fixtures.rs`      |
| Verifier vectors             | `crates/openengine-cluster-testkit/src/graph_verifier_artifacts.rs`     |
| Graph contract prose         | `docs/openengine-cluster-protocol/v1/graph-contract.md`                 |
| Admission contract prose     | `docs/openengine-cluster-protocol/v1/admission.md`                      |
| Lifecycle contract prose     | `docs/openengine-cluster-protocol/v1/lifecycle.md`                      |
| Watch contract prose         | `docs/openengine-cluster-protocol/v1/watch.md`                          |
| Generated graph fixtures     | `protocol/openengine-cluster/v1/fixtures/graph/`                        |
| Generated watch fixtures     | `protocol/openengine-cluster/v1/fixtures/watch/`                        |

Cluster Protocol Rust types are the source of truth. Files under
`protocol/openengine-cluster/v1/` are generated projections; update them with
`cargo run -p openengine-cluster-testkit --bin generate-cluster-protocol -- --write` and
verify byte-for-byte drift with `npm run protocol:check`. These generator-formatted artifacts
are excluded from Prettier; never format them independently.
Native release metadata and npm installer code stay outside the Rust-only `zeroshot-rust/`
package. `distribution/zeroshot-rust-targets.json` is the authoritative release target list;
the workflow matrix and checksum coverage must match it exactly.
The published Node binding is the standalone `@the-open-engine/zeroshot/cluster` subpath.
`Connection` exclusively owns request IDs and transport teardown; watch reconnect consumes an old
stream exactly once on an application-supplied fresh connection. Keep `src/cluster/` isolated from
product internals, and regenerate its wire types from the authoritative protocol artifacts with
`npm run protocol:generate`.
The protocol and server crates own wire contracts, backend traits, the dispatcher, and transports.
Portable external conformance is the immutable public catalog in the testkit and covers only
backend-neutral behavior observable through public dispatcher and typed subscription surfaces.
The existing integration binaries remain the richer reference regression suite; their
implementation-specific vectors are not represented as portable external certification.
`zeroshot-rust/` owns the concrete `NativeBackend`, product-local `NativeBackendFactory`
construction root, product-private artifact byte-store port/local CAS, and product-private,
secret-free issue/source provider contracts. Artifact stages, bytes, roots, filesystem paths,
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
`ExecutionRuntime`, `LocalExecutionRuntime`, `LocalProcessRunner`, and the daemon-scoped fair
scheduler are engine-private seams. They own local dispatch placement, fencing, deadlines,
workspace conflict arbitration, cancellation, and local-process containment only. They do not own
ledger mutation, durable attempt state, protocol methods, provider catalog/configuration,
credential resolution, workspace lifecycle, real CLI/ACP/Gateway drivers, built-in registration,
or `NativeBackend` composition. Runtime command/control values remain serializable, secret-free,
and input-free after control reconstruction.
Native engine faults must be constructed only by `FaultFactory` from closed `ModuleEvidence`.
Decoded faults must match the canonical semantics derived from their required primary source frame.
Raw diagnostic values are replaced wholesale with typed markers and remain ephemeral; never put
them in `EngineFault`, observations, protocol responses, persistence, or exports. Observability is
injected through `ObservationSink` and uses only the fixed metrics and closed dimensions in
`observability.rs`; retry disposition is descriptive data, not retry authorization. Do not install
global telemetry state or caller-defined labels.
A lost node-instance session terminates the affected execution; its descriptive fault disposition
must never authorize retry or replacement-session recovery.
`ClusterLedger` is the only native durable domain authority. Its closed/versioned record algebra,
identity allocation, replay, lifecycle/CAS/idempotency rules, and safe-fault consequences stay
above the backend-neutral `LedgerStore` port. Control and verified I/O share one ordered hash
chain and transaction. Semantic validation and append CAS use the same folded position/hash; never
reread a newer prefix while committing payloads derived from an older one.
Reducer-owned loser voids require an opaque reducer-issued authorization bound to the admitted
compiled IR, verified input, exact folded prefix, durable execution history, execution, and reason;
caller-supplied execution identity or reason alone can never authorize an `ExecutionVoid` append.
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
Each binding parses inbound JSON once into the duplicate-preserving connection frame. Preserve the
legacy typed-request classification used for duplicate-ID and task-slot admission before the strict
envelope outcome; malformed and wrong-version responses still cross that shared admission boundary.
`Dispatcher::dispatch_decoded` owns method lookup before params-shape validation, while
`Dispatcher::dispatch` is only the JSON-RPC envelope decoder.
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
Model gateways stay behind the single bundled `gateway` engine. Do not add `openrouter`, `ollama`, `vllm`, `hermes`, or similar model-only targets as standalone provider ids.

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
