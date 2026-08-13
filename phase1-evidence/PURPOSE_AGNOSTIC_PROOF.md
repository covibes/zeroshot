# Purpose-agnostic topology proof

The claim is not that the designer recognizes many domains. A medication task and a tax task can
still be the same workflow wearing different nouns. The claim under test is:

> Given a requested postcondition, the topology designer derives a minimal examination graph from
> the governing authority, the task's completion mechanics, and the evidence an independent agent
> can actually observe.

No finite matrix proves every conceivable future task. The useful generality claim is architectural:
the runtime carries arbitrary task inputs and user-facing results, the designer derives checks from
claims and oracles instead of a domain router, and unsupported claims terminate honestly rather than
being forced through a code-shaped success path.

## Task mechanics, not domain labels

`purpose-agnostic-matrix.json` contains 72 tasks. The final 48 cases are classified across eight
orthogonal task-mechanics dimensions:

- completion kind: artifact, answer, decision, external transition, observation window,
  interaction, or hybrid;
- authority: literal task terms, attached sources, formal rules, live authorities, platform
  contracts, human judgement, or no supplied authority;
- observability: direct, recomputed, probabilistic, delayed, partial, subjective, historical, or
  impossible in the runtime;
- input carrier: prompt, text/structured attachment, binary media, live web, connected system,
  sensor stream, or missing capability;
- side effects: none, reversible, irreversible, duplicate-sensitive, or explicitly prohibited;
- time: none, request-relative, deadline, continuous window, operation-time snapshot, or
  asynchronous terminal state;
- cardinality: one item, exact set, complete population, stream, or open world;
- valid outcome: complete, qualified, inconclusive, evidence gap, or terminal failure.

Run `node scripts/check-purpose-agnostic-matrix.js` to mechanically verify that every declared
category is exercised, every task uses valid ontology values, task IDs are unique, and frozen cohort
sizes still match their declarations. The current audit reports 48 ontology-bearing cases covering
all 51 declared values, with 43 distinct eight-dimensional task vectors.

The older verb/artifact/oracle/environment/risk axes remain useful, but they are secondary. They
measure surface diversity; the task ontology measures whether the system handles genuinely
different kinds of completion and proof.

## What counts as a semantic pass

Structural admission is necessary but insufficient. A human review of every emitted validator
prompt must pass all nine criteria recorded in the matrix. In particular:

- A planted obvious defect must produce concrete blocking evidence.
- A materially different but compliant artifact must remain approvable.
- Blocking rules must come from the task or a governing authority, not a familiar heuristic.
- Required unobservable claims become an explicit evidence gap, never invented proof.
- Irreversible actions are verified from receipts/post-state and are never repeated as a test.
- `every`, `all`, and `exactly` use the complete enumerable population; open-world completeness is
  never inferred from a null search.
- Subjective requirements use a supplied brief/standard and do not become personal taste.
- Physical execution, historical preservation, request-time state, and actor attribution are not
  inferred from a current artifact or downstream proxy events.
- The worker performs the task and returns its real user deliverable; it is not ordered to
  manufacture an executor-authored proof packet.

## Frozen-cohort discipline

The sequence is deliberately falsifiable:

1. Commit a cohort and seed hash before sampling.
2. Run one fresh real-provider design per task.
3. Run the real transform and merged-config admission check.
4. Review the effective generated prompts against all nine criteria and the planted defect.
5. If any case fails, mark that cohort failed. Make only a general fix, commit a new cohort, and run
   it once. Never resample or quietly reclassify the failed cohort as a pass.

That discipline produced real failures: iteration 13 passed 4/12 semantically, iteration 16 passed
13/18, and iteration 17 passed 9/18. Their evidence remains in place. The final committed cohort in
iteration 18 passed 12/12 admission and 12/12 semantic review.

## Proof layers

Phase 1 proves four things without a paid multi-agent cluster run:

1. Real providers can design varied task-specific graphs.
2. The real transform admits and wires those graphs, including structured input and request
   provenance.
3. The worker's actual user-facing result reaches independent validators without its summary,
   diff, or self-authored evidence becoming an oracle.
4. Token-free fake-provider end-to-end runs prove success, honest inability, and irreducible
   evidence-gap termination through the real orchestrator and ledger.

It does not yet prove that real generated workers complete representative tasks. That is Phase 2,
which requires explicit sign-off under `docs/topology-generator-brief.md`.
