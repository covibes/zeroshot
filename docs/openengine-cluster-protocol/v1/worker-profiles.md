# Worker profiles v1

Worker references in graph documents are stable identities such as `reviewer@1`. Before admission,
the backend resolves every reference through `WorkerRegistry` to a fully pinned descriptor. There is
no latest-version lookup. The descriptor fixes its protocol/profile version, allowed graph profiles,
input/output/verifier types, closed errors, strict autonomy policy, artifact result constraints, and
opaque credential handles.

Every descriptor declares the complete runtime error algebra in canonical form: `timeout`, `crash`,
`malformed`, and `refusal`. A descriptor cannot omit an error that strict-autonomy normalization may
emit. Verifier completions are distinct from ordinary completions: their output, complete signal map,
labels, diagnostic payload, and artifact receipts are all validated before a durable verifier outcome
is produced; any mismatch becomes `malformed`.

Normalized error pairs are closed. Declared worker failures use `declared_failure` with one of the
four error codes. Policy denial, interactive input, and authentication requirements use `refusal`
with their matching reason. Rejected output, signal, diagnostic, or artifact data uses `malformed`
with `malformed_result`. Rust serialization/deserialization and JSON Schema reject every other pair.

## Portable bindings

| Protocol        | Version | Profile                        | Scope                                                                                            |
| --------------- | ------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| ACP             | `1`     | `openengine.worker.acp/v1`     | Testkit mock conformance only                                                                    |
| A2A             | `1.0`   | `openengine.worker.a2a/1.0`    | Testkit mock conformance only                                                                    |
| Legacy Zeroshot | `1`     | `legacy.zeroshot.ship/v1`      | Reserved future facade contract                                                                  |
| Builtin         | `1`     | `openengine.worker.builtin/v1` | Protocol-owned binding for native in-process built-ins; no product IDs, commands, or credentials |

The ACP and A2A mock normalizers are deterministic fixtures. They add no sockets, subprocesses,
SDKs, discovery, network transport, callbacks, or production protocol runtime. Permission denial,
ACP input requests, and A2A `input-required`/`auth-required` states immediately return the typed
`refusal` worker error. Malformed results return `malformed`; rejected raw values are not retained.
`refusal` remains selectable by graph control flow through `ControlSource::Error`.

## Compatibility

The reusable pre-admission check traverses steps and verifiers in source order and applies:

1. Graph input is a subtype of the descriptor input.
2. Descriptor output is a subtype of the graph output.
3. Descriptor verifier signal fields and labels are subsets of graph declarations; its diagnostic
   is a subtype of the graph diagnostic.
4. The descriptor identity is the exact requested `WorkerRef` and allows the graph profile.
5. Step nodes resolve only to non-verifier descriptors, and verifier nodes only to descriptors with
   a verifier contract.

The check returns deterministic diagnostics. It does not admit, persist, schedule, or execute a
graph.

## Reserved `legacy.zeroshot.ship@1`

The reserved worker is allowed only in `openengine.graph.single-worker/v1`. Its input selects exactly
one source: a nonempty issue reference, a nonempty prompt, or one or more `ArtifactRef` receipts.
Isolation and provider selections are opaque registry-owned profile references. The request has no
commands, endpoints, environment names, filesystem paths, raw credentials, tokens, or arbitrary
provider configuration.

Its terminal output contains only a summary, normalized `succeeded`/`failed` status, and zero or more
durable `ArtifactRef` receipts. Errors are the closed worker errors: `timeout`, `crash`, `malformed`,
and `refusal`. The descriptor is valid only when its declared input and output equal these canonical
payload types and it declares no verifier contract. The executable Node facade and raw logs/output
are outside this contract.

## Artifact results

Artifact results are durable, hash-addressed receipts. Every receipt contains `artifactId`, `sha256`,
`byteLength`, `mediaType`, `typeId`, `producer`, `lineage`, and `redaction`. Bytes, filesystem paths,
download locations, URLs, signed URLs, and credentials stay outside the runtime protocol.
