# How Zeroshot Sizes a Task

Before any work begins, a conductor agent reads the task text and classifies it
on two dimensions. The result decides which agents load, how many validators
run, and which model tier they use. Nothing else in the run reconsiders it.

## Complexity

| Value       | Definition in the rubric                                            | Validators         |
| ----------- | ------------------------------------------------------------------- | ------------------ |
| `TRIVIAL`   | One file, mechanical change, no behavior change                     | 0                  |
| `SIMPLE`    | Small change, 1-2 files, low risk                                   | 1                  |
| `STANDARD`  | Multi-file work or user-visible behavior. **The declared default.** | 2                  |
| `CRITICAL`  | Directly modifies one of the six categories below                   | Two-stage pipeline |
| `UNCERTAIN` | Escalates to a stronger conductor                                   | —                  |

The six `CRITICAL` categories, as written in the rubric:

1. Authentication / authorization **logic**
2. Payment processing / billing **calculations**
3. Secrets / credentials handling
4. Destructive database operations (`DROP`, `DELETE`)
5. Production deployment or live infrastructure
6. PII processing (not merely displaying it)

The rubric carries an explicit downward bias: when torn between `STANDARD` and
`CRITICAL`, it picks `STANDARD`, on cost grounds. It also lists false positives
that stay `STANDARD` — refactoring code that _mentions_ auth or billing, adding
types to existing structures, cleanup in infra-adjacent files, read-only queries
against production, tests for auth or billing code, extracting modules, and
config reorganization.

The distinction is **modifying the logic versus living near it**. A spec that
says "refactor the auth service into smaller modules" classifies as `STANDARD`.
A spec that says "change how the session token is compared" classifies as
`CRITICAL`. If the change really does alter one of the six, name the specific
operation rather than the subsystem.

## Task Type

| Value     | Meaning                           |
| --------- | --------------------------------- |
| `INQUIRY` | Questions, exploration, read-only |
| `TASK`    | Implement something new           |
| `DEBUG`   | Fix something broken              |

`DEBUG` at anything above `TRIVIAL` loads a different agent graph entirely —
investigator, then fixer, then tester — instead of the planner/worker/validator
shape. Lead a bug report with the failure, not with the proposed fix, so it
classifies as `DEBUG` rather than as a feature request.

## Routing

| Classification                       | Workflow           |
| ------------------------------------ | ------------------ |
| `DEBUG` and not `TRIVIAL`            | `debug-workflow`   |
| `TRIVIAL`, in PR mode, not `INQUIRY` | `worker-validator` |
| `TRIVIAL`                            | `single-worker`    |
| `SIMPLE`                             | `worker-validator` |
| `STANDARD` or `CRITICAL`             | `full-workflow`    |

Model tier follows complexity: `level1` for `TRIVIAL`, `level3` for the planner
on `CRITICAL`, `level2` otherwise. Context budget per agent runs 50k tokens at
`TRIVIAL`, 100k at `SIMPLE` and `STANDARD`, 150k at `CRITICAL`.

## Writing the Anchor

State the three signals the rubric keys on — file count, behavior change, and
high-risk contact — in one sentence near the top:

> Touches 2 files in the `follow` code path, changes user-visible behavior, and does not modify authentication logic, billing math, secrets, destructive database operations, production deployment, or PII handling.

For a change that does contact a category:

> Modifies the session token comparison in the auth middleware — this is authentication logic, and the change is to the comparison itself, not to surrounding code.

For a small mechanical change, saying so buys a cheaper, faster run:

> Single file, mechanical rename of an internal helper, no behavior change.

## Aiming Deliberately

**To get more verification:** name the specific high-risk operation being
changed. Vague risk language does not raise the classification; the rubric was
written to discount it.

**To get less ceremony:** state the file count and that behavior does not
change. Both are explicit rubric conditions for `TRIVIAL` and `SIMPLE`.

**To reach the debug workflow:** describe the observed failure — the symptom,
the trigger, the expected behavior — before any hypothesis about the cause.
