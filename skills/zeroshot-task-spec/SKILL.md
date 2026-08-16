---
name: zeroshot-task-spec
description: Use when writing a task or plan file for Zeroshot to execute, converting an issue, ticket, or idea into work for `zeroshot run`, or when a previous Zeroshot run produced incomplete work, was rejected by its validators, or picked the wrong workflow size for the change.
license: MIT
metadata:
  author: the-open-engine
  version: '1.0'
---

# Writing Zeroshot Task Specs

## Overview

Zeroshot runs an executor–verifier loop: an executor implements the change, and
an **independent** verifier that never saw the executor's reasoning decides
whether it holds. A spec is good when that verifier can reach a verdict without
asking anyone a question.

**Core principle: every claim in the spec must be checkable by running something.**
The verifier cannot ask you what you meant. Prose it cannot execute is prose it
must guess at, and a guessing verifier either rubber-stamps or rejects at random.

## What Zeroshot Actually Parses

Most of the file is read by a language model, not a parser. Three things are
mechanical, and getting them wrong fails before any agent runs:

| Mechanic       | Rule                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| File extension | Only `.md` and `.markdown` are read as files. `task.txt` or `task` makes the **literal path string** the task body. |
| Title          | The first `# H1` anywhere in the file becomes the cluster title and the PR title. No H1 → the filename is used.     |
| Command proofs | A fenced ` ```zeroshot-command-proofs ` block is parsed as JSON. It is the only structured hook in the document.    |

Everything else — headings, ordering, emphasis — exists to steer the model.
There is no schema, no front matter, and no required section. The entire file
arrives as one blob, so structure earns its place by being legible, not by being
recognized.

Never wrap the document in a ` ```markdown ` fence. The file _is_ markdown.

## The Recipe

A Zeroshot spec is these seven parts, in this order:

1. **`# H1` title** — imperative, specific, PR-title quality. `# Add --json output to logtail status`, not `# JSON support`.
2. **Scope line** — one sentence naming file count, whether behavior changes, and whether the change touches a high-risk category. This is the classification anchor; see below.
3. **Context** — what exists today and why it is wrong. Two to five sentences. Point at the subsystem; do not paste code.
4. **Required behavior** — numbered, observable statements. Each one is something a verifier can trigger and watch.
5. **Acceptance criteria table** — the contract. Format below.
6. **Verification** — the repo's own commands, by name, plus a command-proofs block when the commands are expensive.
7. **Out of scope** — what the executor must not touch, phrased as present-tense boundaries.

Copy `assets/task-template.md` and fill it in.

## The Classification Anchor

Zeroshot's conductor sizes the workflow from the task text before any work
starts: how many validators run, which model tier, whether the debug workflow
loads. Its rubric keys on the _shape of the diff_, and it explicitly discounts
topic keywords — "refactor the auth module" reads as routine, while "change the
password comparison" reads as high-risk.

Write one sentence that states the three things it looks for:

> Touches 2 files in the `follow` code path, changes user-visible behavior, and does not modify authentication logic, billing math, secrets, destructive database operations, production deployment, or PII handling.

Also name the work type in the title verb, because a fix routes to a different
agent graph than an addition:

- **Fix / debug / diagnose** → investigator → fixer → tester
- **Add / implement / build** → planner → worker → validators
- **Explain / audit / find** → read-only exploration

When the change genuinely does modify one of those six high-risk categories, say
so in plain words. The conductor's tie-break bias runs _downward_ toward the
cheaper workflow, so an unstated risk is an under-verified one.

Full rubric and routing table: `references/classification.md`.

## The Acceptance Criteria Contract

Zeroshot's planner must emit at least three criteria, each carrying an id, the
criterion, an exact verification step, and a priority. The requirements
validator then verifies _those_ — so criteria written in that shape survive the
handoff intact, while a `- [ ]` checklist gets paraphrased first.

Write them as a table:

| ID  | Criterion                                                                     | Verification                                                                         | Priority |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| AC1 | `logtail status --json` emits a single JSON object on stdout and nothing else | `logtail status --json \| python -c "import json,sys; json.load(sys.stdin)"` exits 0 | MUST     |
| AC2 | Numeric fields are JSON numbers, absent values are `null`                     | `pytest tests/test_status.py::test_json_types` passes                                | MUST     |
| AC3 | Default `logtail status` output is byte-identical to before                   | `pytest tests/test_status.py::test_table_unchanged` passes                           | MUST     |
| AC4 | `--json` appears in `logtail status --help`                                   | `logtail status --help \| grep -q -- --json`                                         | SHOULD   |

Rules that make a criterion hold up:

- **Verification is a command, a URL, or a named test.** "Verify it works" is not a verification step; `pytest tests/test_rotation.py::test_reopen_on_rename` is. "Inspect the diff" and "review the code" are not steps either — a human reading is not something the validator can run. When the check really is about source content, make it a search: `grep -rn "timingSafeEqual" src/` returns a hit.
- **At least one MUST.** `MUST` blocks completion; `SHOULD` and `NICE` do not.
- **Three minimum.** Fewer and the planner invents the rest, and invented criteria are the ones that get rubber-stamped.
- **Name tests that do not exist yet.** Writing `AC2 → tests/test_status.py::test_json_types passes` commissions that test and gives the verifier something exact to run.
- **State the observable, not the implementation.** "Returns 400 with `{error: 'Invalid email format'}`" beats "validates the email properly."

## Making Verification Cheap and Trustworthy

Name the repo's real entry points — `npm test`, `pytest`, `cargo test`, `make check`, whatever the project actually uses. Zeroshot's validators begin by reading the repo's context files to discover these, and reject when they fail.

For commands expensive enough that you do not want each agent paying for them,
declare a command proof. Each entry becomes a **required handoff gate**: on
`--pr` and `--ship`, the git-pusher refuses to push until that gate has fresh
passing evidence.

````
```zeroshot-command-proofs
[
  { "id": "unit-tests", "profile": "node-test", "command": "npm test", "scope": "repo", "description": "Full unit suite" },
  { "id": "typecheck", "profile": "node-test", "command": "npm run typecheck", "scope": "repo" }
]
```
````

`id`, `profile`, and `command` are all mandatory. Only the first such block in
the file is read, and malformed JSON aborts the run before any agent starts — so
if you include one, check that it parses.

Details on gates and evidence: `references/verification.md`.

## Two Defaults Worth Knowing

**Backwards compatibility is rejected unless requested.** Zeroshot's validators
reject deprecation shims, re-exports, legacy fallbacks, `_unused` parameter
renames, and feature flags that toggle old versus new behavior. When you want
the old path kept, say so explicitly and say why:

> The existing `compareTokens` helper stays exported and unchanged; four other modules still call it and migrating them is a separate change.

**Scope is one session.** The executor implements, verifies, and stops. Steps
that wait, deploy, monitor over time, or observe production are outside what any
agent can complete, and a spec containing them ends with unfinished work. End at
"ready to deploy."

## Phrases That Cause Rejection

Zeroshot's validators reject on sight: `TODO`, `FIXME`, placeholder, "phase 2",
"future work", "will add tests later", "deferred". Writing them into the spec
invites the executor to echo them back into the code, where they become the
rejection.

Say the same thing as a boundary instead. Not "phase 2: migrate the other
callers" but:

> Out of scope: the other four call sites of `compareTokens`. Leave them untouched.

## Quick Reference

| Symptom of a weak spec                            | Fix                                                          |
| ------------------------------------------------- | ------------------------------------------------------------ |
| Verifier approved work that does not function     | Acceptance criteria had no runnable verification column      |
| Run used 2 validators on a security change        | No classification anchor; the risk category was never stated |
| Executor stopped at 60% with "remaining work"     | Spec contained phased or deferred language                   |
| Verifier rejected a deliberate compatibility shim | Compatibility was wanted but never stated as an exception    |
| Task body came out as a file path                 | File was not named `.md`                                     |
| PR title was `my-task`                            | No `# H1` in the file                                        |
| Run aborted before any agent started              | Malformed JSON in the command-proofs block                   |

## Common Mistakes

**Pasting the whole ticket.** Issue trackers carry discussion, reversals, and
dead ends. The executor cannot tell a rejected proposal from the decision. State
the decision.

**Describing implementation instead of outcome.** "Use a `Map` keyed by inode"
constrains the executor without giving the verifier anything to check. "Detects
rotation and resumes within one poll interval" does both.

**Acceptance criteria that restate the title.** `AC1: the --json flag works` is
the request, not a criterion. What does working look like from outside?

**Silence about the risky part.** The conductor sizes the workflow from what you
wrote. An unmentioned auth change gets a routine workflow.

**Assuming the verifier read the executor's notes.** It did not. Anything the
verifier must know belongs in the spec.
