# M1 — Certified embeddable backend: launch order

**Target chosen 2026-07-29.** Milestone `M1 — Certified embeddable backend` (11 issues). Closing **#693** yields a conformance-certified full-v1 `NativeBackend` embeddable in-process — no daemon, no CLI, no forge adapters, no logs/attach, no export.

## The launch rule

Launch an issue only when **both** hold:

1. It carries the `M1 — Certified embeddable backend` milestone, **and**
2. Its `## Blocked by` section is empty.

Being unblocked is **not** sufficient. Decision 4 lifted the one-cluster-at-a-time rule for disjoint work, which leaves six issues startable but off-target: **#677, #692, #755, #758, #761, #767**. They are real work and stay open — they are simply not M1. Launching them now spends the budget that M1 needs and lands merge conflicts into crates M1 is actively changing.

This rule is duplicated in #665's Status section so AFK agents see it without reading this file.

## Wave structure

M1 is **8 waves deep**. Concurrency helps in waves 1 and 2 only; waves 3–8 are a strict serial chain. Plan on **8 sequential landings minimum**, not 11 parallel ones.

| Wave | Issues                       | Concurrency | Notes                                                        |
| ---- | ---------------------------- | ----------- | ------------------------------------------------------------ |
| 1    | **#670**, **#671**, **#695** | 3×          | The only genuinely wide wave. All three are startable today. |
| 2    | **#754**, **#768**           | 2×          | #754 needs #671; #768 needs #670.                            |
| 3    | **#769**                     | —           | Needs #768. Longest chain in the graph.                      |
| 4    | **#697**                     | —           | Needs #769.                                                  |
| 5    | **#698**                     | —           | Needs #697.                                                  |
| 6    | **#678**                     | —           | Needs #698.                                                  |
| 7    | **#774**                     | —           | Needs #678 + #697 + #698.                                    |
| 8    | **#693**                     | —           | Needs #695 + #774. Closes M1.                                |

### Wave 1 — launch all three now

- **#670 — versioned worker-provider catalog.** Highest fan-out in the whole backlog: transitively unblocks 33 of 52 open issues. Start it first if you only start one.
- **#671 — full-v1 graph reducer.** Densest remaining logic; unblocks 22. Must **consume** the existing 5,976-LOC `graph_verifier` subtree in `openengine-cluster-server`, not duplicate it — state that in the issue before launching.
- **#695 — external backend conformance factory.** Cross-epic gate: closes #643 _and_ is the only mechanism that will ever certify the Rust engine. Lives in the protocol crate, so it will not conflict with #670/#671.

These three touch disjoint crates and modules, so worktree isolation is sufficient and review load stays manageable.

## Known hazards inside M1

**#754 forces a schema migration inside closed #668.** `DispatchState { run, node_instance, execution }` cannot reconstruct a 15-field `ExecutionCommand`. The SQLite schema is versioned and fail-closed on unknown versions, so this is a real migration inside an issue previously marked authoritative. Budget for it; do not let it be discovered mid-implementation.

**#754 must implement `ObservationStore`.** Today the only implementations are test fixtures (`testkit/src/watch.rs:209`, `server/src/watch/fixtures.rs:189`), which is why `ClusterLedgerAdapters` cannot back the protocol coordinator as a `ClusterBackend`.

**#754 must replace 8 permanent-error adapter methods.** In `zeroshot-rust/src/cluster_ledger/adapters.rs`: `acquire_dispatch`/`retry_lifecycle` always return `DispatchDenied`, `complete_dispatch`/`fail_dispatch` always `UnknownLease`, and `resubmit`/`delete`/`update_lifecycle`/`stop_lifecycle` always `InvalidPhase`.

**#697 turns `backend_boundary.rs` red — on purpose.** `zeroshot-rust/tests/backend_boundary.rs:52-114` currently asserts `graphProfiles: []` and `INVALID_PHASE` for plan/apply/update/stop. The engine's only protocol-surface tests encode the stub's emptiness as the contract. Rewrite that file as an explicit deliverable of #697; do not let a later wave discover it as a surprise red build.

**#693 collides with three architecture guards.** `zeroshot-rust/tests/architecture.rs` prohibits `openengine-cluster-testkit` as a dependency _without filtering on dependency kind_, so even a dev-dependency fails; it also bans the strings `trait BackendFactory` and `conformance_runner` from the product root, and asserts exactly one lib + one bin. Decide **before** wave 8 whether #693 certifies in-tree (amend all three assertions) or out-of-tree (a separate certification crate). `zeroshot-rust/Cargo.toml` has an empty `[dev-dependencies]` block today.

**#695 is a refactor of 122 currently-green assertions** out of test binaries into exported library code, while the issue demands "zero shared vector/runner semantic diffs". That is precisely where coverage silently weakens. Require a mechanical vector-name and count diff, checked in CI, before and after.

## What M1 explicitly does not deliver

No CLI (`src/main.rs` stays `fn main() {}`), no daemon, no workspaces, no worker drivers, no forge adapters, no credentials, no logs/attach, no export, no distribution. A certified backend is embeddable and provable — it is not yet a product. The usable-CLI milestone is a further 6 issues (#672, #675, #676, #677, #755, #770) on top of M1.

## Throughput reality

The six code-bearing #665 issues all landed 2026-07-16 → 07-18, a peak of roughly 1.5 issues/day, and no native product code has landed since. At that peak, 8 serial waves is a multi-week programme even with wave-1 concurrency. Schedule from waves, not from issue count.
