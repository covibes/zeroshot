# What Zeroshot's Verifiers Demand

Validators run read-only, in their own sessions, without the executor's
reasoning. They are instructed to search before claiming something is missing,
to run commands rather than read them, and to record evidence. A spec earns a
trustworthy verdict by telling them exactly what to run.

## The Evidence Standard

Every validator returns structured output, and the requirements validator
records one result per acceptance criterion:

```json
{
  "approved": false,
  "summary": "AC2 fails: numeric fields serialized as strings",
  "errors": ["AC2: size emitted as \"1024\" not 1024"],
  "criteriaResults": [
    {
      "id": "AC1",
      "status": "PASS",
      "evidence": { "command": "logtail status --json | jq .", "exitCode": 0, "output": "{...}" }
    }
  ]
}
```

`evidence` is required for every `PASS` and `FAIL`, and it must be actual
command output. `CANNOT_VALIDATE` is reserved for a missing tool, absent
network, or denied permission — and it is treated as a pass with a warning. A
criterion whose verification step names no command is a criterion that lands in
`CANNOT_VALIDATE` and quietly passes.

That is the mechanism behind the core rule: **an acceptance criterion without a
runnable verification step is an acceptance criterion that cannot fail.**

## What Each Validator Checks

| Validator    | Focus                                           | What satisfies it                                        |
| ------------ | ----------------------------------------------- | -------------------------------------------------------- |
| requirements | Every acceptance criterion                      | Per-criterion command output; any failing `MUST` rejects |
| code         | Logic errors, leaks, duplication, god functions | Reading the diff; grep for repeated patterns             |
| tester       | Tests actually execute                          | Real test output, not test source                        |
| security     | Injection, authz, secrets, OWASP                | Repo validation script plus review                       |

The tester validator is explicitly told that reading test code is not
verification, and that "tests look correct" is unacceptable where "15/15
passing" is. It discovers the test command from the repo's own context files
rather than assuming one. Naming the command in the spec removes the guess.

Skipped tests — missing env vars, absent services, no credentials — are recorded
as warnings, not failures. If a criterion can only be checked with credentials
the run will not have, it will not actually be checked.

## Generalization and Root Cause

Several validators apply the same two tests to any fix:

- **Generalization.** If the executor fixed one instance of a pattern, they grep
  for the pattern. More instances left unfixed means rejection.
- **Root cause.** Workarounds that mask the underlying bug are rejected, as are
  "restart the service", "clear the cache", "works on my machine", and blaming
  the test without proof.

For a bug fix, state explicitly whether other instances exist and whether they
are in scope:

> The same unchecked-rotation pattern appears only in `follow`. `cat` mode reads once and exits, so it is unaffected.

## Command Proofs

A command proof puts a signed, content-addressed cache in front of an expensive
command so the agents in a run pay for it once instead of each. Declare proofs
in the spec with a fenced block:

````
```zeroshot-command-proofs
[
  {
    "id": "unit-tests",
    "profile": "node-test",
    "command": "npm test",
    "scope": "repo",
    "description": "Full unit suite"
  }
]
```
````

`id`, `profile`, and `command` are mandatory; entries missing any of them are
dropped. `scope` and `description` are optional. Only the first block in the
document is read. Malformed JSON aborts the run before any agent starts.

Agents are then instructed to run `zeroshot cmdproof check <id>` in place of the
raw command and to treat its exit code as the command's exit code.

Proofs can also live in `<gitRoot>/.zeroshot/settings.json` under
`ship.commandProofs`. Spec-declared proofs merge on top of configured ones
rather than replacing them, so a spec can add a gate without disturbing repo
defaults.

## Required Handoff Gates

Every declared command proof becomes a required quality gate. Under `--pr` and
`--ship`, the git-pusher refuses to push until each gate has evidence that is
present, passing, and fresh. It blocks when:

| Condition                                         | Result  |
| ------------------------------------------------- | ------- |
| No matching gate reported                         | blocked |
| `status` is not `PASS`                            | blocked |
| `evidence.command` missing or empty               | blocked |
| `evidence.exitCode` is not `0`                    | blocked |
| `evidence.output` is not a string                 | blocked |
| Marked `stale: true`                              | blocked |
| No completion timestamp                           | blocked |
| Evidence predates the last implementation handoff | blocked |

Gates match on exact `id`, and on `scope` when the requirement declares one. A
validator that cannot run a gate must report `UNAVAILABLE` and withhold
approval — an unavailable gate blocks rather than passing.

With no validators and no gates configured, the pusher proceeds unconditionally.
That combination is worth avoiding on anything headed for a PR.

## Writing for the Verifier

The full spec text reaches every validator, so a section addressed to them
lands. Use it for the checks that matter beyond the criteria table:

> Independently confirm that `--json` did not leak onto other subcommands, and that the diff touches only the status code path and its tests.

Keep it to genuine verification instructions. Restating the acceptance criteria
here costs context without adding a check.
