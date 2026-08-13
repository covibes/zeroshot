# Topology generator Phase 1 iteration log

## Iteration 09 — orthogonal calibration baseline

- Replaced the code / architecture / non-code-only evaluation with 24 cells crossing task verb,
  artifact or state transition, oracle, environment, and risk.
- Reserved 12 domains as an untouched holdout cohort whose domain terms were absent from the
  designer prompt.
- Ran all 12 calibration cells against the real provider. Structural cold admission was 12/12;
  human semantic review passed only 3/12.
- Found five general failures: artifact heuristics became requirements; missing evidence was
  weakened; time-relative/external actions lost their evidence boundary; every graph converged on
  the same shape; and structured task data was dropped during republish.

## Iteration 10 — evidence-boundary algorithm

- Added the derivation sequence: postcondition -> acceptance claims -> authority -> independent
  observation -> minimal failure-mode partition -> cost/dependency order.
- Required evidence gaps now withhold approval without accusing the artifact or accepting a weaker
  proxy.
- Prohibited arbitrary artifact heuristics, unrelated whole-artifact cleanup, and executor-created
  proof packets from becoming blocking requirements.
- Preserved complete `ISSUE_OPENED` content/data and source metadata across dynamic spawn.

## Iteration 11 — targeted false-reject calibration

- Resampled the weakest code, structured-data, spreadsheet, and external-action cases.
- Tightened the distinction between task requirements and verifier probes, and between current
  contract evidence and an unavailable historical baseline.
- Kept tests and concrete counterexamples as observations, not mandatory implementation mechanisms.

## Iteration 12 — derived-data calibration

- Focused on transformations where literal source equality is wrong.
- Validators now trace normalized, aggregated, translated, or calculated values through the
  task-authorized transformation instead of inventing row preservation or source-only output.

## Iteration 13 — first untouched holdout: claim failed

- Cold admission passed 12/12.
- Semantic review passed only 4/12, so the purpose-agnostic claim failed.
- The holdout exposed general problems around historical negatives, physical-world claims,
  operation attribution, unavailable authorities, and honest inability being mistaken for success.
- The cohort was frozen as a failure; it was not resampled into a pass.

## Iterations 14-15 — failure-driven calibration

- Converted only cross-cutting failure classes from iteration 13 into prompt rules.
- Calibrated preservation provenance, exact time/quantifier semantics, irreversible operations,
  subjective authorities, physical observability, and originality/global-negative claims.
- Added deterministic `completed:false` routing so an unmet postcondition terminates as non-success
  before validators can approve the worker's candor.

## Iteration 16 — 18-cell final holdout: claim failed

- Froze seed `b9443cf2d2e03e378fe122cd7ada1648b55676e8b98d6eeae18297ae9101171d` before sampling.
- Cold admission passed 18/18; topology shape varied across 2-4 validators and 1-2 stages.
- Semantic review passed 13/18. Five failures remained: proxy events counted as actor retries;
  invented row-lineage preservation; open-world search treated as exhaustive; honest out-of-band
  observation treated as success; and a later snapshot accepted as request-time state.
- Found a runtime algebra bug: `approved:false` conflated retryable defects with irreducible evidence
  gaps.

## Post-iteration-16 general runtime fix

- Added validator dispositions: `approved`, `retryable_defect`, and `evidence_gap`.
- Retryable defects return to the worker; evidence gaps go directly to explicit cluster non-success.
- Added rules for attributable actor attempts, actual snapshot anchors, open-world completeness,
  non-invented lineage, and unmet observed postconditions.

## Iteration 17 — 18-cell post-fix holdout: claim failed

- Froze seed `0462211632f03515d34c9cde9ff429741b8c279617933c26d7b99b860d8959e6` before sampling.
- Cold admission passed 18/18; shape again varied across 2-4 validators and 1-2 stages.
- Semantic review passed 9/18.
- The graph worked for code, files, media, and external state, but the worker schema carried only a
  completion bit. Answer-native results—translations, calculations, reports, receipts, decisions,
  and inline tables—could disappear before validation. This was a real purpose-agnostic runtime
  failure, not a prompt-style issue.

## Post-iteration-17 general deliverable fix

- Added required `userDeliverable` transport to the generated worker contract.
- `IMPLEMENTATION_READY` carries the actual task artifact/answer plus `completed`; it still excludes
  implementation summaries, diffs, file lists, tool transcripts, and executor-authored evidence.
- Validators treat `userDeliverable` as the artifact under test, never as proof of its own claims.
- Incomplete tasks preserve their useful blocker/partial result in `CLUSTER_FAILED`.

## Iteration 18 — final untouched task-mechanics proof

- Froze seed `ae8345d25feba5645eb393ef562442a33735de4ce5abf40783049f31773dc6d7`
  before sampling.
- Cold admission passed 12/12 and semantic review passed 12/12.
- The cohort includes answer-native safety calculation, closed-guide transformation, creative work,
  complete-population decisioning, concurrent executable behavior, editable visual media,
  irreversible finance, future external state, continuous sensor observation, open-world research,
  impossible physical observation, and privacy-preserving aggregation.
- Shapes varied: six designs used 2 validators, five used 3, one used 4; three used a single stage and
  nine used two stages.
- Added a mechanical matrix audit. Across the 48 ontology-bearing cases, all 51 values in eight
  task-mechanics dimensions are exercised and 43 task vectors are distinct.
