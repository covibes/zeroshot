---
name: zeroshot-task-review
description: Use when a Zeroshot task or plan file has been drafted and needs checking before `zeroshot run`, when reviewing someone else's Zeroshot spec, or when deciding whether a task file is ready to hand to Zeroshot.
license: MIT
metadata:
  author: the-open-engine
  version: '1.0'
---

# Reviewing Zeroshot Task Specs

## Overview

A Zeroshot spec fails in ways that only show up an hour into a run: a criterion
nothing can check, an unstated risk that bought the cheap workflow, a deferred
clause the executor echoes into the code. All of them are visible in the file
beforehand.

**Core principle: audit for what a verifier cannot check, not for what reads well.**
Fluent prose is the common failure mode — a spec can be well written and still
give the verifier nothing to run.

For the authoring rules and the mechanics behind each check, use the
`zeroshot-task-spec` skill.

## Your Output

A review is three parts, in this order:

1. **Verdict** — `READY` or `NOT READY`, on the first line, with the count of blocking issues.
2. **Blocking issues** — one line each: the location, what is wrong, and the concrete replacement text. No issue without a replacement.
3. **Rewritten acceptance criteria table** — the full corrected table, ready to paste.

Skip parts 2 and 3 when the verdict is `READY`. Do not restate the spec, do not
summarize what the task does, and do not list what the spec got right.

## Blocking Checks

Each of these makes a run measurably worse. Any one of them means `NOT READY`.

**Acceptance criteria**

- Fewer than three criteria.
- No criterion marked `MUST`.
- Any criterion whose verification is not a runnable command, a URL, or a named test. "Verify it works", "confirm the behavior", "manual check", "inspect the diff", and "review the code" all qualify as unrunnable. A source-content check becomes runnable as a `grep`.
- Criteria written as `- [ ]` checkboxes rather than a table with id, criterion, verification, and priority columns.
- A criterion that restates the title instead of naming an observable outcome.

**Classification**

- No sentence stating file count, whether behavior changes, and whether the change contacts authentication logic, billing calculations, secrets, destructive database operations, production deployment, or PII.
- The change modifies one of those six but the spec does not say so. This is the highest-cost defect: the conductor's tie-break runs toward the cheaper workflow, so the risky change gets routine verification.
- A bug fix whose title and opening describe a proposed solution rather than the observed failure, which routes it away from the debug workflow.

**Language**

- Contains `TODO`, `FIXME`, placeholder, "phase 2", "future work", "will add tests later", or "deferred". Validators reject these on sight, and the executor tends to echo them into the code.
- Steps that wait, deploy, monitor over time, or observe production. Nothing in a single session can complete them.

**Mechanics**

- Filename is not `.md` or `.markdown`. The path string becomes the task body instead of the file.
- No `# H1`, or more than one plausible title heading. The first H1 becomes the cluster and PR title.
- The document is wrapped in a ` ```markdown ` fence.
- A `zeroshot-command-proofs` block whose JSON does not parse, or whose entries are missing `id`, `profile`, or `command`. Malformed JSON aborts the run before any agent starts.

**Verification**

- No named test or build command from the repo. Validators discover commands from repo context files; naming them removes the guess.
- Backwards compatibility is implied by the requirements but never stated as an explicit exception. Validators reject compatibility shims by default.

## Advisory Checks

Worth raising, not worth blocking on: a criterion that constrains implementation
rather than outcome; pasted ticket discussion carrying reversals or dead ends; a
"notes for the verifier" section that only restates the criteria table; an
expensive command run by several agents with no command proof declared.

## Worked Example

Draft criterion:

> - [ ] Rotation handling works correctly

Review output:

```
NOT READY — 3 blocking issues

- Acceptance criteria: checkbox list, no id/verification/priority columns. Replace with the table below.
- AC "rotation handling works correctly": no runnable verification and restates the title. Split into rename-rotation and truncate-rotation criteria, each naming its test.
- Scope line missing: add "Touches 2 files in the follow code path, changes user-visible behavior, does not modify authentication logic, billing math, secrets, destructive database operations, production deployment, or PII."

| ID | Criterion | Verification | Priority |
|----|-----------|--------------|----------|
| AC1 | After `mv app.log app.log.1` and recreating `app.log`, new lines appear in output | `pytest tests/test_follow.py::test_reopen_on_rename` passes | MUST |
| AC2 | After in-place truncation, reading resumes from offset 0 with no re-emitted lines | `pytest tests/test_follow.py::test_resume_on_truncate` passes | MUST |
| AC3 | Lines written immediately before rotation are emitted before reopening | `pytest tests/test_follow.py::test_no_tail_loss` passes | MUST |
| AC4 | Handle count does not grow across ten rotations | `pytest tests/test_follow.py::test_no_fd_leak` passes | SHOULD |
```

## Common Mistakes in Reviews

**Approving fluent prose.** Long, well-organized specs fail these checks as
often as terse ones. Read the verification column, not the paragraphs.

**Flagging an issue without a replacement.** "AC2 is vague" sends the work back
without moving it. Write the corrected criterion.

**Rewriting the whole spec.** The author chose the scope and approach. Fix what
blocks verification and leave the rest.

**Missing the unstated risk.** Read the required behavior and ask what it
actually modifies, then check whether the spec says so. A spec can be internally
consistent and still under-declare its risk.
