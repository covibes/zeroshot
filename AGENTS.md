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
  released commit. For Node-owned changes, `fix:`/`perf:` publish patches, `feat:` publishes minors,
  breaking syntax publishes majors, and `docs:`/`chore:` intentionally publish nothing.
- Node and Zeroshot Rust release independently from `main`. Node owns `vX.Y.Z` and automatic
  semantic releases. Rust uses explicit `zeroshot-rust-vX.Y.Z` releases and must never affect the
  next Node version or generated Node notes.
- Checked-in publication manifests are non-authoritative development versions. Release tags, npm
  metadata, and GitHub Releases are authoritative; automation must never commit versions to `main`.
- Curated notes live at `docs/releases/vX.Y.Z.md`. Recovery may operate only from an immutable
  `vX.Y.Z` tag whose exact commit is an ancestor of `main`, and it must never overwrite an existing
  npm version or GitHub Release.
- Provider output-silence liveness checks are opt-in (`enableLivenessCheck: true`). Recovery tests
  that exercise stale-agent termination must enable the watchdog explicitly.
- Isolation copies must reuse the shared pinned-root boundary in `src/copy-containment.ts` for
  traversal, directory creation, synchronous copies, and worker copies. Revalidate the source and
  destination immediately before every filesystem effect; never reconstruct unchecked effect paths.

Worker git operations are allowed only with isolation (`--worktree`, `--docker`, `--pr`, `--ship`). They are forbidden without isolation.

Native-v2 provider continuation is fixed and bounded: Claude continues once only after a
`system/api_retry` event, Codex continues once after any terminal execution error, and both send
the literal `Continue` in the same session (or rerun the original prompt only when no session was
created). Agent output gets at most two correction turns before `malformed`. Direct GitHub merge
rejection is reobserved once for CI registration races, then terminates as a policy refusal.

Read-only safe commands: `zeroshot list`, `zeroshot status`, `zeroshot logs`

Destructive commands (need permission): `zeroshot kill`, `zeroshot clear`, `zeroshot purge`

## Where to Look

| Concept                                   | File                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Conductor classification                  | `src/conductor-bootstrap.js`                                                                                                     |
| Base templates                            | `cluster-templates/base-templates/`                                                                                              |
| Message bus                               | `src/message-bus.js`                                                                                                             |
| Ledger (SQLite)                           | `src/ledger.js`                                                                                                                  |
| Guidance topics                           | `src/guidance-topics.ts` (generated CommonJS: `src/guidance-topics.js`)                                                          |
| Guidance mailbox helper                   | `src/ledger.js`                                                                                                                  |
| Guidance live injection                   | `src/orchestrator.js`                                                                                                            |
| Trigger evaluation                        | `src/logic-engine.js`                                                                                                            |
| Agent wrapper                             | `src/agent-wrapper.js`                                                                                                           |
| Agent context assembly                    | `src/agent/agent-context-*.ts`, `src/agent/context-pack-*.ts`                                                                    |
| Providers registry                        | `src/providers/index.js`                                                                                                         |
| Provider implementations                  | `src/providers/`                                                                                                                 |
| Provider engine registry                  | `src/agent-cli-provider/provider-registry.ts`                                                                                    |
| Pi JSON protocol                          | `src/agent-cli-provider/pi/`                                                                                                     |
| Pi watcher lifecycle                      | `src/agent/pi-terminal-lifecycle.ts`                                                                                             |
| Provider terminal failure                 | `src/agent/provider-terminal-failure.ts`                                                                                         |
| Structured-output recovery                | `src/agent/output-reformatter.ts`                                                                                                |
| Provider output extraction                | `src/agent/output-extraction.ts`                                                                                                 |
| Gateway runner                            | `src/agent-cli-provider/gateway-runner.ts`                                                                                       |
| Gateway tools/policy                      | `src/agent-cli-provider/gateway-tools.ts`                                                                                        |
| OMP release/version pinning               | `src/agent-cli-provider/omp-release.ts`                                                                                          |
| OMP RPC codec (JSONL/chunking)            | `src/agent-cli-provider/omp-rpc-protocol.ts`                                                                                     |
| OMP RPC lifecycle driver                  | `src/agent-cli-provider/omp-rpc-driver.ts`                                                                                       |
| OMP RPC frame normalization               | `src/agent-cli-provider/omp-rpc-events.ts`                                                                                       |
| OMP session launch types                  | `src/agent-cli-provider/omp-rpc-session.ts`                                                                                      |
| OMP config safety overlay                 | `src/omp-config-overlay.ts`                                                                                                      |
| OMP detached RPC watcher                  | `task-lib/rpc-watcher.js`                                                                                                        |
| Provider detection                        | `lib/provider-detection.js`                                                                                                      |
| Maintained legacy TypeScript leaves       | `src/legacy-lib/` (generated CommonJS: matching paths under `lib/` via `build:legacy-lib`)                                       |
| Maintained runtime TypeScript leaves      | Beside runtime paths (generated CommonJS via `build:legacy-runtime`; task-lib ESM via `build:task-lib`)                          |
| Attach session facade/client/server       | `src/attach/{index,attach-client,attach-server}.ts`                                                                              |
| Attach server lifecycle and PTY           | `src/attach/attach-server-{runtime,pty,socket}.ts`                                                                               |
| Attach server clients and cleanup         | `src/attach/attach-server-{clients,events,cleanup,types}.ts`                                                                     |
| Template validation entrypoint            | `src/template-validation/index.js`                                                                                               |
| Shared template simulation seam           | `src/template-validation/{simulation-runtime,simulation-agent,simulation-agent-runtime}.ts`                                      |
| Random topology simulation pipeline       | `src/template-validation/random-topology-*.ts`, `simulate-random-topology.ts`                                                    |
| Provider capabilities                     | `src/providers/capabilities.ts` (generated CommonJS: `src/providers/capabilities.js`)                                            |
| Claude settings overlay                   | `src/worktree-claude-config.ts`                                                                                                  |
| Detached/foreground cleanup ownership     | `src/command-cleanup-ownership.js` (re-exported by `task-lib/command-spec-cleanup.js` and used directly by `contract-invoke.ts`) |
| Shared watcher output path                | `task-lib/watcher-output-runtime.js`                                                                                             |
| Provider session reuse                    | `src/agent/provider-session.js`                                                                                                  |
| Start-cluster helper                      | `lib/start-cluster.js`                                                                                                           |
| Legacy worker facade                      | `lib/cluster-worker/`                                                                                                            |
| Legacy worker executable                  | `bin/zeroshot-cluster-worker.js`                                                                                                 |
| Docker mounts/env                         | `lib/docker-config.js`                                                                                                           |
| Container lifecycle                       | `src/isolation-manager.js`                                                                                                       |
| Pull-request body templates               | `src/pr-body-template.js`, `src/agents/git-pusher-template.js`                                                                   |
| Settings                                  | `lib/settings.js`                                                                                                                |
| Legacy settings property selection        | `src/repo-settings-access.ts`                                                                                                    |
| Cluster wire/domain types                 | `crates/openengine-cluster-protocol/`                                                                                            |
| Admission wire semantics                  | `crates/openengine-cluster-protocol/src/admission.rs`                                                                            |
| Graph AST/bindings/guards                 | `crates/openengine-cluster-protocol/src/graph.rs`                                                                                |
| Closed payload algebra                    | `crates/openengine-cluster-protocol/src/payload.rs`                                                                              |
| Closed payload validation                 | `crates/openengine-cluster-protocol/src/payload_value.rs`                                                                        |
| Compiled IR/identity                      | `crates/openengine-cluster-protocol/src/canonical.rs`                                                                            |
| Shared non-v2 artifact receipt types      | `crates/openengine-cluster-protocol/src/artifact.rs`                                                                             |
| Graph diagnostics/bounds                  | `crates/openengine-cluster-protocol/src/diagnostic.rs`                                                                           |
| Shared wire-value bounds                  | `crates/openengine-cluster-protocol/src/value.rs`                                                                                |
| Cluster server crate                      | `crates/openengine-cluster-server/`                                                                                              |
| Graph verifier facade                     | `crates/openengine-cluster-server/src/graph_verifier.rs`                                                                         |
| Graph verifier analysis                   | `crates/openengine-cluster-server/src/graph_verifier/`                                                                           |
| Native product construction               | `zeroshot-rust/`                                                                                                                 |
| Native v2 portable one-run engine/process | `zeroshot-rust/src/native_v2_portable_controller.rs`, `native_v2_portable_controller/`                                           |
| Native v2 host run router/OECP binding    | `zeroshot-rust/src/native_v2_cloud.rs`, `native_v2_cloud/`                                                                       |
| Native v2 target auth/inventory/routes    | `zeroshot-rust/src/native_v2_target_authority.rs`, `native_v2_target_authority/`                                                 |
| Native v2 hosted run composition          | `zeroshot-rust/src/native_v2_hosting.rs`, `native_v2_hosting/`                                                                   |
| Native v2 local run composition           | `zeroshot-rust/src/native_v2_local.rs`                                                                                           |
| Native v2 node-executor/capsule adapters  | `zeroshot-rust/src/native_v2_runner.rs`, `native_v2_runner/`, `zeroshot-rust/src/native_v2_capsule.rs`, `native_v2_capsule/`     |
| Native v2 provider/delivery composition   | `zeroshot-rust/src/native_v2_candidate.rs`, `native_v2_candidate/`                                                               |
| Native v2 CLI and OECP adapter            | `zeroshot-rust/src/native_v2_cli.rs`, `native_v2_cli/`                                                                           |
| Native v2 built-in graph templates        | `zeroshot-rust/src/native_v2_templates.rs`, `native_v2_templates/`                                                               |
| Native v2 target connector/server command | `zeroshot-rust/src/native_v2_target.rs`, `native_v2_target/`, `zeroshot-rust/src/main.rs`                                        |
| Native self-hosted target image           | `docker/zeroshot-rust-target/`                                                                                                   |
| Native release targets                    | `distribution/zeroshot-rust-targets.json`                                                                                        |
| Native npm binary shim                    | `npm/zeroshot-rust/`                                                                                                             |
| Native distribution tooling               | `scripts/rust-distribution.js`                                                                                                   |
| Native distribution decision              | `docs/zeroshot-rust-distribution.md`                                                                                             |
| Full-v1 pure graph reducer                | `zeroshot-rust/src/full_v1_reducer.rs`                                                                                           |
| Lean native v2 run ledger/SQLite          | `zeroshot-rust/src/v2_run_ledger.rs`, `v2_run_ledger/`                                                                           |
| Native v2 filesystem controller lease     | `zeroshot-rust/src/native_v2_portable_controller/lease.rs`                                                                       |
| Issue provider contracts                  | `zeroshot-rust/src/issue_provider.rs`, `issue_provider/`                                                                         |
| Source provider contracts                 | `zeroshot-rust/src/source_code_provider.rs`, `source_code_provider/`                                                             |
| Provider value bounds                     | `zeroshot-rust/src/provider_value.rs`, `provider_value/`                                                                         |
| Native v2 model values                    | `zeroshot-rust/src/worker_catalog.rs`                                                                                            |
| Native v2 execution primitives            | `zeroshot-rust/src/execution.rs`, `execution/driver.rs`                                                                          |
| Contained provider sessions               | `zeroshot-rust/src/execution/process.rs`, `execution/process/`                                                                   |
| Native safe faults                        | `zeroshot-rust/src/fault.rs`                                                                                                     |
| Native fault taxonomy                     | `zeroshot-rust/src/fault/taxonomy.rs`                                                                                            |
| Native diagnostic redaction               | `zeroshot-rust/src/fault/redaction.rs`                                                                                           |
| Native product error projection           | `zeroshot-rust/src/product_errors.rs`                                                                                            |
| Native observability                      | `zeroshot-rust/src/observability.rs`                                                                                             |
| Admission coordinator                     | `crates/openengine-cluster-server/src/admission.rs`, `crates/openengine-cluster-server/src/admission/core.rs`                    |
| Admission durable ports                   | `crates/openengine-cluster-server/src/admission/ports.rs`                                                                        |
| Admission snapshot folding                | `crates/openengine-cluster-server/src/admission/snapshot.rs`                                                                     |
| Lifecycle state machine                   | `crates/openengine-cluster-server/src/lifecycle.rs`                                                                              |
| Lifecycle durable ports                   | `crates/openengine-cluster-server/src/lifecycle/ports.rs`                                                                        |
| Watch event stream/handle                 | `crates/openengine-cluster-server/src/watch.rs`                                                                                  |
| Watch observation port                    | `crates/openengine-cluster-server/src/watch/ports.rs`                                                                            |
| Watch minimal test fixture                | `crates/openengine-cluster-server/src/watch/fixtures.rs`                                                                         |
| Watch wire types/framing                  | `crates/openengine-cluster-protocol/src/watch.rs`                                                                                |
| Native v2 run method wire values          | `crates/openengine-cluster-protocol/src/native_v2_{run,observation}.rs`                                                          |
| Native v2 server routes/stream seam       | `crates/openengine-cluster-server/src/native_v2.rs`, `connection/native_v2.rs`                                                   |
| Native v2 typed protocol client           | `crates/openengine-cluster-client/src/native_v2.rs`                                                                              |
| Client watch/reconnect                    | `crates/openengine-cluster-client/src/watch.rs`                                                                                  |
| NDJSON stdio binding                      | `crates/openengine-cluster-server/src/stdio.rs`                                                                                  |
| NDJSON watch client                       | `crates/openengine-cluster-client/src/ndjson_watch.rs`                                                                           |
| Connection core/admission                 | `crates/openengine-cluster-server/src/connection.rs`, `connection/`                                                              |
| JSON-RPC envelope/routing                 | `crates/openengine-cluster-server/src/dispatch.rs`                                                                               |
| Protocol method registry                  | `crates/openengine-cluster-server/src/method_registry.rs`                                                                        |
| NDJSON response pump                      | `crates/openengine-cluster-client/src/ndjson_pump.rs`                                                                            |
| Cluster typed transports                  | `crates/openengine-cluster-client/`                                                                                              |
| TypeScript cluster client                 | `src/cluster/`                                                                                                                   |
| Hosted session coordinator                | `src/hosted-session/`                                                                                                            |
| Hosted target capsule adapter             | `src/hosted-target/`                                                                                                             |
| Named target registry and sessions        | `src/target/`                                                                                                                    |
| TypeScript protocol emitter               | `scripts/generate-cluster-types.js`                                                                                              |
| Cluster fixtures/artifacts                | `crates/openengine-cluster-testkit/`                                                                                             |
| Portable backend conformance              | `crates/openengine-cluster-testkit/src/conformance.rs`                                                                           |
| Scripted admission fixtures               | `crates/openengine-cluster-testkit/src/admission.rs`                                                                             |
| Fixture inspection controls               | `crates/openengine-cluster-testkit/src/admission/inspection.rs`                                                                  |
| Scripted lifecycle helpers                | `crates/openengine-cluster-testkit/src/lifecycle.rs`                                                                             |
| Lifecycle fixture params                  | `crates/openengine-cluster-testkit/src/lifecycle/params.rs`                                                                      |
| In-memory observation store               | `crates/openengine-cluster-testkit/src/watch.rs`                                                                                 |
| Admission transcript output               | `crates/openengine-cluster-testkit/src/admission_artifacts.rs`                                                                   |
| Watch/subscription artifacts              | `crates/openengine-cluster-testkit/src/watch_artifacts.rs`                                                                       |
| Negative graph vectors                    | `crates/openengine-cluster-testkit/src/negative_graph_fixtures.rs`                                                               |
| Verifier vectors                          | `crates/openengine-cluster-testkit/src/graph_verifier_artifacts.rs`                                                              |
| Graph contract prose                      | `docs/openengine-cluster-protocol/v1/graph-contract.md`                                                                          |
| Admission contract prose                  | `docs/openengine-cluster-protocol/v1/admission.md`                                                                               |
| Lifecycle contract prose                  | `docs/openengine-cluster-protocol/v1/lifecycle.md`                                                                               |
| Watch contract prose                      | `docs/openengine-cluster-protocol/v1/watch.md`                                                                                   |
| Generated graph fixtures                  | `protocol/openengine-cluster/v1/fixtures/graph/`                                                                                 |
| Generated watch fixtures                  | `protocol/openengine-cluster/v1/fixtures/watch/`                                                                                 |

Provider-specific settings, defaults, validation, and static capabilities derive from the provider
registry; do not add parallel provider lists. Opt-in native CLI capabilities must keep requested
and effective state distinct and fail closed unless local help/version evidence proves the control.
Structured-output recovery eligibility is also registry-derived: every engine whose `jsonSchema`
capability is `true` or `experimental` must implement its provider-owned, fail-closed recovery
adapter. Recovery always runs as a fresh nested turn with provider sessions, MCP, approval bypass,
write-capable tools, network tools, and user-defined agents/configuration disabled.
OMP SDK children inherit only the registry-declared non-secret configuration environment plus the
fixed minimal process environment. Credentials remain on the private credential channel; never add
arbitrary ambient passthrough or duplicate provider configuration lists beside the registry.

Cluster Protocol Rust types are the source of truth. Files under
`protocol/openengine-cluster/v1/` are generated projections; update them with
`cargo run -p openengine-cluster-testkit --bin generate-cluster-protocol -- --write` and
verify byte-for-byte drift with `npm run protocol:check`. These generator-formatted artifacts
are excluded from Prettier; never format them independently.
Full-v1 loops may omit `until`; such loops repeat to their bound unless an inner terminal ends the
graph first.
Native release metadata and npm installer code stay outside the Rust-only `zeroshot-rust/`
package. `distribution/zeroshot-rust-targets.json` is the authoritative release target list;
the workflow matrix and checksum coverage must match it exactly.
Node and Rust CI lanes are selected by `.github/ci-path-classifier.js`; shared or unknown paths run
both. Keep the aggregate `required` check stable. Node release analysis and notes must filter every
Rust-only commit since the last Node tag, not just the triggering commit. Rust releases are manual,
use an exact `main` commit and explicit version, and publish `zeroshot-rust-vX.Y.Z`, five native
archives with `SHA256SUMS`, and the Linux AMD64 `zeroshot-rust-target` image. The optional npm shim
is published separately only after those GitHub assets exist. Rust GitHub Releases are never marked
repository-wide latest.
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
private RunIntent client requires the validated same-origin `zeroshot.run-intent/v2` discovery
extension; its job input carries only job data and never repository, provider, model, endpoint,
credential, or runtime authority. Discovery `extensions` is an open capability advertisement:
validate capabilities this client implements and ignore unsupported capabilities without inferring
routes or behavior from them. The immutable
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
`zeroshot-rust/` ships one portable native-v2 engine/library for exactly one run and a private
controller-process mode around the same engine. The CLI assigns a canonical lowercase UUIDv7
`RunId`, resolves the selected repository branch to one exact immutable revision, and submits the
exact sourceful run plus its bounded run-scoped environment. Run branch selection overrides the
local target-profile default; otherwise the remote default branch is used. `target setup` mutates
only the local named-target registry and never calls a remote setup route. The target validates the
exact environment map. Its separate ephemeral `githubToken` is trusted only for source checkout and
Git delivery; a provider receives `GH_TOKEN` only when the materialized runtime declares it.
Admission, the ledger, observations, and target configuration never retain secret values. Exact
submission retry identity covers the sourceful submission (including the resolved revision) while
excluding `runId` and all secrets; an exact replay keeps the original run and its first secret
envelope. The controller does not allocate identity, authenticate users, inspect target-wide
inventory, queue work, or choose another run. Local and hosted compositions reuse this same engine
and differ only in their host adapters.

The native-v2 target HTTP contract is the shared `zeroshot.native-v2-target/v2` discovery document,
sourceful run request, run-scoped OECP-session request, and optional generic private bootstrap
capability. Hosted remains the default named-target access, stores only the rotating refresh family
in the OS credential store, and keeps access/OECP tokens memory-only. Cloud owns organization-scoped
inventory plus queued and retained-terminal REST observation; active status/watch/logs/force and
attach route directly to the run task over OECP. Cloud and task cursors have distinct `cloud:` and
`v2:` domains, and the CLI restarts from `None` exactly when crossing that boundary. Direct access
requires `target add --direct`, must match discovery authentication, and sends no Authorization;
`target login` rejects it locally. Ordinary `target serve` remains the auth-free, long-lived
multi-run composition for a trusted private VM. Supplying `--bootstrap-key-file` only enables the
one-use private capability needed by an orchestrated task; it does not select a managed run mode or
change controller semantics. Cloud enforces one task per run through routing, outside the target.
The self-hosted image packages that server with the pinned Codex and Claude harnesses plus Git and
GitHub CLI. Its root supervisor owns persistent target state and isolated per-run identities; the
state root must remain traversable by those identities. Without the opt-in bootstrap key it retains
the direct target contract: no login, queue, scheduler, TLS, or tenant isolation is added by the
container.
The production target reserves its configured writer UID for serialized source resolution and
leases one fixed, disjoint UID block per active run. The lease covers its writer and every bounded
verifier identity and is released only after capsule process and workspace cleanup.
The CLI backend lifecycle alone adds `queued` for cloud-owned work before OECP admission, including
target startup. Local and direct backends mechanically project OECP phases and never synthesize
`queued`; it does not belong in OECP, the target server, the controller ledger, or retry policy.

`GraphSpec` remains the control-flow source of truth. Its companion runtime plan fixes the
graph-wide harness/provider and each node's model, effort, session scope, and declared environment
names at admission. Agent-backed leaves require bounded authored instructions; trusted Git delivery
rejects them. Built-in templates expand locally into ordinary exact graph, input, and runtime values;
OECP has no template semantics. The closed catalog is `single-worker` and `software-change`; only
the latter materializes the `none`/PR/merge delivery choice. One run owns one workspace: workers
and Git delivery are exclusive writers,
while ordinary verifiers are read-only and may overlap. PR and merge delivery are graph-visible
modes of one shared trusted implementation; hosted success requires its bounded inline receipt.
Local execution may omit delivery, in which case the invoking workspace and its mutations remain
user-owned and are never reset or removed. Omitting `--target` starts the private local controller
on demand and uses the ordinary OECP client surface; it survives client detach while active, exits
after terminal state is durable, and later local observation reopens that ledger without a runtime.

Each one-run controller uses the lean v2 ledger, with SQLite and a filesystem controller lease as
the local adapters. Runtime, controller, workspace, or reusable-session loss and force-stop are
terminal; there is no replay, resume, workspace replacement, or recovery engine. Native v2 has no
artifact store, CAS, staged artifact pipeline, or `ArtifactRef` delivery path, and the deleted
`ClusterLedger`, fixed-program execution, compatibility capsule, and Node fallback must not return.

`execution/process` is the contained streaming-session seam. Recovery is registered before spawn,
stdout and diagnostics remain bounded, and close/release owns termination and reaping exactly once.
Provider framing and response decoding remain in the Codex and Claude adapters.
Those adapters leave native repository config and MCP discovery enabled; v2 has no MCP schema or
proxy. The built-in local host alone inherits the current user's `HOME`/`CODEX_HOME` paths for CLI
subscription identity. Those paths and credentials never enter OECP; hosted homes stay private and
remote runs use declared provider keys.

Git delivery returns bounded, schema-declared inline output and must not persist a parallel delivery
result outside the lean run history.
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
`v2_run_ledger` is the one-run durable authority. It stores immutable run metadata, ordered run/node
events with stable cursors, current projections, normalized inline outputs, safe logs, force intent,
and one terminal result. Keep provider sessions, credentials, runtime handles, raw diagnostics,
artifacts, and workspace recovery outside it. It intentionally has no old-ledger hash chain,
mutation receipts, proof capabilities, replay, or recovery engine.
Full-v1 reduction accepts only verifier-produced `VerifiedGraph` values containing authoritative
`CompiledGraphIr` and durable ordered outcomes. It never accepts compiled IR directly.
It is a pure authored-order fold: ledger position is the only concurrent
tie-break, map indices and positive attempts are part of durable execution history, and early-join
loser voids are reducer decisions. Keep scheduling capacity, clocks, tasks,
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

Guided setup lives in `cli/lib/setup-wizard.js`. `defaultIsolation` is the sole saved isolation
default; persisted `defaultDocker` exists only as one-way migration input. Preflight, startup copy,
and execution must consume the same canonical effective run plan. Human live events must use the
footer-aware line/raw writer; JSON output bypasses that writer and remains ANSI-free.

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
zeroshot export <id>              # Export rendered conversation
zeroshot export <id> -f trace -o run.trace.jsonl # Export native research evidence
zeroshot export <id> -f semantic -o run.semantic.jsonl # Project provider-neutral events
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
Cluster preflight validates the selected registry entry's `settingsValidator` with the actual detached or Docker execution context before isolation side effects. Provider configuration that cannot run cluster workers must fail once at preflight, never after allocation or through repeated agent retries.
Detached provider tasks default to the `detached` execution boundary. Embedding runtimes that
already own process, filesystem, and network isolation must set
`ZEROSHOT_TASK_EXECUTION_CONTEXT=benchmark`; the task runner validates and propagates this
provider-neutral boundary so adapters do not attempt incompatible nested containment. Task
preflight and provider command preparation must share `src/task-execution-context.js`; availability
probes must receive the same validated boundary that command preparation will use.

OMP's supported version, package identity, and release asset digests are pinned once in `omp-release.ts`; the RPC codec and any registry/version-probing/Docker-build code import it. Never recopy the version string, asset names, or digests elsewhere.

OMP's `rpc-stdio` invoke lane uses one shared lifecycle driver, `runOmpRpcTask` (`omp-rpc-driver.ts`), for both foreground (`contract-invoke.ts`) and detached (`task-lib/rpc-watcher.js`) execution, so the two paths produce identical result semantics. Spawn evidence is persisted (via the caller's `onSpawn` hook) before the first stdin write, and is reported only once the child process is confirmed spawned (the Node `'spawn'` event) — never synthesized from a pre-spawn/undefined pid, which would let ownership-based termination signal an unrelated process. Output is normalized-events-only: raw RPC frames, prompt text, and control payloads are never logged, only `OutputEvent`s (`omp-rpc-events.ts`). The detached watcher's prompt never enters its argv (`ps` and `/proc/<pid>/cmdline` expose argv to every local user for the watcher's whole lifetime); `task-lib/runner.js` hands it over the private, length-prefixed stdin pipe in `src/watcher-prompt-channel.js`. Watchers are plain detached Node children with no IPC channel, so wrapper completion has exactly one lifetime owner. The watcher fails closed — no OMP spawn, ownership-aware cleanup still runs — when the prompt channel is absent, truncated, over the pinned 1 MiB frame contract, or closed before a complete payload. The per-task OMP config overlay (`omp-config-overlay.ts`) and its cleanup are ownership-checked by the shared `src/command-cleanup-ownership.js` owner used by both cleanup call sites; a failed or unsafe cleanup leaves the task's cleanup receipt intact (durably retryable) instead of silently discarding it. Provider `dockerIsolation`/`worktreeIsolation` capabilities are gated in `orchestrator.js` and `preflight.js` before any container/worktree is created, not after.

OMP session persistence (issue #866): fresh runs pass `--session-dir <partition>`; verified resume
adds `--resume <partition>/<file>` as the exact absolute path Zeroshot already verified, never a
bare `--resume`/`--continue` or an ID search; `--no-session` is reserved for the sessionless
Docker lane, which stays fresh-only. Each session lives in its own random, secret-free UUID
partition under `<storageRoot>/omp-sessions/<uuid>/` (`task-lib/omp-storage-root.ts` resolves
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
`PI_CODING_AGENT_DIR` / profile / XDG semantics — mirrored in `src/omp-blob-root.ts`. Verification
parses the JSONL, collects canonical nested refs, and checks the referenced blobs _there_; a
missing, non-canonical, or digest-mismatched reference is an invalid continuation. A blob may
legitimately carry more than one hard link (`blob-store.ts` hardlinks a typed `<hash>.<ext>`
sidecar), so blobs are content-verified rather than link-count-verified. **No cleanup surface ever
writes to or deletes anything under that root**, and `deleteOmpSessionPartition` refuses outright
any path that resolves inside it.

`src/omp-session-verifier.js` implements the two-phase lazy-file contract against the fixed
`OMP_SESSION_LIMITS` (`src/omp-session-limits.ts`, with generated CommonJS at the matching `.js` path): existing (resume) partitions are fully verified
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
manifest digest, and an `executionFingerprint` (`src/omp-execution-fingerprint.ts`, with generated CommonJS at the matching `.js` path) binding the
pinned OMP release, the config-overlay content digest, the requested `--model`/`--thinking`/
`--approval-mode` selectors, and the concrete provider/model/thinking level OMP reported. OMP
catalog aliases such as `openrouter/~anthropic/claude-sonnet-latest` are valid exact selectors;
the `~` prefix is accepted only at the start of the model portion. That
fingerprint has exactly one implementation, `src/omp-execution-fingerprint.ts`; do not add a second
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

Pi is a normal `spawn`-lane JSON provider, not a second RPC/SDK vertical. Pin its official
`@earendil-works/pi-coding-agent` release once in `src/agent-cli-provider/pi/release.ts`, and keep
the Docker installation synchronized by tests. Pi owns its dynamic
provider/model/subscription registry; Zeroshot passes opaque `provider/model` selectors and must
not add a parallel catalog. Keep user-global extensions enabled for custom providers, but pass
`--no-approve`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files` so project-local
Pi resources do not duplicate or mutate Zeroshot's task contract. JSON `turn_end` is per model
turn; emit the one normalized result only on `agent_settled` from the latest assistant message,
and treat in-band `error`/`aborted` stops as failures even when the process exits zero. Pi stays
`--no-session`: neither search-based `--session` nor create-if-missing `--session-id` is a
task-owned continuation capability. Docker installs the same pinned release and mounts the active
Pi config root writable at `~/.pi/agent` in the container; do not replace that with per-cluster
copies, because Pi's shared credential lock and persisted OAuth rotation must span concurrent and
later clusters. `PI_CODING_AGENT_DIR` may select the host source without leaking that host path into
the container. Forward scalar built-in credentials/config companions automatically, and require
explicit passthrough plus a matching mount for path/metadata credentials.

Model gateways stay behind the single bundled `gateway` engine. Do not add `openrouter`, `ollama`, `vllm`, `hermes`, or similar model-only targets as standalone provider ids.

Exactly one registry entry must set `default: true`; `getDefaultProviderId()` (`src/agent-cli-provider/provider-registry.ts`, re-exported from `lib/provider-names.js`) is the sole default-provider authority — settings, agent resolution, CLI, and setup code fall back to it, never a hardcoded provider literal. Historical-output parsers and legacy provider-less persisted watcher/task records keep their existing Claude-literal compatibility path and are never reinterpreted via the marker.

ACP-native engines use one shared stdio adapter lane. New ACP engines must be added with registry metadata plus helper fixtures only; do not add engine-specific ACP parsers or invoke runners.
ACP fixtures must use protocol-shaped chunk payloads: `agent_message_chunk.content` is a single `ContentBlock` object, and thought deltas are covered with `agent_thought_chunk` fixtures so parser tests catch spec drift.

## Architecture

Pub/sub message bus + SQLite ledger. Agents subscribe to topics, execute on trigger match, publish results.

```
Agent A -> publish() -> SQLite Ledger -> LogicEngine -> trigger match -> Agent B executes
```

Template simulations preserve their CommonJS require paths while `build:legacy-runtime` emits
matching JavaScript from strict TypeScript. `simulation-runtime.ts` alone constructs the production
ledger, message bus, and logic engine; `simulation-agent.ts` plus `simulation-agent-runtime.ts` is
the shared agent/hook facade. Random topology processing stays staged: scenario lifecycle flows
through the message loop, operations mutate guarded state, dispatch selects triggers, and trigger
evaluation/execution publishes the next message. Keep those boundaries and their runtime guards
when adding dynamic simulation actions.

### Core Primitives

| Primitive    | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| Topic        | Named message channel (`ISSUE_OPENED`, `VALIDATION_RESULT`) |
| Trigger      | Condition to wake agent (`{ topic, action, logic }`)        |
| Logic Script | JS predicate for complex conditions                         |
| Hook         | Post-task action (publish message, execute command)         |

Restart persistence: orchestrator publishes `AGENT_RESTART_ATTEMPT` to the ledger so restart limits survive orchestrator restarts.

Detached Docker startup records its closed, deterministic container/workspace/config ownership in
the provisional cluster before setup begins. Setup-cluster kill reaps the daemon first, verifies
that receipt against the cluster ID, then removes only the derived container name and direct-child
temporary directories. Never persist or honor caller-selected cleanup paths for this boundary.

Provider task ownership: task watchers persist an owned termination boundary with each active task.
Codex JSONL is streamed losslessly into the task log instead of buffering an unbounded physical
record in the watcher. Provider-session inspection is fixed-bound, and agent log framing replaces
any record over 1 MiB with a byte-count/SHA-256 receipt before broadcast; the local lane also stores
only that receipt in agent output while the complete record remains in the task log. Local and
isolated followers retain a bounded complete-record tail for parsing and diagnostics, stop live
`AGENT_OUTPUT` publication at cumulative byte/record limits, and publish that bounded tail once at
terminal settlement. Isolated settlement re-reads only a fixed-size file tail; the raw task log is
the sole complete-output authority. Never restore whole-record watcher buffering, cumulative output
strings, whole-log terminal reads, or unbounded provider records/events in control-plane state.
Normal host/detached Codex tasks stay in `workspace-write`. When `cwd` is a linked Git worktree,
task preparation may set `additionalWritableDirectories` to the one resolved external Git common
directory and the adapter maps it to deduplicated `--add-dir` arguments only when Codex advertises
that flag. Host/detached runs enable Codex's explicit workspace-write network capability so normal
API, dependency, and Git journeys work without widening filesystem access. GitHub delivery rewrites
GitHub SSH remotes to HTTPS for the push command and delegates credentials to `gh auth
git-credential`; never embed a token in the prompt or remote. Hosted capsules declare the `docker`
execution context and benchmark containers declare
`benchmark`; both use `danger-full-access` because the container is the security boundary, and they
must not receive redundant host Git-directory grants. Do not enable `danger-full-access` for host or
detached execution, do not add unrelated cache or socket paths, and never carry either permission
into read-only structured-output recovery.
Successful `--pr`/`--ship` auto-cleanup may close and remove the live cluster before a foreground
caller emits its result. The orchestrator must retain a bounded in-process final-run handoff
(settled status, ledger snapshot, and terminal messages) until `close()`; foreground reporting must
consume that handoff rather than reopening or querying the closed ledger.
Claude gateway authentication may use `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL` and an
explicitly empty `ANTHROPIC_API_KEY`; keep the token, endpoint, and Claude role-model selectors in
the provider's declared isolation passthrough rather than persisting gateway secrets in settings.
When both gateway token and endpoint are explicit, the Zeroshot-owned per-run `--settings` safety
overlay must set the Bedrock, Vertex, and Foundry backend selectors to `0`; this overrides stale
ambient user backend choices while preserving the user's other settings and repository context.
Provider terminal failures are parsed from the newest typed terminal event before generic status
text. Raw provider diagnostics remain task-log-only; `AGENT_OUTPUT`, `failureInfo`, `AGENT_ERROR`,
and `CLUSTER_FAILED` retain only a synthesized error plus provider/event/category/retryability and
byte-length/SHA-256 receipt. Final critical-agent exhaustion installs `failureInfo` before emitting
exactly one durable `CLUSTER_FAILED`; the legacy `AGENT_ERROR` stop fallback must not initiate a
second stop after that terminal topic exists in the current run, while prior-run failures must not
suppress terminalization after resume.
Every named non-validator role is cluster-critical after final task retry exhaustion, including
planning, conductor, custom, and orchestrator roles; validators alone use their rejection path.
Keep that rule centralized in `src/agent/critical-agent-policy.ts` (generated CommonJS at the matching `.js` path). Terminal `AGENT_ERROR` records
set `retryBudgetExhausted: true`; never infer task exhaustion from `attempts`, because status-poll
observations use the same counter while the lifecycle still owns a retry.
The SQLite ledger additionally keeps one cluster-wide newest tail of non-replayable
`AGENT_OUTPUT` (8 MiB / 8192 exported messages) and a persisted deterministic omission receipt;
live delivery is unchanged, while control and explicitly replayable messages are never compacted.
Writable opens reconcile pre-budget or stale compaction state one cluster per transaction. JSON
export verifies actual compactable row counts/bytes and streams rows in the same readonly snapshot;
legacy writers therefore cannot race a verified export, and inconsistent snapshots receive only
bounded repair attempts. A persisted high-water allocator assigns explicit message rowids, so
deleting compacted output can never reuse a sequence already returned to a caller; later readonly
exports and cursors remain bounded and monotonic. JSON export must iterate ledger rows directly to
its destination instead of materializing the whole ledger or pretty-printed document in memory.
The `zeroshot.trace.v1` JSONL export is the provider-neutral native evidence boundary for research.
It streams the ordered ledger, exact selected task prompts, and fixed-size base64 chunks of exact
task-log bytes into one deterministic source bundle. Task IDs must come from causal ledger fields,
limited to `AGENT_OUTPUT` and explicit task lifecycle records, never arbitrary topics or log-directory
timestamps; host and isolated `AGENT_OUTPUT` records both carry that task ID. References inside the
bundle are logical `zeroshot-trace://` identifiers only, never host paths. File destinations are
create-only and never follow or replace an existing path. Missing or changing task evidence is an
explicit sorted issue and makes the footer incomplete. A nonterminal task may be captured as a
snapshot, but its output and bundle must remain incomplete.
The separate `zeroshot.semantic.v1` JSONL export may project those same task logs only through the
registered provider's existing stateful adapter lifecycle. It preserves the provider-neutral
`OutputEvent` union, references native prompt/output identities and the raw-output digest, and keeps
source completeness distinct from semantic completeness. Structurally identified Zeroshot wrapper
footers and stderr records remain in native evidence but never enter a provider stdout parser.
New watcher logs start with the exact `channel-framed-v2` format marker and frame provider stdout
and stderr explicitly; `src/task-log-line.js` is the sole framing encoder/decoder for regular and
OMP SDK writers and every consumer. OMP SDK errors become one failed terminal `result` event, and
its diagnostics use the stderr frame. Consumers unwrap only the outer stdout frame. Legacy v1
evidence remains readable without heuristic channel classification.
Parser diagnostics never affect execution, scoring, or `zeroshot.trace.v1`. ATIF and viewer-specific
projection still belongs downstream.
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
the provider session. Persist continuation in that agent's `agentStates` entry, never in the
native-v2 run ledger, never select a cwd-wide "latest" session, and never share across agents. Durable
restore fails closed unless the last lifecycle boundary is the exact matching `TASK_COMPLETED`;
live, failed, retry/backoff, provider-switch, unsupported, Docker, and workspace-drift states start
fresh.

### Guidance Messaging

- Topics: `USER_GUIDANCE_CLUSTER`, `USER_GUIDANCE_AGENT` (see `src/guidance-topics.ts`; runtime CommonJS is generated at the matching `.js` path).
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

| Complexity | Description            | Validators           |
| ---------- | ---------------------- | -------------------- |
| TRIVIAL    | 1 file, mechanical     | 0                    |
| SIMPLE     | 1 concern              | 1                    |
| STANDARD   | Multi-file             | 2, inline            |
| CRITICAL   | Auth/payments/security | 4, across two stages |

Counts come from `getValidatorCount()` in `src/config-router.ts`. CRITICAL returns
`validator_count: 0`, which skips the inline validators and activates the `meta-coordinator`:
`quick-validation` then `heavy-validation`, 2 each.

`UNCERTAIN` exists only in the junior conductor's schema and means escalate, not a workload.

| TaskType | Action                |
| -------- | --------------------- |
| INQUIRY  | Read-only exploration |
| TASK     | Implement new feature |
| DEBUG    | Fix broken code       |

Base templates: `single-worker`, `worker-validator`, `debug-workflow`, `full-workflow`, plus
`quick-validation` and `heavy-validation` for the CRITICAL two-stage pipeline.
An exact whole-value `{{param}}` placeholder preserves the parameter's JSON type; placeholders
embedded in surrounding text stringify their values. Keep numeric workflow controls typed through
dynamic template loading.

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
`ZEROSHOT_HOME` is immutable inside a Mocha worker because `task-lib/config.ts` caches the task-store
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
- Main requires the stable aggregate `required` check. Node and Rust paths run independent CI lanes;
  shared or unknown paths run both.
- Node semantic-release runs only after an applicable exact merged `main` commit passes CI.
  Conventional squash titles select patch/minor/major, and Rust-only history is excluded.
- Zeroshot Rust releases only by explicit `release-rust.yml` dispatch with a version and exact
  `main` commit. Its canonical outputs are GitHub archives/checksums and the Linux AMD64 GHCR image;
  the npm downloader shim is optional and separately published.
- Checked-in versions are deliberately non-authoritative and are staged only in release workspaces.
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
