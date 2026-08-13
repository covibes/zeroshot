# Phase 1 report: purpose-agnostic topology generation

## Outcome

Phase 1 now supports the strong version of “general purpose”: the topology is derived from how a
task can be completed and proven, not from whether its nouns look like code, medicine, finance, or
writing.

The final frozen holdout passed 12/12 real-provider cold admission and 12/12 semantic review. The
real transform, merged-config admission, structured input transport, user-deliverable transport,
success/repair/evidence-gap routing, and cluster termination paths are also exercised end to end
with a token-free fake provider.

This is strong evidence for purpose-agnostic topology _design and orchestration_. It is not a
mathematical proof over every possible prompt, and it is not yet a claim that real generated workers
have completed every task shape. Paid real-worker execution is Phase 2 and was intentionally not
started because the brief requires sign-off here.

## What “any task” means here

The proof matrix contains 72 tasks. Its final 48 cases cross eight mechanics that change the actual
workflow: completion kind, authority, observability, input carrier, side effects, time semantics,
cardinality, and valid outcome. The mechanical audit reports:

```text
72 matrix tasks
48 task-mechanics cases cover all 51 declared values across 8 dimensions
43/48 eight-dimensional task-mechanics vectors are unique
all frozen cohort declarations match their committed task counts
```

The final untouched cohort deliberately spans incompatible workflow shapes:

| Case                | Completion/proof shape                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Medication schedule | answer-native safety calculation; recompute every dose; prohibit clinical invention/action                 |
| Allergen recipe     | closed-guide transformation; source fidelity; physical/medical claims remain bounded                       |
| Microfiction        | creative artifact; exact form plus brief-grounded judgement; global originality may evidence-gap           |
| Grant eligibility   | complete-population decision; missing evidence stays pending; prohibited actions need audit records        |
| Concurrent cache    | executable artifact; controlled concurrency and failure-recovery observations                              |
| Accessible SVG map  | visual/editable artifact; geometry, coverage, and non-color accessibility without mandating representation |
| Invoice payment     | irreversible financial transition; preconditions, one attributable submission, terminal receipt            |
| Scheduled email     | future external state; request-relative date/DST; exact recipients; no send-as-test                        |
| Water sensor window | continuous observation; full request-time interval; no inference between unsupported point samples         |
| Prior-art search    | open-world research; verify positive citations and coverage while refusing a global negative               |
| Physical odor       | impossible physical observation; useful honest result plus explicit terminal non-success                   |
| Survey summary      | aggregate answer; exhaustive recomputation; privacy surface without invented row lineage                   |

This matters more than adding more industries. Each row requires a different success condition,
oracle boundary, and failure route.

## Evidence, including failures

| Iteration |                  Cohort | Admission | Semantic | Result                                                                         |
| --------- | ----------------------: | --------: | -------: | ------------------------------------------------------------------------------ |
| 09        |             calibration |     12/12 |     3/12 | failed; found heuristic, evidence, data-transport, and shape collapse problems |
| 13        | first untouched holdout |     12/12 |     4/12 | claim failed; cohort kept frozen                                               |
| 16        |           final holdout |     18/18 |    13/18 | claim failed; exposed five oracle errors and retry/evidence-gap conflation     |
| 17        |        post-fix holdout |     18/18 |     9/18 | claim failed; exposed missing answer-native deliverable transport              |
| 18        |     final proof holdout |     12/12 |    12/12 | passed without tuning or resampling                                            |

The lower iteration-17 score is important evidence, not regression laundering. Broader task
mechanics exposed that a design could be semantically excellent while the runtime discarded the
actual translation, calculation, report, or receipt. The fix was a general result channel, followed
by a new frozen cohort.

## General fixes made in core Zeroshot

1. Validator git policy now distinguishes explicit prohibitions from instructions to run git, with
   actionable errors and tests in both directions.
2. Triggering context exposes message ID, timestamp, metadata, and structured `content.data`, so
   attachments, connector handles, and request-time provenance survive dynamic generation.
3. The topology transform republishes the full original task payload and preserves original
   message/time identity.
4. Generated workers return both `completed` and the actual `userDeliverable`. Answer-native work is
   now first-class instead of being accidentally discarded.
5. Worker `completed:false` terminates as explicit non-success and preserves the useful blocker;
   validators never convert candor into completion.
6. Validator outcomes form a three-way algebra: approved, retryable defect, or terminal evidence
   gap. Missing independent authority no longer causes futile worker retries.
7. The generated graph supplies its own completion detector because dynamic `add_agents` does not
   receive the static-template completion injection.
8. The conductor watchdog tolerates a ledger already closed by a fast successful cluster instead of
   crashing that completed run.

The designer remains semantic and the transform remains structural: the model chooses failure
modes/oracles/staging; deterministic code owns topic wiring, context independence, result routing,
model-level normalization, bounded agents, and termination.

## Runtime proof

`tests/e2e/topology-generator.test.js` runs the real orchestrator and ledger with a fake provider:

1. A designer creates a topology not present in any static template; its worker result reaches
   staged independent validators and the cluster completes.
2. An impossible task returns `completed:false`; the cluster fails explicitly and no validator runs.
3. A validator reports an irreducible evidence gap; the cluster fails explicitly and the worker is
   not retried.

The focused suite reports 160 passing. Both compact design fixtures also pass the real transform,
merged admission, three-way result routing, and 20-sample deep fuzz simulation.

## Repository verification

- `node scripts/build-topology-generator.js --check`: pass
- `node scripts/check-purpose-agnostic-matrix.js`: pass
- `npm run validate:templates`: pass (warnings retained; no template errors)
- `npm run typecheck`: pass
- changed-file ESLint: zero errors
- focused config/context/e2e suite: 160 passing
- complete unit command: 2,130 passing, 18 pending, 3 failing

All three complete-suite failures reproduce from detached clean `origin/main` at `c6711f6` with the
same dependencies. Two are the brief's known `pre-commit-no-stash` failures; the third is
`Agent stuck-task recovery / terminates a durable child after a pending-launch timeout`. The test
and its lifecycle code are unchanged on this branch.

The topology checker retains non-fatal static warnings for externally consumed `CLUSTER_FAILED` and
`CLUSTER_OPERATIONS`, guarded worker-validator retry cycles, conservative `content` undefined
analysis, and the seed designer's repair source before a repair message exists. Admission and deep
simulation pass; these warnings are not presented as absent.

## Claim boundary and Phase 2

What is supported now:

- the architecture can represent every declared task mechanic without converting it to code work;
- real providers generated semantically sound graphs across the final frozen cohort;
- dynamic wiring and all terminal routes work in a real local orchestrator process;
- unavailable capabilities and unprovable claims fail explicitly instead of becoming fake success.

What remains before claiming operational universality:

- run real generated workers/validators, not just a real designer and fake downstream provider;
- inspect the delivered result and authoritative evidence for representative answer, artifact,
  external-state, long-running, and impossible/evidence-gap tasks;
- confirm version-skew preflight and real tool/capability discovery in those environments.

Per the brief, stop here. Phase 2 should begin only after explicit approval to spend provider
credits and run isolated Zeroshot clusters.
