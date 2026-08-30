# <Imperative title, PR-quality: "Add --json output to logtail status">

<Scope line: file count, behavior change yes/no, and whether the change modifies
authentication logic, billing calculations, secrets, destructive database
operations, production deployment, or PII. One sentence.>

## Context

<What exists today and why it is wrong. Two to five sentences. Name the
subsystem and the entry point; do not paste code. For a bug, lead with the
observed failure and its trigger, then the expected behavior.>

## Required behavior

1. <Observable statement a verifier can trigger and watch.>
2. <Another. State outcomes, not implementation choices.>
3. <Include the edge case that makes this non-trivial.>

## Acceptance criteria

| ID  | Criterion            | Verification                               | Priority |
| --- | -------------------- | ------------------------------------------ | -------- |
| AC1 | <Observable outcome> | <Exact command, URL, or `path::test_name`> | MUST     |
| AC2 | <Observable outcome> | <Exact command>                            | MUST     |
| AC3 | <Observable outcome> | <Exact command>                            | SHOULD   |

<Minimum three. At least one MUST. Naming a test that does not exist yet
commissions it.>

## Verification

Run and pass:

```bash
<the repo's real commands: pytest / npm test / cargo test / make check>
<the repo's real lint or typecheck command>
```

```zeroshot-command-proofs
[
  { "id": "unit-tests", "profile": "<profile>", "command": "<expensive command>", "scope": "repo", "description": "<what it proves>" }
]
```

<Delete the proofs block if no command is expensive enough to cache. If kept,
verify the JSON parses — malformed JSON aborts the run. Each entry becomes a
required handoff gate under --pr and --ship.>

## Out of scope

- <Boundary, present tense: "The other four call sites stay untouched.">
- <Another boundary.>

<If backwards compatibility is wanted, state it here as an explicit exception
and give the reason — validators reject compatibility shims by default.>

## Notes for the verifier

<Checks beyond the criteria table: what to confirm independently, what a passing
test suite would not catch. Delete if there is nothing to add.>
