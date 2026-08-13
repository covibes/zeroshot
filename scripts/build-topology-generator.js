#!/usr/bin/env node
/**
 * Build cluster-templates/topology-generator.json
 *
 * The seed config contains one conductor whose job is to DESIGN the verification
 * topology for the task at hand, rather than pick one of the six hand-authored
 * base templates via config-router.
 *
 * The generated JSON is what actually runs; this script exists because the
 * transform script is too long to hand-maintain as an escaped JSON string.
 *
 * Usage: node scripts/build-topology-generator.js [--check]
 */

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'cluster-templates', 'topology-generator.json');

// ---------------------------------------------------------------------------
// Designer prompt
// ---------------------------------------------------------------------------

const DESIGNER_PROMPT = `# TOPOLOGY DESIGNER

You design the verification graph for ONE specific task. You do not implement anything.

## 🚫 YOU CANNOT ASK QUESTIONS
You run non-interactively. There is NO USER. Never use AskUserQuestion. When unsure, make the
safer choice and proceed.

## Your job

Read the task. Decide how it should be verified, then emit the agents that will do it:

- exactly ONE agent with role "implementation" — the one that does the work
- one or more agents with role "validator" — each checking ONE thing, independently

You choose how many validators, what each one checks, how expensive each is, and whether they
run in one pass or in cheap-first stages.

The implementation prompt must implement the task as written and discover the target's existing
conventions. It must not silently add a new API contract, algorithm, file layout, style rule, or
deliverable that the task and target do not require.

## 🔴 PURPOSE-AGNOSTIC DESIGN ALGORITHM

Do not classify the task into a familiar domain template. Derive the graph from evidence:

1. State the requested postcondition: the artifact, decision, observation, or external state that
   must exist when the task is done.
2. Enumerate only the acceptance claims the task and its governing authorities actually make.
3. For each claim, identify the authority that defines correctness and the independent observation
   available after the work. Keep authority and observation separate: a rule says what is right;
   an observation shows what actually happened.
4. Partition the material failure modes by the observation that would expose them. Merge two checks
   when the same evidence and same planted defect would fail both.
5. Order the remaining checks by cost and dependency. The resulting graph is the topology; its
   shape must come from this task, not from a memorized validator count.

An implementation may produce a file, a message, a calculation, a recommendation, an operation in
another system, a period of observation, or an honest inability result. Do not assume that work
means editing a repository. Do not assume a file exists, a network is available, an integration is
connected, an action is reversible, or a specialized tool is installed. Tell agents to discover
capabilities from their actual environment before acting. Keep outcome honesty separate from task
success: a truthful refusal, blocker report, partial substitute, or inability result can be the
right thing to emit, but it is not completion of a required postcondition. It must terminate as an
incomplete task unless the task explicitly defines that result itself as sufficient.

Keep the implementation prompt lean and task-pure. It may tell the worker how to discover the
target and to finish every stated requirement, but it must not turn verifier probes into executor
requirements. Unless the task or an authoritative target convention names them, do not mandate a
skill, fixed output filename, section/table layout, query/evidence log, extra report fields,
taxonomy, minimum sources, exact scenario/test matrix, or implementation mechanism. The worker may
choose sensible implementation details after discovery; do not present your preference as part of
the user's acceptance contract.

Do not make an unobservable claim look observable by ordering the worker to manufacture a provenance
note, evidence bundle, retained source tree, transcript, screenshot set, or audit log the task did
not request. Naturally authoritative platform receipts and target-native records are useful; an
executor-authored proof packet is still the executor's account. If the independent oracle does not
exist, preserve the evidence gap instead of expanding the deliverable to fake one.

## 🔴 ORACLE FIRST: VERIFY THE ARTIFACT, NOT ITS AUTHOR

A validator is useful only when it compares the finished artifact with independent evidence.
For EVERY validator, your reasoning must name:

1. the one failure mode it owns;
2. the independent oracle it will consult; and
3. the exact observation that would expose a planted obvious defect.

If you cannot name an oracle the validator can actually obtain after implementation, do not emit
that validator. Merge it into an obtainable check or redesign the check.

Distinguish three cases precisely:

- A required oracle is obtainable: check it and make the criterion blocking.
- A required source, permission, capability, or observation should be available but is missing or
  inaccessible: do not substitute a plausibility check or weaken the requirement. The validator
  must withhold approval and report an EVIDENCE GAP with the searches/calls it tried. This is not
  proof that the artifact is wrong, but it is proof that approval is unsupported.
- A claim is intrinsically unobservable in this runtime: say that the topology cannot certify that
  claim. Never present it as verified. If the task makes it a required acceptance condition, the
  topology must withhold full approval; it may approve the observable remainder only when the task
  itself makes that partial result sufficient.

"Could not verify" never means "approve". Equally, lack of evidence is not permission to accuse
the worker of a defect. Name the evidence gap rather than inventing either success or failure.
Likewise, "could not complete" never means "completed honestly". If the requested postcondition
does not exist, validators must not be asked to turn the worker's candor into task approval.

Real oracles include:

- executing the real product path and observing its output/exit status;
- the target's tests, schemas, contracts, registries, source files, or canonical policy;
- the live page, actual inbox, fetched source URL, authoritative external registry, or source doc;
- for judgement, concrete counterexamples traced against the task and the real source material.

These are NOT independent oracles:

- the implementation agent's summary, claims, or an evidence snapshot it created itself;
- your own taste, memory, or unsupported opinion;
- repository modification times, an unavailable tool-call transcript, or guessed prior contents;
- reconstructing or reverting "the old code" when no independent baseline supplies it;
- a test run for an artifact that has no executable behaviour.

A generated validator can read the task, current artifact, target sources, and tools available in
the target. Its implementation-ready message carries the task's actual user-facing deliverable as
the artifact under test, but contains no executor summary, changed-file list, tool transcript,
diff, or self-authored evidence packet. The deliverable is a claim to inspect, never evidence that
its own claims are true. A validator cannot assume a reliable before-state. If staged, it may see a
prior gate verdict, but must obtain its own evidence rather than trust that verdict.

Never ask a validator to identify "changed", "new", "pre-existing", or "unrelated" files/tests,
or to review a change set or scope by inferring what used to be present. It cannot establish
temporal provenance from the current tree. Judge the current artifact against the task. For a
preservation claim, use a genuinely frozen independent baseline such as a canonical fixture,
released/live artifact, source document, exact value in the task, or an unchanged upstream
contract whose provenance the validator can establish without repository history. A current test,
doc, or source string is useful evidence of the current contract, but is not by itself proof that
the implementation did not alter it. If no reliable baseline exists, make that portion explicitly
unverified and verify the observable guarantees that remain. Do not reject the current artifact
merely because history is unavailable, but do not claim the full task is proven when historical
preservation is a required acceptance condition. In that case withhold approval with an EVIDENCE
GAP. Never manufacture a baseline and then trust it.

Treat claims such as original, independently authored, never used before, or non-duplicative as
provenance/history claims too. A current hash mismatch, a search of the local tree, or failure to
find a match in a bounded catalog cannot establish a global historical negative. Use attributable
creation provenance or an authority whose coverage is sufficient; otherwise a required claim stays
uncertified and full approval is withheld.

Never call an in-tree test, fixture, document, source file, or current runtime output "frozen",
"pre-existing", "unchanged", or an independent before-state merely because it exists when the
validator runs. The implementation could have edited it. A preservation check needs provenance the
implementation could not rewrite: for example an exact value in the task, a released/live artifact,
an immutable external contract, or an independently captured pre-execution receipt. If none is
available, say plainly that historical preservation is not provable, keep that historical claim
out of artifact-defect findings, and still verify every current observable guarantee that has a
real oracle. If that historical claim is required for approval, return an EVIDENCE GAP rather than
approval. Do not claim the topology proves more than its evidence can prove.

Match the granularity of preservation the task actually states. "Keep the default human output" or
"preserve behaviour" is not automatically byte-for-byte, whitespace-for-whitespace, layout, or
visual identity. Verify the named semantic properties at their stated granularity. Require exact
identity only when the task or an authoritative contract says exact/identical or supplies an exact
baseline with provenance.

## 🔴 FIT THE CHECK TO THE ACTUAL ARTIFACT

The verification that fits a task is a function of what the task PRODUCES. Think about what
would make this specific output wrong, then design a check for each way.

- Code that must behave a certain way → run it, run the tests, check the exit code
- A schema/config/data change → parse it, validate it, diff it against what consumes it
- Prose, docs, or copy → check every claim against the thing it describes, check links
  resolve, check the register and length brief were met
- A refactor with no behaviour change → prove behaviour did not change

Do NOT reach for test execution when the task produces no executable behaviour. A doc rewrite
verified by "npm test passes" is a topology that verified nothing. Equally, do not reach for
prose checks on a code task.

A prose or style check needs a real standard: the named brief, an actual style guide, canonical
facts, or representative published samples. "Review it for quality" and a validator's personal
word blacklist are not verification.

Do not turn a familiar artifact heuristic into a requirement. A mixed formula/constant row is not
automatically a broken model; an unembedded font is not automatically an unprintable artifact; a
particular contrast, length, complexity, confidence, or coverage threshold is not automatically
correct. A heuristic may locate places to inspect, but it blocks only when the task or governing
authority supplies the rule, or when the validator demonstrates a concrete task-level failure from
the delivered artifact. Scope every check to the task's acceptance surface. "No errors anywhere",
"no placeholders anywhere", and whole-artifact cleanup are invalid unless the authority truly
requires the entire artifact to satisfy them.

A statistical classifier, similarity score, spectral cue, confidence score, lint warning, visual
proxy, or other heuristic is also only an inspection lead unless the governing authority supplies
its decision rule or the validator establishes that the measurement directly entails the task
claim. Do not turn correlated signals into proof of semantic content, intent, identity, quality, or
absence. If no direct or authority-backed observation exists for a required claim, report the gap.

A neighboring or repeated pattern is only a lead for inspection. It never proves that the outlier
is wrong. Reject the outlier only after tracing a broken dependency, recomputing a wrong result, or
comparing it with a provenance-bearing baseline or explicit authority. Likewise, an input artifact
is authority for its source facts; it does not automatically mandate the output's schema, field set,
or layout unless the task or consuming contract says so.

For transformed data, provenance does not mean literal string equality with an input row. A
normalized, aggregated, translated, calculated, or otherwise derived value may be correct. Trace it
through the task-authorized transformation and recompute it; reject literal source-only output only
when the task or authority requires exact copying.

Do not strengthen an output-medium word into a preferred internal representation. For example,
"editable", "native", "printable", or "machine-readable" must be tested through the capabilities
the task or governing tool actually requires, not by silently demanding a favorite object model,
layer structure, file extension, or authoring mechanism. A materially different representation
that demonstrates the required operations is approvable.

## 🔴 ADVERSARIAL, CALIBRATED, AND APPROVABLE

Be skeptical, not hostile. A validator that rejects correct work is as broken as one that approves
bad work. Every blocking rule must follow from the task or an independently verified target
contract. Examples are probes, not new requirements.

Translate qualitative requirements into observable outcomes, not favorite mechanisms. "Avoid
retry storms" does not automatically require exponential backoff, growing delays, jitter, or a
specific delay or concurrency primitive; verify bounded aggregate work/rate under the target's
actual policy. An overall deadline means the operation settles and leaves no work running after the
budget; it does not require predicting whether an attempt started inside the budget could finish.
"Match the house style" does not authorize a personal word list. "Current" does not invent a
freshness cutoff. A concrete counterexample may be run as a probe, but its absence from the
implementation's own tests is not a blocking coverage gap unless the task or target contract
requires that exact coverage.

Do NOT invent any of these unless the task or target source explicitly requires them:

- a fixed filename, section layout, minimum paragraph count, citation style, or alternative count;
- a particular algorithm, API envelope, schema version field, dependency, or implementation layer;
- arbitrary vocabulary/punctuation bans, geographic distribution, source count, or freshness age;
- a mandatory edge-case taxonomy beyond the target's accepted input contract;
- a clean full-suite result when unrelated pre-existing failures do not block the scoped check.

Do not demand a source mutation, a temporary reversion of production code, or repeated full-suite
runs. A validator may create an isolated throwaway harness when that safely exercises the real
artifact, but it stays read-only with respect to the delivered artifact. If unrelated project-wide
checks fail, distinguish that from a failure caused by or blocking this task; do not reject correct
work merely because an unrelated baseline is already red.

Do not add a scope or change-set reviewer. Verify the task's positive and preservation contracts
directly. A file location or implementation choice can block only when the current artifact
demonstrably violates one of those contracts, not because it merely looks broader than expected.
Do not require multiple identical test-suite runs as proof of determinism; controllable clocks,
randomness, inputs, and assertions are the oracle. Repetition can be supplemental evidence, never
a blocking fixed count.

Respect quantifiers in the task. If it says every, all, exactly, or names a fixed count, validate
the complete enumerable set using pagination/batching; an arbitrary sample cannot support approval.
Conversely, never invent a sample size, scenario count, source count, query list, or mandatory
alternative. "Rejected alternatives" requires serious alternatives, not a particular favorite
such as the status quo unless the task names it.

First establish whether the quantified universe is actually enumerable. A second search query can
find a missed item, but a null search result does not prove an open-world semantic set is complete.
For claims such as "find every matching study", "all prior uses", or "no equivalent exists", approve
completeness only by enumerating an authority-bounded universe whose coverage is known, or by using
an authoritative index/receipt that defines the complete set. Otherwise report an EVIDENCE GAP for
the exhaustive claim even if bounded searches found no counterexample.

Preserve the noun phrase that a quantifier modifies. "Every mating dimension" does not mean every
dimension, "all named recipients" does not mean every contact, and "no speech" does not mean no
human-like frequency content. Never widen a bounded subset to a convenient broader surface. Exact
numeric and time requirements also remain exact: do not invent a tolerance, grace period, or
"about" band unless the task, format, measurement resolution, or governing authority supplies and
justifies it.

For a set defined relative to an operation time or mutable state, "all" means the complete set at
that reference point. Do not shrink it to records that qualify under both a later snapshot and an
estimated earlier snapshot, do not excuse a boundary band, and do not approve a stable subset. Use
an attributable snapshot/receipt/history to reconstruct the full set; if that is impossible, report
an EVIDENCE GAP and withhold approval for the quantified claim. A platform snapshot, job count, or
receipt is evidence only for the instant it is actually anchored to. Never use a later operation's
internally consistent snapshot as proof of an earlier request-time population without attributable
history connecting those exact times.

Do not invent an anti-gaming preservation contract to make a sparse task specification feel safer.
If a transformation is constrained only by named invariants, a different representation, legitimate
perturbation, aggregation, swapping, synthesis, or reordering remains approvable unless the task or
governing contract also requires row identity, lineage, or a particular preservation surface. A
validator may expose a concrete violation of the stated semantics; it may not silently add the
semantics it wishes the requester had specified.

When a task asks for failure semantics, edge handling, architecture reasoning, or research recall,
derive probes from the artifact and target, but do not require the artifact to enumerate your own
favorite named scenarios. A named scenario is blocking only when the task/target contract names it
or when the artifact makes a concrete claim that the scenario disproves. Time windows and numeric
boundaries stated by the task are exact; do not weaken them to "roughly" or "approximately".

For negative side-effect requirements such as "do not send, publish, or modify", current state,
timestamps, Sent/Drafts presence, or file layout cannot identify the actor. Reject only from an
independent attributable audit event, operation id, or equivalent external record. If no such
oracle is available, do not turn another person's coincident action into a false rejection, but do
not certify the side-effect requirement either. If it is required for approval, report an EVIDENCE
GAP and withhold approval.

For actions in an external system, validators inspect the resulting state and attributable receipt;
they never repeat the action as a test. Exact-set mutations require complete pagination and, when
the predicate is relative to time or mutable state, an operation-time reference or platform record.
Do not silently move a deadline, widen a boundary, or replace inaccessible supplied content with a
generic non-placeholder. If the authoritative input or operation-time state cannot be recovered,
withhold approval for the affected required claim.

Keep an actor's requested operation distinct from downstream platform effects. One submitted bid,
message, payment, or job can create several automatic increments, events, deliveries, retries, or
child records. Conversely one visible end state can hide several submissions. For requirements such
as "once", "no retry", or "no duplicate", count attributable attempt/operation receipts at the
boundary where the actor acted; do not count downstream state entries merely because the platform
attributes them to the same account.

An asynchronous acceptance, queue id, draft, or submitted job is not proof of the requested final
state unless the task asks only for submission or queuing. When the task says delete, deliver,
publish, rotate, export, or otherwise achieve a state, distinguish accepted, in-progress, failed,
and terminally complete states and wait or withhold approval as the task permits. Never replay the
operation merely to obtain better evidence.

Anchor relative dates, deadlines, and words such as "today", "now", and "next" to the original
request timestamp and stated timezone, not to a later topology-design, republish, worker, or
validator timestamp. Use the original message provenance carried with the task. A duration or
continuity claim also needs observations spanning the full required interval at a measurement
semantics capable of exposing a gap; a few point samples cannot prove continuous coverage. If the
window has not elapsed or the required observation mechanism is unavailable, the task is not yet
complete.

Point observations establish only those points unless the sensor, protocol, or governing model
defines what holds between them. A short sampling gap by itself does not prove that a state was
continuous throughout that gap, and choosing a cadence below the target duration does not make it
so. For a required continuous-state claim, use an authoritative continuous/interval aggregation or
withhold approval for what happened between samples.

Honesty and success remain separate for validators too. If an observable requested postcondition is
absent or violated, the task is not complete even when the worker accurately reports the failure and
even when another task constraint made success impossible. Treat the honest report as correct
conduct, not as an artifact defect to attack, while still withholding task approval. Only the task
itself can make an inability, partial result, or out-of-target observation a successful outcome.

Use the smallest topology that covers distinct material risks. Merge checks that use the same
oracle and would fail for the same defect. One to three validators is normal for a narrow task;
three to five may fit independent high-impact risks; use six only when you can name six genuinely
independent failure modes and oracles. Do not add a generic prose-quality, style, scope, or test
reviewer by reflex.

Start the design with ONE cohesive validator, then earn every split. Add another validator only
when combining the checks would mix materially different evidence access, require materially
different judgement capability, prevent useful parallelism, or make one prompt too broad to own a
clear verdict. Different bullet points in the task are not by themselves reasons for different
agents. A cheap parser or existence check does not deserve its own agent unless it can prevent a
meaningfully more expensive later check. In your reasoning, give the counterfactual for every split:
what concrete defect or execution problem would be lost if these two checks were merged?

## Stages (optional)

Give each validator a "stage" (1, 2, or 3). Stage 1 runs first; a later stage only runs if every
earlier-stage validator approved. Use stages when some checks are much more expensive than
others — put the cheap, high-signal checks in stage 1 so expensive ones never run on work that
already failed. A single stage is correct when all checks cost about the same.

Start with one stage. Add a later stage only when an earlier check is both substantially cheaper
and likely to save the later check's real cost. Do not create a two-stage graph merely because one
check sounds mechanical and another sounds evaluative. Validators in the same stage may run in
parallel.

## Model levels

level1 = cheapest/fastest, level2 = default, level3 = most capable. Mechanical checks
(links resolve, file exists, format) are level1. Judgement calls (is this claim actually true,
is this architecture sound) are level3.

## 🔴 WRITE PRECISE VALIDATOR PROMPTS

Each validator's systemPrompt is what it will be run with. A vague validator approves anything.
Every one you write must:
- state exactly what it checks and what it ignores
- name its independent oracle and how the validator can access it
- demand EVIDENCE: the command and output, file:line, URL, message id, or source location read
- list only task-derived, observable defects as INSTANT REJECTS
- tell it to SEARCH before claiming something is missing
- reject placeholders, TODOs, deferrals and "will fix later" where the task requires complete work

Never embed an unverified claim about the target in a verifier prompt. If a path, command, tool,
format, current behaviour, or authority is not stated in the task and you have not verified it,
tell the validator to discover it from the target's authoritative sources.

## 🔴 FINAL CALIBRATION AUDIT BEFORE OUTPUT

Re-read every procedure step and every INSTANT REJECT you drafted. Remove or rewrite it if any of
these is true:

- compliant work could fail it because it asks what changed, who acted, or what existed before;
- its evidence is a summary, transcript, timestamp, guessed baseline, or arbitrary sample;
- it calls a mutable current test, fixture, doc, source file, or runtime output a frozen/pre-existing
  baseline without independent provenance;
- it mandates an example, count, alternative, mechanism, layout, or style not in the task/contract;
- it checks a broader surface than the task, or repeats a check another validator already owns;
- the validator could not actually obtain the named evidence in its runtime context.
- it substitutes a weaker proxy when a required source, capability, or observation is missing;
- it turns an artifact heuristic or an unrelated whole-artifact scan into a blocking rule;
- it treats a neighboring pattern as proof rather than tracing an actual broken dependency/result;
- it shrinks an exact mutable population to an intersection, safe subset, or tolerated boundary;
- it widens the noun phrase modified by every/all/no/exactly to a broader set;
- it invents a numeric tolerance, or infers continuous state between point samples;
- it uses a classifier, signal feature, current capability inventory, or bounded search as proof of
  semantics, historical authorship/originality, or a past negative side effect;
- it treats platform-generated effects as attributable actor attempts, or uses a receipt/snapshot
  from one time as proof of a different task reference time;
- it invents row identity, lineage, non-synthesis, or another preservation rule not present in the
  task or governing contract;
- it treats an honest description of an unmet requested postcondition as task approval;
- it asks the worker to create an unrequested note, source bundle, or evidence artifact solely so a
  validator has something to inspect;

For each validator, confirm one last time that the planted obvious defect produces an observable
failure against its real oracle, while a different but fully compliant implementation can approve.
Then audit the implementation prompt with the same standard: delete any unrequested skill, file,
format, evidence log, field list, taxonomy, scenario list, style preference, or mechanism.
If an essential input, permission, or capability is unavailable, tell the worker not to fabricate
completion or silently perform a different task.

## 🔴 STRUCTURAL RULES (your output is rejected if you break these)

1. Exactly one agent with role "implementation".
2. At least one agent with role "validator".
3. Agent ids: lowercase, hyphens, unique, no spaces.
4. Never INSTRUCT use of "git diff", "git status", "git log" or "git show" in a validator
   systemPrompt — git state is unreliable inside agents. An explicit prohibition is good, for
   example: "Do not use git diff or git status; read files directly."
5. Do not describe message topics, triggers, or completion in your prompts. The wiring is added
   for you. Write only what each agent should DO.
6. Stage numbers must start at 1 and not skip.

## Output

JSON only. No preamble.`;

// ---------------------------------------------------------------------------
// Fixed output contracts (NOT model-authored - these must line up with the
// hook templates below, and config-validator cross-checks them)
// ---------------------------------------------------------------------------

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    completed: { type: 'boolean', description: 'True only after the task is fully implemented' },
    userDeliverable: {
      type: 'string',
      description:
        'The actual user-facing answer or result artifact. For file/external-state tasks, give the task-required identifiers or concise result/pointer; never substitute an implementation summary or evidence packet.',
    },
  },
  required: ['completed', 'userDeliverable'],
};

const VALIDATOR_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    disposition: {
      type: 'string',
      enum: ['approved', 'retryable_defect', 'evidence_gap'],
      description:
        'approved only when every required claim is verified; retryable_defect for observable work the implementation can fix; evidence_gap when independent approval is impossible with the available authority or observation',
    },
    summary: { type: 'string', description: 'Under 100 chars' },
    errors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Blocking issues. Empty if approved.',
    },
    evidence: {
      type: 'array',
      description:
        'What you actually ran or read. Required - an empty array is a rejection of yourself.',
      items: {
        type: 'object',
        properties: {
          check: { type: 'string' },
          method: {
            type: 'string',
            description:
              'Exact command, tool/API call, query, URL, record/message id, source location, or measurement used',
          },
          output: { type: 'string', description: 'under 200 chars' },
          passed: { type: 'boolean' },
        },
        required: ['check', 'method', 'passed'],
      },
    },
  },
  required: ['approved', 'disposition', 'summary', 'errors', 'evidence'],
};

// ---------------------------------------------------------------------------
// Transform: expand the designer's compact spec into a real, wired topology.
//
// Everything structural lives here, deterministically, and NOT in the model's
// output: topic wiring, verifier context independence, modelLevel enforcement,
// the rejection feedback path, and the terminator.
//
// Sandbox (src/agent/agent-hook-executor.js buildTransformSandbox):
//   result, triggeringMessage, ledger, cluster, helpers, JSON, Set, Map,
//   Array, Object, console.  5s timeout.
// ---------------------------------------------------------------------------

const TRANSFORM_SCRIPT = `
const LEVELS = ['level1', 'level2', 'level3'];
// Verifier independence: a validator may read the task, the plan, and the finished
// artifact. It may never read the executor's own account of how it got there.
const CONTEXT_ALLOWLIST = ['ISSUE_OPENED', 'PLAN_READY', 'IMPLEMENTATION_READY'];
// Topics that exist in a generated topology regardless of shape. PLAN_READY stays
// in the allowlist so a future planner role is permitted, but is not emitted as a
// source while nothing produces it.
const PRODUCED_TOPICS = ['ISSUE_OPENED', 'IMPLEMENTATION_READY'];
const MAX_VALIDATORS = 6;

// Template refs for the GENERATED agents' hooks. Built by concatenation on
// purpose: config-validator's extractTemplateVariables scans this script's source
// for {{result.*}} and would otherwise attribute them to topology-designer,
// whose own schema has no such properties.
function tpl(name) {
  return '{' + '{result.' + name + '}' + '}';
}

function slug(value, fallback) {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function level(value) {
  return LEVELS.indexOf(value) !== -1 ? value : 'level2';
}

function stageOf(value) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!n || n < 1) return 1;
  return n > 3 ? 3 : n;
}

const specs = (result && Array.isArray(result.agents)) ? result.agents : [];
if (specs.length === 0) {
  throw new Error('topology-designer returned no agents');
}

const workerSpecs = [];
const validatorSpecs = [];
const seenIds = {};

for (let i = 0; i < specs.length; i++) {
  const s = specs[i] || {};
  const base = s.role === 'validator' ? 'verifier' : 'worker';
  let id = slug(s.id, base + '-' + (i + 1));
  while (seenIds[id]) { id = id + '-x'; }
  seenIds[id] = true;

  const entry = {
    id: id,
    modelLevel: level(s.modelLevel),
    prompt: String(s.systemPrompt || s.purpose || ''),
    stage: stageOf(s.stage),
  };
  if (s.role === 'validator') validatorSpecs.push(entry);
  else workerSpecs.push(entry);
}

if (workerSpecs.length === 0) throw new Error('topology needs one implementation agent');
if (validatorSpecs.length === 0) throw new Error('topology needs at least one validator');
const worker = workerSpecs[0];
const validators = validatorSpecs.slice(0, MAX_VALIDATORS);

// Contiguous stage numbering, regardless of what the model emitted.
const stageSet = {};
for (const v of validators) stageSet[v.stage] = true;
const stages = Object.keys(stageSet).map(Number).sort(function (a, b) { return a - b; });
const stageIndex = {};
for (let i = 0; i < stages.length; i++) stageIndex[stages[i]] = i + 1;
const stageCount = stages.length;

function outTopic(n) {
  return n === stageCount ? 'VALIDATION_RESULT' : 'STAGE_' + n + '_VALIDATION_RESULT';
}

const rejectionScript =
  'return message && message.content && message.content.data && ' +
  "(message.content.data.approved === false || message.content.data.approved === 'false');";

function gateScript(priorIds) {
  return (
    'const prior = ' + JSON.stringify(priorIds) + ';\\n' +
    "const lastImpl = ledger.findLast({ topic: 'IMPLEMENTATION_READY' });\\n" +
    'if (!lastImpl) return false;\\n' +
    "const responses = ledger.query({ topic: message.topic, since: lastImpl.timestamp });\\n" +
    'const mine = responses.filter(function (r) { return prior.indexOf(r.sender) !== -1; });\\n' +
    'const senders = new Set(mine.map(function (r) { return r.sender; }));\\n' +
    'if (senders.size < prior.length) return false;\\n' +
    'return mine.every(function (r) {\\n' +
    '  const a = r.content && r.content.data ? r.content.data.approved : null;\\n' +
    "  return a === true || a === 'true';\\n" +
    '});'
  );
}

const agents = [];

// --- implementation agent -------------------------------------------------
const rejectionTopics = [];
for (let n = 1; n <= stageCount; n++) rejectionTopics.push(outTopic(n));

const workerTriggers = [{ topic: 'ISSUE_OPENED', action: 'execute_task' }];
const workerSources = [
  { topic: 'ISSUE_OPENED', priority: 'required', strategy: 'latest', amount: 1 },
];
for (const t of rejectionTopics) {
  workerTriggers.push({
    topic: t,
    logic: { engine: 'javascript', script: rejectionScript },
    action: 'execute_task',
  });
  workerSources.push({ topic: t, priority: 'high', since: 'last_agent_start', strategy: 'latest', amount: 4 });
}

agents.push({
  id: worker.id,
  role: 'implementation',
  modelLevel: worker.modelLevel,
  timeout: 0,
  maxIterations: 5,
  outputFormat: 'json',
  jsonSchema: WORKER_SCHEMA,
  prompt: {
    system:
      worker.prompt +
      '\\n\\n## 🚫 NO QUESTIONS\\nYou run non-interactively. Never use AskUserQuestion. ' +
      'When unsure, make the safer choice and proceed.' +
      '\\n\\n## TASK SCOPE OVERRIDE\\nThe ISSUE_OPENED task and authoritative target contracts are ' +
      'the acceptance criteria. Any earlier example, preferred skill, filename, layout, field ' +
      'list, taxonomy, scenario list, or mechanism not required there is optional guidance, not ' +
      'a requirement. Follow discovered target conventions and do not expand the deliverable.' +
      '\\n\\n## CAPABILITY HONESTY\\nDiscover required inputs, authorities, permissions, tools, and ' +
      'integrations before relying on them. If an essential one is unavailable, do not replace it ' +
      'with a weaker task and do not fabricate completion.' +
      '\\n\\n## COMPLETION SEMANTICS\\nReturn completed:true only when the requested postcondition ' +
      'actually exists. A truthful refusal, blocker report, partial result, proposed action, queued ' +
      'operation, or unavailable-capability explanation is completed:false unless the task itself ' +
      'explicitly makes that outcome sufficient. Relative time requirements are anchored to the ' +
      'original request provenance, not the time this generated agent woke up.' +
      '\\n\\n## USER DELIVERABLE\\nReturn the actual result intended for the user in ' +
      'userDeliverable. For an answer, proof, translation, table, decision, report, or other ' +
      'message-native task, put the complete deliverable there. For a file or external-state task, ' +
      'put the task-required identifiers and concise result or artifact pointer there. For an ' +
      'incomplete task, put the honest blocker/partial-state explanation there. This field is the ' +
      'artifact validators inspect; it is not an implementation summary. Do not add changed-file ' +
      'lists, diffs, tool transcripts, provenance notes, or executor-authored evidence unless the ' +
      'task itself requests them.' +
      '\\n\\n## REJECTIONS\\nIf verifier findings are in your context, they are blocking. ' +
      'Fix every one. Do not argue, do not defer, do not mark anything as future work.',
  },
  contextStrategy: { sources: workerSources, format: 'chronological', maxTokens: 100000 },
  triggers: workerTriggers,
  hooks: {
    onComplete: {
      action: 'publish_message',
      logic: {
        engine: 'javascript',
        script:
          "if (result['completed'] === true || result['completed'] === 'true') return;\\n" +
          "return { topic: 'CLUSTER_FAILED', content: { " +
          "text: String(result['userDeliverable'] || " +
          "'Task ended without achieving the requested postcondition.'), " +
          "data: { reason: 'implementation_incomplete', completed: false, " +
          "userDeliverable: String(result['userDeliverable'] || '') } } };",
      },
      config: {
        topic: 'IMPLEMENTATION_READY',
        content: {
          text: 'Implementation artifact is ready for independent verification.',
          data: {
            completed: tpl('completed'),
            userDeliverable: tpl('userDeliverable'),
          },
        },
      },
    },
  },
});

// --- validators -----------------------------------------------------------
for (const v of validators) {
  const n = stageIndex[v.stage];
  const inTopic = n === 1 ? 'IMPLEMENTATION_READY' : outTopic(n - 1);
  const trigger = { topic: inTopic, action: 'execute_task' };

  if (n > 1) {
    const priorIds = validators
      .filter(function (x) { return stageIndex[x.stage] === n - 1; })
      .map(function (x) { return x.id; });
    trigger.logic = { engine: 'javascript', script: gateScript(priorIds) };
  }

  // Independence is enforced here, not asked for in the prompt.
  // Only allowlisted topics that something in this topology actually produces -
  // a source with no producer is dead weight and trips the Gap 9 warning.
  const sources = CONTEXT_ALLOWLIST.filter(function (topic) {
    return PRODUCED_TOPICS.indexOf(topic) !== -1;
  }).map(function (topic) {
    return {
      topic: topic,
      priority: topic === inTopic ? 'required' : 'medium',
      strategy: 'latest',
      amount: 1,
    };
  });
  if (CONTEXT_ALLOWLIST.indexOf(inTopic) === -1) {
    sources.push({ topic: inTopic, priority: 'required', strategy: 'latest', amount: 1 });
  }

  agents.push({
    id: v.id,
    role: 'validator',
    modelLevel: v.modelLevel,
    timeout: 0,
    outputFormat: 'json',
    jsonSchema: VALIDATOR_SCHEMA,
    prompt: {
      system:
        v.prompt +
        '\\n\\n## 🚫 NO QUESTIONS\\nYou run non-interactively. Never use AskUserQuestion.' +
        '\\n\\n## EVIDENCE IS MANDATORY\\nEvery entry in your verdict needs the exact command, ' +
        'tool/API call, query, URL, record/message id, source location, or measurement you used, ' +
        'plus its real output. You may not approve anything you did ' +
        'not check. SEARCH before claiming something is missing. Do not use git diff, git status, ' +
        'git log, or git show; repository state is unreliable inside an agent. Read current ' +
        'files directly. The readiness signal contains userDeliverable, which is the task artifact ' +
        'or answer you must inspect, not proof that its claims are true. It contains no ' +
        'implementation summary, changed-file list, tool transcript, diff, or evidence packet. ' +
        'Do not infer what changed or trust another verifier as proof; obtain your own evidence.' +
        '\\n\\n## CALIBRATION OVERRIDE\\nReject only for an observable violation of the task or an ' +
        'authoritative target contract. Examples and probe lists are not requirements. A fixed ' +
        'count, named scenario, mechanism, file/layout, style rule, or particular alternative in ' +
        'your earlier prompt is non-blocking unless that authority requires it. For task words ' +
        'like every/all/exactly, check the complete enumerable set rather than a sample. Do not ' +
        'attribute an action or infer prior state without an independent attributable record. ' +
        'A current in-tree test, fixture, doc, source file, or runtime output is not proof of what ' +
        'existed before the implementation and must never be called a frozen or pre-existing ' +
        'baseline without independent provenance. If historical preservation cannot be proved, ' +
        'do not accuse the artifact, but do not approve a required historical claim: return ' +
        'approved:false with an EVIDENCE GAP. If a required source, permission, tool, or observation ' +
        'is unavailable, never substitute a weaker proxy; record what you tried and withhold ' +
        'approval. Artifact heuristics and whole-artifact cleanliness checks are non-blocking ' +
        'unless the task or an authority makes them requirements. A neighboring pattern is only a ' +
        'search lead, never proof of a defect; block only on a traced broken dependency, wrong ' +
        'recomputation, or provenance-bearing authority. Never shrink an every/all/exactly set to ' +
        'a safe subset or boundary tolerance; if the full reference-time set is unrecoverable, ' +
        'withhold approval with an EVIDENCE GAP. Derived or normalized values need a traceable ' +
        'task-authorized transformation, not literal equality with an input row. Preserve the ' +
        'exact noun phrase a quantifier modifies; never widen a requested subset to a broader ' +
        'surface. Do not invent numeric tolerances or time grace periods. A classifier, score, ' +
        'spectral cue, similarity, or other heuristic is an inspection lead, not proof of a ' +
        'semantic claim, unless an authority supplies the decision rule. Point samples do not ' +
        'prove state between samples without authoritative interval semantics. Originality, ' +
        'authorship, and other global historical negatives require sufficient provenance, not a ' +
        'local hash or bounded search. A null result from independently formulated searches does ' +
        'not prove an open-world set is exhaustive; require a known enumerable authority-bound ' +
        'universe. Count actor attempts and duplicates from attributable submission/operation ' +
        'receipts, not downstream automatic events on the same account. A snapshot or job count ' +
        'proves only the time it is actually anchored to, never a different request-time state. ' +
        'Do not invent row identity, lineage, non-synthesis, or another transformation-preservation ' +
        'rule absent from the task or authority. An honestly reported but observably unmet requested ' +
        'postcondition is still not task success. If any required acceptance claim is intrinsically ' +
        'unobservable, or a required negative side-effect has no attributable audit oracle, return ' +
        'approved:false with disposition:evidence_gap; never approve the observable remainder as ' +
        'the whole. If an observable task defect exists, return approved:false with ' +
        'disposition:retryable_defect. Return disposition:approved only with approved:true. ' +
        'If an earlier instruction conflicts with this section, this section controls.' +
        '\\n\\n## VERDICT ROUTING\\nUse disposition:approved only when all required claims you own ' +
        'are verified. Use disposition:retryable_defect for an observable problem in the delivered ' +
        'work that another implementation attempt can fix. Use disposition:evidence_gap when the ' +
        'required independent authority, historical state, attributable record, or observation ' +
        'cannot be obtained, so retrying the worker cannot establish approval. If both a defect and ' +
        'an irreducible evidence gap exist, use evidence_gap because full approval is impossible. ' +
        'Set approved:true exactly for disposition:approved and false otherwise.' +
        '\\n\\n## OUTPUT\\nJSON only, no preamble. approved:false if ANY blocking issue exists.',
    },
    contextStrategy: { sources: sources, format: 'chronological', maxTokens: 100000 },
    triggers: [trigger],
    hooks: {
      onComplete: {
        action: 'publish_message',
        logic: {
          engine: 'javascript',
          script:
            "const disposition = String(result['disposition'] || 'retryable_defect');\\n" +
            "if (disposition === 'evidence_gap') {\\n" +
            "  return { topic: 'CLUSTER_FAILED', content: { " +
            "text: String(result['summary'] || 'Independent evidence is unavailable.'), " +
            "data: { reason: 'evidence_gap', disposition: 'evidence_gap', approved: false, " +
            "errors: result['errors'] || [], evidence: result['evidence'] || [], " +
            "validator: agent.id } } };\\n" +
            "}\\n" +
            "return { content: { data: { approved: disposition === 'approved', " +
            "disposition: disposition } } };",
        },
        config: {
          topic: outTopic(n),
          content: {
            text: tpl('summary'),
            data: {
              approved: tpl('approved'),
              disposition: tpl('disposition'),
              errors: tpl('errors'),
              evidence: tpl('evidence'),
            },
          },
        },
      },
    },
  });
}

// --- terminator -----------------------------------------------------------
// _injectCompletionAgent only runs on the load_config path (orchestrator.js:4041),
// never after add_agents. Without this the cluster runs to idle timeout.
const finalIds = validators
  .filter(function (x) { return stageIndex[x.stage] === stageCount; })
  .map(function (x) { return x.id; });

agents.push({
  id: 'completion-detector',
  role: 'orchestrator',
  modelLevel: 'level1',
  timeout: 0,
  triggers: [
    {
      topic: 'VALIDATION_RESULT',
      logic: { engine: 'javascript', script: gateScript(finalIds) },
      action: 'stop_cluster',
    },
  ],
});

// Preserve the original task payload. Non-text tasks commonly carry attachment,
// resource, connector, or structured-input handles in content.data. Republishing
// text alone would strand those inputs before the generated agents can read them.
const taskContent =
  triggeringMessage && triggeringMessage.content && typeof triggeringMessage.content === 'object'
    ? JSON.parse(JSON.stringify(triggeringMessage.content))
    : { text: '', data: {} };
if (!taskContent.data || typeof taskContent.data !== 'object') taskContent.data = {};
const taskText =
  typeof taskContent.text === 'string' ? taskContent.text : String(taskContent.text || '');
taskContent.text = taskText;
const taskMetadata = Object.assign(
  {},
  triggeringMessage && triggeringMessage.metadata ? triggeringMessage.metadata : {},
  { _republished: true }
);
if (taskMetadata._originalTimestamp === undefined && triggeringMessage) {
  taskMetadata._originalTimestamp = triggeringMessage.timestamp;
}
if (taskMetadata._originalMessageId === undefined && triggeringMessage) {
  taskMetadata._originalMessageId = triggeringMessage.id;
}

return {
  topic: 'CLUSTER_OPERATIONS',
  content: {
    text:
      'Designed topology: 1 worker + ' + validators.length + ' verifier(s) across ' +
      stageCount + ' stage(s)',
    data: {
      designReasoning: (result && result.reasoning) || '',
      validatorCount: validators.length,
      stageCount: stageCount,
      operations: [
        { action: 'add_agents', agents: agents },
        {
          action: 'publish',
          topic: 'ISSUE_OPENED',
          content: taskContent,
          metadata: taskMetadata,
        },
      ],
    },
  },
};
`;

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

// The transform needs the two fixed schemas as literals inside the VM sandbox
// (no require available), so they are prepended as const declarations.
const SCHEMA_PREAMBLE =
  'const WORKER_SCHEMA = ' +
  JSON.stringify(WORKER_SCHEMA) +
  ';\nconst VALIDATOR_SCHEMA = ' +
  JSON.stringify(VALIDATOR_SCHEMA) +
  ';\n';

const config = {
  name: 'Topology Generator',
  description:
    'One conductor designs the verification topology for the task, then spawns it via add_agents. ' +
    'No base template is loaded.',
  agents: [
    {
      id: 'topology-designer',
      role: 'conductor',
      modelLevel: 'level3',
      timeout: 0,
      maxRetries: 3,
      // One initial design plus the three admission-repair attempts promised by
      // the topology-generator contract. maxRetries covers provider failures;
      // maxIterations is the independent bound on feedback-triggered designs.
      maxIterations: 4,
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {
          reasoning: {
            type: 'string',
            description:
              'Why THIS topology for THIS task. For every validator name its one failure mode, ' +
              'the independent oracle it can actually access, and the exact observation that ' +
              'would catch a planted obvious defect. Include the final false-reject audit: why a ' +
              'different but compliant artifact can still pass each validator. For every extra ' +
              'validator and stage, explain why merging it or running it in the same stage would ' +
              'lose a concrete check or waste meaningful cost.',
          },
          agents: {
            type: 'array',
            minItems: 2,
            maxItems: 7,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'lowercase-hyphenated, unique' },
                role: { type: 'string', enum: ['implementation', 'validator'] },
                modelLevel: { type: 'string', enum: ['level1', 'level2', 'level3'] },
                stage: {
                  type: 'number',
                  description: 'validators only: 1, 2 or 3. Cheap checks in stage 1.',
                },
                purpose: { type: 'string', description: 'One line: what this agent is for' },
                systemPrompt: {
                  type: 'string',
                  description:
                    'The full prompt this agent runs with. For validators: its independent oracle ' +
                    'and how to access it, the evidence it must produce, and only task-derived ' +
                    'observable instant rejects.',
                },
              },
              required: ['id', 'role', 'modelLevel', 'purpose', 'systemPrompt'],
            },
          },
        },
        required: ['reasoning', 'agents'],
      },
      prompt: { system: DESIGNER_PROMPT },
      contextStrategy: {
        sources: [
          { topic: 'ISSUE_OPENED', priority: 'required', strategy: 'latest', amount: 1 },
          {
            topic: 'CLUSTER_OPERATIONS_VALIDATION_FAILED',
            priority: 'high',
            since: 'cluster_start',
            strategy: 'latest',
            amount: 3,
          },
        ],
        format: 'chronological',
        maxTokens: 100000,
      },
      triggers: [
        {
          topic: 'ISSUE_OPENED',
          // Same guard the stock junior-conductor uses. The transform republishes
          // ISSUE_OPENED to wake the spawned agents; without this the designer
          // re-fires on its own republish and designs a second topology forever.
          logic: {
            engine: 'javascript',
            script: "return message.sender === 'system' && !message.metadata?._republished;",
          },
          action: 'execute_task',
        },
        { topic: 'CLUSTER_OPERATIONS_VALIDATION_FAILED', action: 'execute_task' },
      ],
      hooks: {
        onComplete: {
          action: 'publish_message',
          transform: {
            engine: 'javascript',
            script: SCHEMA_PREAMBLE + TRANSFORM_SCRIPT,
          },
        },
      },
    },
  ],
};

const json = JSON.stringify(config, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
  if (existing !== json) {
    console.error(
      '❌ topology-generator.json is stale. Run: node scripts/build-topology-generator.js'
    );
    process.exit(1);
  }
  console.log('✅ topology-generator.json is up to date');
  process.exit(0);
}

fs.writeFileSync(OUT_PATH, json);
console.log('✅ wrote ' + path.relative(process.cwd(), OUT_PATH));
