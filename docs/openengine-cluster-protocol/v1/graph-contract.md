# Cluster Protocol v1 graph contract

This document is normative together with the public Rust types in
`openengine-cluster-protocol`. The Rust types are authoritative when generated projections and
prose disagree.

Cluster Protocol v1 defines two profiles:

| Profile       | Wire identifier                     |
| ------------- | ----------------------------------- |
| Full graph    | `openengine.graph.full/v1`          |
| Single worker | `openengine.graph.single-worker/v1` |

`openengine-cluster-server::graph_verifier::ProductionGraphVerifier` is the reusable production
semantic verifier for the full-graph profile. It consumes the authoritative `GraphSpec`, resolves
workers through `WorkerRegistry`, and returns the authoritative `CompiledGraphIr` with proven
`StructuralBounds`. Parsing, schema validation, fixture round trips, direct construction of
`CompiledGraphIr`, and canonical hashing alone are not verification or admission. The verifier
does not admit, store, schedule, or execute graphs; `ScriptedVerifier` remains a test-only admission
fixture. The protocol methods and advertised backend capabilities remain separate concerns.

## Graph wire format

`GraphSpec` has the required camel-case fields `profile`, `initialInput`, `policy`, and `root`.
Every graph node is tagged by `kind`. Node payloads reject unknown fields.

| `kind`     | Contract                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`     | Stable name and versioned worker reference; optional bounded authored instructions; declared input/output types and bindings; positive bounds |
| `verifier` | The bounded worker surface plus optional bounded authored instructions, named finite-enum signals, and a declared diagnostic type             |
| `seq`      | Declared state, non-empty ordered children, promoted state paths                                                                              |
| `choice`   | Declared state, non-empty authored-order guarded branches, optional `otherwise`, promoted paths                                               |
| `par`      | Declared state, non-empty branches, promoted paths, and a tagged join                                                                         |
| `loop`     | Declared state, body, structured `until`, positive `maxIterations`, promoted paths; syntactically do-while                                    |
| `map`      | Declared state, body, structured array selector `over`, positive `maxItems`, promoted paths                                                   |
| `succeed`  | Declared output type and structured state-to-output bindings                                                                                  |
| `fail`     | Finite-enum reason; `unhandled` is reserved for a future compiler's implicit sink                                                             |

Parallel joins are `all`, `any`, `quorum { count }`, or `first { when }`. The closed worker error
channel is `timeout`, `crash`, `malformed`, and `refusal`. Choice reachability/exhaustiveness, loop
exit satisfiability, selector typing, dominance, promotion safety, and structural folds are
production-verifier responsibilities, not parser claims. `timeoutMs` accepts exactly the
`PositiveInteger` wire range; the verifier imposes no superseded 24-hour product ceiling.
Normal-success continuation requires every branch for `all`, one branch for `any`/`first`, and
`count` branches for `quorum`. Quorum flow and promotion guarantees range over every valid
size-`count` completing branch set. A set is valid only when its branch-completion predicates are
jointly satisfiable under one legal control assignment; branches guarded by mutually exclusive
outcomes never fabricate a completion set. Quorum one behaves as alternatives, while quorum over
every branch carries the same completion guarantees as `all`. For `all`, `any`, and `quorum`,
`joined=reached|quorum_unreachable` is correlated with that required-completion predicate;
assignments combining `reached` with an unsatisfied predicate or `quorum_unreachable` with a
satisfied predicate are not legal control assignments. Inside a map, this correlation is applied
to each item's joint join/branch-control outcome before `k_of_map` aggregates label counts.
For `first`, a winning branch must complete, guarantee the controls read by `when`, and make
`when` true. The `raced=satisfied|no_satisfier` control is correlated with those legal winner
assignments; a non-satisfying completion cannot contribute promotion guarantees.

## Data and control separation

No selector or guard is source text. `DataSelector` is tagged by `source` and reads only a bounded,
non-empty `FieldPath` from `state` or the current map `item`. An input binding has an explicit target
path and data selector. A write binding has an explicit target and a `NodeOutputSelector` naming a
node, the closed channel `out`, `signal`, or `diagnostic`, and a field path.

V1 has no whole-payload binding: executable inputs and `succeed` outputs must be `null` or records
that bindings can construct through non-empty field paths. Scalar, enum, and array payloads remain
valid elsewhere in the closed algebra and as nested record fields; they are not implicitly copied
or defaulted at a payload root.

Control guards use a separate AST and cannot contain `DataSelector`:

| `kind`       | Fields                                                         |
| ------------ | -------------------------------------------------------------- |
| `in`         | One `ControlSelector` and a non-empty enum-label set           |
| `all`, `any` | Non-empty guard lists                                          |
| `not`        | One guard                                                      |
| `k_of_n`     | Positive count, non-empty finite selector list, enum-label set |
| `k_of_map`   | Positive count, one bounded group selector, enum-label set     |

A `ControlSelector` names a node/group, a closed source (`signal`, `error`, or `group`), and an
optional field. JavaScript, JSONPath, regular expressions, commands, endpoints, environment
variables, credentials, provider secrets, and free-form expressions are not fields in this AST.
Unknown-field rejection prevents them from being smuggled into otherwise valid nodes.

## Stable references and policies

Workers and policies are references of the form `name@positiveVersion`. Graphs cannot represent a
typed command, executable path, endpoint, credential, bearer token, environment value, inline
permission, or provider secret. Executable `instructions` are opaque prompt guidance and grant no
runtime authority. A policy binding contains one versioned policy reference and the only v1
default, `deny`. Registry descriptors and policy implementations are outside this contract.

## Closed payload algebra and subtyping

`PayloadType` is tagged by `kind` and is closed over `null`, `boolean`, `integer`, `number`,
`string`, structural `record`, homogeneous `array`, and finite `enum`. A record maps field names to
`{ type, required }`. Enum labels are non-empty, unique, sorted, and finite. The algebra contains no
unions, references, definitions, tuples, custom schema keywords, regex constraints, or arbitrary
JSON Schema.

For source type `S` and target type `T`, `S <: T` is exactly:

| Source and target            | Rule                             |
| ---------------------------- | -------------------------------- |
| Equal primitive kinds        | Yes                              |
| `integer` to `number`        | Yes                              |
| Any other primitive widening | No                               |
| `array<S>` to `array<T>`     | Exactly when `S <: T`            |
| Enum `S` to enum `T`         | Every label in `S` occurs in `T` |
| Record `S` to record `T`     | Width and depth rules below      |

For records, every required field of `T` must exist as required in `S`, and its value type must be a
subtype. An optional field of `T` may be absent from `S`; if present, its value must subtype the
target value. A required source field may satisfy an optional target field. An optional source field
never satisfies a required target field. Extra source fields are allowed. The relation is recursive,
deterministic, side-effect free, and never delegates to general JSON Schema evaluation.

## Production full-v1 verification

The verifier runs deterministic synchronous structural and semantic passes before accessing the
worker registry. Any structural diagnostic prevents registry lookup. Worker absence, unavailable
versions, descriptor mismatch, profile mismatch, verifier-contract mismatch, and schema
incompatibility are graph rejections. Internal errors are reserved for impossible invariant or
compiled-IR construction failures after successful validation.

Selectors use closed finite domains: verifier signals use their declared labels; worker errors are
`timeout|crash|malformed|refusal`; loop `terminated` is `converged|exhausted`; map `overflow` is
`ok|overflow`; `all|any|quorum` parallel `joined` is `reached|quorum_unreachable`; and `first`
parallel `raced` is `satisfied|no_satisfier`. Choices are first-true in authored order and are
checked over the bounded legal control space. An `otherwise` alternative is rejected as unreachable
when earlier branches cover that space and does not participate in flow analysis. Loops are
do-while and their exit guard must use a verifier guaranteed to execute on every iteration.
Signal and error controls from one executable are mutually exclusive outcomes. Map aggregates
count joint per-item outcomes, so one mapped execution cannot contribute both a success signal and
an error. They also preserve per-item execution flow: guaranteed sequential successors,
descendants of a full-completion parallel, and do-while body descendants must emit one success or
error outcome. A conditional successor emits an outcome exactly when its first-true choice residual
selects that route. For a promoted map path `p: array<T>`, a body write to `p` writes one `T` at the
current input index; indexed values are collected in input order. The promotion is total, so an
empty selected input defines `p` as `[]`, but the promoted array retains each mapped executable's
success/error provenance until control excludes every mapped runtime error. Choice residual
assignments determine channel availability:
`out`, `signal`, and `diagnostic` are unavailable on every reaching error path, while terminal
alternatives do not contaminate later fall-through flow. Every `k_of_n`/`k_of_map` label must belong
to the applicable closed selector domains. Executable write bindings are success-outcome effects:
an output-backed optional state path remains undefined while that executable's runtime-error
outcomes can reach the reader. A residual branch that excludes every runtime error makes the write
definite. State promotion preserves this outcome provenance and cannot turn a conditional write
into a definite one. Definition flow retains exact path/type guarantees from required initial input
through nested group-state widening. A descendant write invalidates stale ancestor refinements.
Parallel promotions remain conditional until a `reached` or `satisfied` residual excludes the
group failure outcome; unguarded continuation cannot consume success-only branch writes.
Conditional ownership is target-granular across nested parallel groups, choice merges, and later
sequential writers. Parallel failure labels `quorum_unreachable` and
`no_satisfier` restore the incoming pre-par definitions and expose no winner or branch-promotion
data. After successful routing, a binding defines its target only when the selected output or
diagnostic path is required; writing a required record defines only its required descendants, never
optional descendants.

Full-v1 has fixed protocol-version ceilings:

| Bound                         | Maximum |
| ----------------------------- | ------: |
| Graph nodes                   |   4,096 |
| Graph depth                   |      64 |
| Guard nodes                   |   4,096 |
| Assignments per finite check  |  65,536 |
| Loop iterations               |     100 |
| Map items                     |   1,024 |
| Attempts per executable node  |     100 |
| One-run executable node count |  65,536 |
| Total loop-body entries       |  65,536 |
| Peak concurrency              |   1,024 |

All structural arithmetic is checked. Authored values, computed folds, and arithmetic overflow
above a ceiling produce `ceiling_exceeded` at the narrowest combining node or field. These bounds
are public constants beside `ProductionGraphVerifier`; they are not backend configuration or
product policy. `missing_bound` is reserved for a future typed graph form that can omit a required
proof bound.

Only `step` and `verifier` count as executions. Sequence sums executions, choice takes the maximum,
parallel sums, map multiplies by `maxItems`, and loop multiplies by `maxIterations`. Parallel and
map multiplication determine peak concurrency; loop body concurrency is unchanged. Loop-entry
folds use sum for sequence/parallel, maximum for choice, map multiplication, and
`maxIterations * (1 + bodyLoopEntries)` for loops. Attempts are recorded per executable and do not
multiply the one-run execution bound. Loop-free graphs receive a stable reference-topological
acyclic witness; graphs with loops receive deterministic outer-to-inner ranking identifiers.

## Diagnostics, bounds, and artifact receipts

Verifier output uses structured `GraphDiagnostic` values. Severity and diagnostic code are
closed enums. Paths are arrays of field, index, or node segments, never JSONPath strings. V1 codes
cover schema safety, reachability, choice exhaustiveness, loop exit satisfiability, missing bounds,
write conflicts, ceiling excess, cyclic references, undefined reads, and invalid graph shape.

`StructuralBounds` carries a termination witness, positive maximum node executions, positive peak
concurrency, and positive per-node attempt ceilings. A termination witness is either an acyclic node
order or a bounded structural ranking with positive maximum iterations.

`ArtifactRef` is a durable receipt containing only:

- opaque `artifactId`;
- lowercase 64-hex `sha256`;
- JavaScript-safe `byteLength`;
- `mediaType` and stable `typeId`;
- producer node and worker reference;
- generation, run ID, and positive attempt lineage;
- `public`, `internal`, `confidential`, or `restricted` redaction class.

Artifact bytes, inline payloads, filesystem paths, signed URLs, bearer tokens, and credential
material are deliberately unrepresentable.

## Canonical compiled IR and identity

`CompiledGraphIr` contains the profile, initial input type, policy binding, root, and proven
structural bounds. Canonical bytes are compact UTF-8 JSON after these transformations:

- object/map keys, record fields, bindings, signal names, enum labels, policy/set-like collections,
  promoted paths, and other semantically unordered collections are sorted; binding and `k_of_n`
  selector multiplicity is preserved;
- commutative `all`/`any` operands are recursively flattened, sorted, and deduplicated;
- parallel branches are sorted by stable node name;
- sequence child order, choice branch order, loop/map body structure, and every semantic order are
  preserved;
- optional/default fields are serialized explicitly;
- floats and non-finite values are absent from and rejected by the closed IR algebra.

`GraphIdentity` is lowercase hexadecimal SHA-256 over exactly those canonical bytes. Equivalent IR
built with different map, set, guard, binding-order, or parallel insertion order has the same
identity. Changing semantic sequence order, authored instructions, a payload type, bound, worker
reference, policy reference, binding content or multiplicity, or `k_of_n` selector multiplicity
changes the identity.

## Generated conformance vectors

`graph.schema.json` is rooted at `GraphSpec`; `compiled-ir.schema.json` is rooted at
`CompiledGraphIr`. OpenRPC exposes these and the graph diagnostic, bounds, and artifact component
schemas, but adds no future protocol method. Files under
`protocol/openengine-cluster/v1/fixtures/graph/` are deterministic syntax/canonicalization vectors.
Their Rust parser and JSON Schema checks are fixture validation only. Exact production-verifier
success and rejection envelopes live under `protocol/openengine-cluster/v1/fixtures/verifier/` and
are generated through the reusable server verifier.
