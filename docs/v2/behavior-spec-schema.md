# Dual-binary behaviour-spec suite: scenario schema

## Why this exists

The Node test suite cannot serve as the V2 regression net. Of 214 test files, 159 `require()` a `src`/`lib`/`cli` module directly and assert on JS objects and injected fakes; only `tests/e2e` (10 files, 23 cases) drives the real binary. Epic #665 additionally forbids the Rust product from importing the Node engine, reading Node state, or accepting Node config, and `zeroshot-rust/tests/architecture.rs` mechanically bans the token `node` from the product root — so a shared in-process harness is impossible by construction.

What _can_ be shared is a **language-neutral description of observable behaviour**, executed against both binaries by one harness. It is green on Node from day one and red on Rust until each row lands — a **specification**, not a certification.

This suite is the CLI-level net. It is not the primary correctness net: that is #695's protocol conformance vectors, because the Rust engine's correctness lives at the JSON-RPC surface. The two are complementary and neither replaces the other.

## Design constraints

1. **No shared code between the binaries.** The scenario file is data. The harness is the only executable, and it treats each binary as a black box.
2. **Divergence must be expressible, not hidden.** Epic #665 classifies capabilities as `implemented` / `replaced` / `excluded`. A `replaced` capability has _different_ correct output per binary. The schema must say so explicitly rather than forcing a lowest common denominator.
3. **State roots must be injectable.** Node derives its state path from `os.homedir()`; zeroshot-rust uses OS-native dirs under `ZEROSHOT_RUST_*`. The harness owns an ephemeral `HOME` per scenario, and the schema never hardcodes a path.
4. **No network, no API credits.** Every scenario runs against a fake provider CLI and a local fixture git repo. A scenario that would spawn a real agent is invalid.
5. **Assertions are predicates, not golden blobs.** Stdout contains timestamps, cluster ids, and durations. Matching whole output would make the suite brittle across both binaries.

## Scenario schema

```jsonc
{
  "id": "run.worktree.creates-isolated-branch", // stable, dotted, never renamed
  "title": "run --worktree leaves the main working tree clean",
  "parityRow": "isolation.worktree", // FK into the parity matrix
  "class": "implemented", // implemented | replaced | excluded
  "appliesTo": ["node", "rust"], // omit a binary it must never run against

  "fixture": {
    "repo": "fixtures/single-file-repo", // copied to a temp dir per scenario
    "provider": "fake-cli", // fake provider executable on PATH
    "files": { "TASK.md": "add a greeting function" },
  },

  "env": { "ZEROSHOT_FAKE_PROVIDER_SCRIPT": "greet.json" }, // HOME/state root injected by harness

  "argv": ["run", "TASK.md", "--worktree"], // binary name supplied by the harness

  "expect": {
    "exitCode": 0,
    "stdout": [{ "contains": "cluster" }, { "matches": "^[0-9a-f]{8}$", "capture": "clusterId" }],
    "stderr": [{ "empty": true }],
    "files": [
      { "path": "greeting.js", "exists": true, "in": "worktree" },
      { "path": "greeting.js", "exists": false, "in": "repo" },
    ],
    "git": [
      { "in": "repo", "statusClean": true },
      { "in": "worktree", "branchMatches": "^zeroshot/" },
    ],
  },

  "overrides": {
    // per-binary divergence, class=replaced only
    "rust": {
      "reason": "#665 mandates canonical JSON export; Node defaults to an HTML transcript",
      "expect": { "stdout": [{ "isJson": true }] },
    },
  },

  "timeoutMs": 120000,
  "tags": ["isolation", "smoke"],
}
```

### Field rules

| Field                  | Rule                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | Stable and never renamed — it is the join key to the parity matrix and to CI history. Renaming loses the trend.                                                                           |
| `parityRow`            | Must resolve to a row in the parity matrix. A scenario with no parity row is unreviewable; a `cliObservable` parity row with no scenario is an untested claim. CI checks both directions. |
| `class`                | Mirrors the parity matrix. `excluded` scenarios assert the capability is **absent** (e.g. non-zero exit and a clear error), which is how intentional drops stay intentional.              |
| `appliesTo`            | `absent-in-node` capabilities list only `rust`. These have no Node baseline and must be specified from scratch.                                                                           |
| `overrides`            | Legal only when `class` is `replaced`, and `reason` is mandatory. This is the sole place divergence may live, so divergence is greppable.                                                 |
| `expect.stdout`        | Predicates only: `contains`, `matches`, `isJson`, `notContains`. No whole-output goldens.                                                                                                 |
| `expect.files` / `git` | `in` is a symbolic root (`repo`, `worktree`, `stateRoot`) the harness resolves per binary. Never an absolute path.                                                                        |

## Harness contract

```
harness --binary <node|rust> --scenarios spec/**/*.json [--filter tag] [--update-baseline]
```

Per scenario the harness: creates a temp dir; copies the fixture repo and `git init`s it; creates an ephemeral `HOME` and state root; puts the fake provider on `PATH`; resolves the binary (`node cli/index.js` or the `zeroshot-rust` binary); runs argv with a timeout; evaluates predicates; tears down. It reports per-scenario pass/fail/skip and exits non-zero on any unexpected failure.

**Rust failures are expected and must not break CI while M1 is in flight.** The harness therefore emits three states — `pass`, `fail`, `not-yet-implemented` — and the Rust lane gates only on `fail` (a regression against something previously passing), not on `not-yet-implemented`. A ratchet file records the highest count of Rust-passing scenarios ever achieved; the lane fails if that count decreases. That makes the suite a spec that tightens monotonically instead of a wall of red everyone learns to ignore.

## Seeding

Port the 23 existing `tests/e2e` cases first — they already drive `cli/index.js` as a subprocess against a fake provider and assert on stdout, exit codes, worktree files, and git cleanliness, so they translate almost directly. Then add one scenario per `cliObservable: true` parity row.

Do **not** port harness code from `tests/e2e/helpers/e2e-harness.js`. Port the _scenarios_. The existing harness derives state from `os.homedir()` and is Node-specific by construction.

## What this suite deliberately does not cover

Engine internals, ledger records, replay determinism, dispatch fencing, and fault taxonomy — all invisible from the CLI. Those belong to #695's conformance vectors and to the Rust unit and contract tests. If a behaviour can only be checked by inspecting the ledger, it does not belong here.
