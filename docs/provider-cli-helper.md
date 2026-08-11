# Provider CLI Helper Boundary

Zeroshot owns the CLI coding-agent provider helper. The helper is the shared
invocation boundary for every registry-backed CLI coding-agent provider.
It is not a shared orchestrator.

## Owned Surface

Source lives in `src/agent-cli-provider/`. Build output lives in
`lib/agent-cli-provider/`. The public executable contract is
`zeroshot-agent-provider`, backed by `lib/agent-cli-provider/executable.js`.

The helper owns:

- provider aliases and adapter capability metadata
- single-agent runtime command preparation shared by `zeroshot task run` and
  `zeroshot-agent-provider`
- noninteractive provider command-spec construction
- CLI feature probing
- model-level resolution and provider-specific model validation
- schema enforcement behavior and provider fallback metadata
- JSONL/stdout/stderr parsing into normalized provider events
- retry, permanent, auth, rate-limit, and schema error classification
- credential discovery metadata, redaction metadata, and secret-safe evidence
- golden fixtures and parity tests for the current provider behavior

Live Zeroshot runtime must reach the helper through the compiled runtime bridge
and provider facades:

- `task-lib/provider-helper-runtime.js`
- `src/providers/index.js`
- `src/providers/<provider>/index.js`

Production runtime code must not import `src/agent-cli-provider` directly.
The executable is the only bin entry targeting helper build output.

## JSON Executable Contract

`zeroshot-agent-provider` is a provider-only JSON stdin/stdout executable. It
supports:

- `probe`
- `build-command`
- `parse-output`
- `classify-error`
- `invoke`

It returns typed JSON envelopes with schema version, provider id,
adapter version, warnings, redactions, evidence, result data, and structured
errors. `invoke` normalizes terminal evidence, parsed events, exit status,
signals, timeout data, cleanup results, and redaction metadata.

The executable must never expose Zeroshot cluster, task-store, scheduler,
message-bus, PR/ship, TUI, template, or run-config semantics. It may invoke a
provider CLI. It may not become a general Zeroshot daemon API.

Request payloads must not override provider-owned executable selection:

- no provider binary override
- no argv override
- no executable-resolution env override such as `PATH`, `Path`, `path`, or
  `PATHEXT`
- no process-control env override such as `NODE_OPTIONS`, preload/library path
  variables, or shell startup variables

Adapters own provider binary selection and provider-specific runtime env.
Provider child processes are spawned noninteractively: stdin is closed/ignored,
stdout/stderr are captured for evidence, and timeout/kill-grace behavior remains
owned by the helper runner.

## Orchestra Boundary

Orchestra consumes provider behavior only through the JSON executable contract.
It must not import Zeroshot internals.

Zeroshot keeps these concerns local:

- clusters
- task store
- message bus
- scheduler
- templates
- PR/ship flow
- TUI
- orchestration policy outside provider invocation

Orchestra keeps these concerns local:

- scheduler and replay authority
- proposal admission
- validation authority
- repair policy
- prompt-pack authority
- terminal manifest ingestion
- run completion

The provider helper can be reused as a process boundary, but it does not move
Orchestra authority into Zeroshot and does not make Zeroshot an Orchestra
runtime module.

## Shadow-First Rollout Rule

Provider helper changes must keep behavior proven before runtime rewiring:

1. Add strict TypeScript and helper contract gates for the helper lane.
2. Build helper behavior in shadow with parity fixtures.
3. Expose the JSON executable contract.
4. Hotswap live Zeroshot task execution atomically.
5. Delete old duplicate wrapper/parser/model/recovery paths in the hotswap PR.

Temporary duplication is allowed only while the helper is shadowed or while an
atomic hotswap PR is replacing the old path. Long-term duplicate provider
wrapper implementations are not allowed.

## Implementation Rules

For helper edits:

- use the repo TypeScript guidance
- keep code in full TypeScript with strict helper tsconfigs
- keep provider-specific branching inside adapter/type modules
- use repo-aware code intelligence before multi-file runtime refactors
- use repo-aware bulk edit tooling for repeated import/path rewrites
- keep live runtime access behind the compiled bridge/facades
- do not add `any`, `ts-ignore`, unsafe assertions, or provider-name policy in
  caller code

Required verification for helper changes:

```bash
npm run build:agent-cli-provider
npm run test:agent-cli-provider
npm run typecheck:agent-cli-provider
npm run check:agent-cli-provider
repo-quality check --files src/agent-cli-provider tests/agent-cli-provider
```

For runtime hotswap changes, also run the relevant runtime tests named by the
issue or touched call sites.
