# Brief: topology generation, isolated first

You are extending zeroshot so it **designs** the verification topology for a task instead of
selecting one of six hand-written templates. The scaffolding exists and works. Your job is to make
the designs good, prove they are good in isolation, and only then wire the whole thing end to end.

Work on branch `eivind/topology-generator`. Do not merge to main.

## What already exists

| Thing                                                | Path                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| The seed config (one conductor, `topology-designer`) | `cluster-templates/topology-generator.json`                         |
| Its builder — edit this, never the JSON              | `scripts/build-topology-generator.js`                               |
| Admission check on a design, token-free              | `scripts/check-generated-topology.js <design.json>`                 |
| Real-provider sampler                                | `scripts/sample-topology-designs.js "<task>" --samples N --out DIR` |
| Token-free end-to-end proof                          | `tests/e2e/topology-generator.test.js`                              |

The designer emits a compact spec (`{reasoning, agents:[{id, role, modelLevel, stage, purpose,
systemPrompt}]}`). The transform in the builder expands it into a wired topology and owns everything
structural: topic wiring, stage gates, the rejection feedback path, verifier context independence,
`modelLevel` enforcement, and the terminator. **The model chooses what to check. The transform
decides what it is allowed to read and how it is wired.** Keep that split. If you find yourself
asking the model to emit wiring, you have taken a wrong turn.

Admission is `configValidator.validateConfig` over the merged agent set, exactly as
`orchestrator._validateProposedConfig` runs it. `check-generated-topology.js` reproduces it faithfully
by running the real transform through the real hook executor — trust it.

---

# PHASE 1 — topology generation in isolation

Do not run a full cluster in this phase. No `zeroshot run`. Everything here is the sampler plus the
admission checker, and your own reading of the prompts that come out.

## Goal 1: admissible, and self-repairing when it isn't

**Target: ≥8 of 10 fresh designs admissible with no repair, and every remaining failure repaired
within the designer's 3 retries.**

The repair channel already works mechanically: admission failure publishes
`CLUSTER_OPERATIONS_VALIDATION_FAILED`, the designer triggers on it and re-runs with the last 3
failures in context. It is **semantically broken today** and fixing that is your first task.

Observed failure, reproduce it before you change anything: the designer wrote
`"do NOT use git diff or git status — read files directly"` into a validator prompt. Admission
rejected it because `validateValidatorGitUsage` (`src/config-validator.js:837`) substring-scans for
those literals and cannot tell a prohibition from a usage. The error says `uses 'git diff'`, so the
model's natural repair is to remove a git call it never made. It failed the same way twice and the
cluster stopped with zero agents spawned.

Fix the checker, not the prompt. A validator prompt that forbids git is _good_ and must pass; one
that instructs git usage must still fail. Add unit tests for both directions. Then look for the same
class of problem elsewhere — any check whose error message does not tell the model what to change is
a repair loop that cannot converge.

Verify: `node scripts/sample-topology-designs.js "<task>" --samples 10` on each shape below, read the
cold-pass rate. Save every design to disk so you can re-judge without paying again (~$0.50 per
design).

## Goal 2: the verification fits the task

Sample designs across **three shapes**, minimum four tasks each:

- **Coding** — e.g. "add a `--json` flag to `zeroshot list`"; "fix the ISO-8601 parse bug in the
  ledger timestamps".
- **Architecture / design** — e.g. "propose how to shard the ledger across clusters"; "decide whether
  the graph verifier should own admission". Note these produce a _document and a decision_, not code.
- **Not code at all** — e.g. "find 20 Series-A fintech CTOs in the Nordics and produce a contact
  list"; "sweep the inbox for every thread mentioning pricing and summarise what was promised";
  "rewrite this landing-page section so it matches the house style".

For each design, read the actual `systemPrompt` of every verifier and judge it. This is deliberate
human-style judgement, not a metric — you are checking whether the topology understands what would
make _this specific output_ wrong.

**Fit means the oracle is real.** Every verifier must check the artifact against something outside
the executor's own reasoning: the test suite, the source file, a registry, the live page, the actual
inbox. A verifier whose only evidence is its own opinion is not a verifier. Reject designs that
verify prose by running tests, or verify a prospect list by "reviewing it for quality".

**Adversarial, not hostile.** Calibrate:

| Too soft                        | Right                                                | Too harsh                                 |
| ------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| "review the output for quality" | names exactly what it checks and what it ignores     | rejects on wording preferences            |
| approves with no evidence       | demands the command run or the file:line read        | demands evidence that cannot be obtained  |
| no instant-reject list          | rejects placeholders, deferrals, unverifiable claims | blocks on things the task never asked for |
| one vague catch-all verifier    | each verifier owns one failure mode                  | eight verifiers where three would do      |

A verifier that can never approve is as useless as one that always does. If a design's verifiers
would reject correct work, that is a defect — write it down and fix the designer prompt.

**Also check the shape, not just the prompts:** does staging make sense (cheap high-signal checks
first, expensive judgement second)? Are model levels sane (mechanical → level1, judgement → level3)?
Does verifier count track actual risk rather than being 4 every time?

## Goal 3: iterate

Loop: sample → check admissibility → read the prompts → find the weakest design → change the
designer prompt or the transform in `scripts/build-topology-generator.js` → rebuild → resample.

Keep a short log of each iteration: what you changed, and what it fixed. Prompt changes have
side effects on shapes you are not looking at, so re-sample all three shapes before declaring an
improvement.

## Phase 1 exit criteria

All of these, evidenced:

1. ≥8/10 cold-pass admissibility per shape, and no failure class that the 3-retry repair loop cannot
   resolve.
2. Every sampled design across all three shapes has verifiers whose oracles are real and external.
3. No design contains a verifier that would reject correct work, and none that would approve work
   with a planted obvious defect. Argue both from the prompt text.
4. Topology shape varies meaningfully with the task. If every design is 4 verifiers in 2 stages, the
   designer is pattern-matching and Phase 1 is not done.
5. `npm run validate:templates` and the unit suite pass. Two failures in
   `tests/unit/pre-commit-no-stash.test.js` are pre-existing on clean `origin/main` — confirm, then
   ignore.

**Stop here and report before starting Phase 2.**

---

# PHASE 2 — end to end

Only once Phase 1 is signed off.

Run real clusters against generated topologies: `zeroshot run <spec> --config
./cluster-templates/topology-generator.json --worktree`, on at least one task from each shape.

Known environment traps — hit all of these already, do not rediscover them:

- **Version skew.** Agents self-spawn via `which zeroshot`. A global install older than this checkout
  (homebrew `6.4.0` vs `0.0.0-development`) never writes the ownership receipt the newer parent
  waits for, and every agent task fails three times with `Detached task ownership receipt was not
persisted`, naming nothing useful. Work around it with a PATH shim; then make preflight detect the
  skew and abort with both versions named.
- **Inline text ending in `.md`** is resolved as a file path. Pass a spec file.
- **`add_agents` never triggers `_injectCompletionAgent`** (`src/orchestrator.js:4041`, load_config
  path only). The transform ships its own terminator. Do not remove it.
- **The conductor watchdog** crashes a cluster that finishes inside its 30s window; fixed on this
  branch at `src/orchestrator.js:1668`, still broken on main.

Phase 2 is done when a generated topology reaches `CLUSTER_COMPLETE` on all three shapes, with
`VALIDATION_RESULT` in the ledger sent by a generated agent id, and the work it approved survives
your own inspection.

---

# Out of scope

Do not modify `src/config-router.js`. Do not change the six base templates. Do not make the generator
the default config. Do not weaken a check in `src/config-validator.js` to make a design pass — if a
check is wrong, fix its logic and add tests proving both directions; if the design is wrong, fix the
designer.

The last one matters most. You are building a system that designs its own examiner. Every time you
are tempted to loosen the examiner so the design passes, you are doing the exact thing this whole
feature exists to prevent.
