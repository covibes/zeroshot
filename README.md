<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/zeroshot-hero-dark.png">
  <img alt="Zeroshot. Self-driving software engineering. Layer 01 · Verification, The Open Engine." src="docs/brand/zeroshot-hero-light.png" width="100%">
</picture>

&nbsp;

<a href="https://theopenengine.com"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/social/website-dark.png"><img alt="Website" src="docs/brand/social/website-light.png" height="30"></picture></a>
<a href="https://x.com/OpenEngineCo"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/social/x-dark.png"><img alt="X · @OpenEngineCo" src="docs/brand/social/x-light.png" height="30"></picture></a>
<a href="https://www.linkedin.com/company/the-open-engine-company"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/social/linkedin-dark.png"><img alt="LinkedIn" src="docs/brand/social/linkedin-light.png" height="30"></picture></a>
<a href="https://discord.gg/fZyzf2Cut9"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/social/discord-dark.png"><img alt="Discord" src="docs/brand/social/discord-light.png" height="30"></picture></a>

[![npm](https://img.shields.io/npm/v/@the-open-engine/zeroshot?style=flat&labelColor=171411&color=171411)](https://www.npmjs.com/package/@the-open-engine/zeroshot)
[![CI](https://img.shields.io/github/actions/workflow/status/the-open-engine/zeroshot/ci.yml?style=flat&labelColor=171411&label=CI)](https://github.com/the-open-engine/zeroshot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-171411?style=flat)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-171411?style=flat)](#install)
[![platforms](https://img.shields.io/badge/platforms-linux%20%C2%B7%20macos-171411?style=flat)](#install)
[![stars](https://img.shields.io/github/stars/the-open-engine/zeroshot?style=flat&labelColor=171411&color=171411)](https://github.com/the-open-engine/zeroshot)
[![Layer 01 · The Open Engine](https://img.shields.io/badge/Layer_01-The_Open_Engine-C2240C?style=flat&labelColor=171411)](#the-open-engine)

</div>

**The agent that wrote the code shouldn't be the one that says it works.**

Independent executor–verifier orchestration for software changes.

## Install

<!-- install-placeholder -->

```bash
npm install -g @the-open-engine/zeroshot
zeroshot
```

Requires **Node ≥ 22** and one supported provider. Guided setup detects installed providers, chooses a default, and configures worktree isolation for fresh repositories. Linux and macOS today; Windows is deferred.

## First run

```bash
cd your-repo
zeroshot run "Add a --json flag with tests"
```

In a git repository, the guided default runs in a separate worktree, so the current checkout is not edited. Use `--no-isolation` only when you explicitly want the run to modify the current checkout.

Observe the result from another terminal:

```bash
zeroshot list
zeroshot logs <id> -f
```

<div align="center">
  <img src="docs/assets/zeroshot-demo.gif" alt="Zeroshot resolving an issue through the executor-verifier loop" width="760">
  <br>
  <em>Unattended, 100× speed · 90-minute run · 5 iterations to approval.</em>
</div>

## How it works

Zeroshot drives a coding agent through an **executor–verifier loop**. A conductor sizes the workflow, an executor implements the change in an isolated workspace, and a separate verifier judges the observable result. Validators do not share the executor's session or reasoning context; they may receive explicit handoff artifacts and must reproduce reported failures. The loop continues until the change is verified or returns a concrete reason it is not.

Every step is written to a crash-safe SQLite ledger. Bring your own provider and backend: Zeroshot orchestrates their CLIs without storing provider keys.

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/zeroshot-architecture-dark.webp">
    <img alt="One Zeroshot run drawn as a graph: an issue enters, a conductor sizes the cluster, an executor implements it, and validators reject or approve the result" src="docs/assets/zeroshot-architecture-light.webp" width="100%">
  </picture>
  <br>
  <em>One run: classify, execute, verify, and repeat when evidence fails.</em>
</div>

## Providers and issue sources

Provider engines come from the registry: **Claude, Codex, bundled Gateway, Gemini, OpenCode, Pi, OMP, Kiro, and Copilot**. Model gateways stay behind the single Gateway provider.

```bash
zeroshot providers
zeroshot providers set-default codex
zeroshot run 123 --provider gemini
```

Issue sources are auto-detected from repository context or explicit URLs: **GitHub, GitLab, Jira, Azure DevOps, and Linear**. Each source requires its own authenticated client where applicable. See [`docs/providers.md`](docs/providers.md) for provider installation, model levels, and credentials.

## Isolation and delivery

Guided setup defaults fresh repositories to git worktree isolation. Delivery flags cascade: `--ship` implies `--pr`, which implies `--worktree`.

| Mode             | Flag             | Behavior                                            |
| ---------------- | ---------------- | --------------------------------------------------- |
| Git worktree     | `--worktree`     | isolated branch and checkout; guided default        |
| Docker           | `--docker`       | container isolation for riskier workloads           |
| Current checkout | `--no-isolation` | explicit escape hatch; modifies the active checkout |
| Pull request     | `--pr`           | worktree plus PR creation                           |
| Ship             | `--ship`         | worktree, PR, and merge after approval              |

<details>
<summary><strong>Command reference</strong></summary>

```bash
zeroshot run <input>             # issue, URL, markdown file, or inline text
zeroshot run 123 --docker        # container isolation
zeroshot run 123 --pr            # worktree + pull request
zeroshot run 123 --ship          # worktree + PR + merge after approval
zeroshot run 123 --pr --pr-body $'## Summary\n\nCustom text\n\n{{issue_reference}}'
zeroshot run 123 -d              # background run

zeroshot list                    # tasks and clusters (--json)
zeroshot status <id>             # detailed status (--json)
zeroshot logs <id> -f            # stream logs
zeroshot resume <id> [prompt]    # resume a stopped or failed run
zeroshot stop <id>               # graceful stop
zeroshot kill <id>               # force stop

zeroshot providers               # provider availability and defaults
zeroshot settings                # effective settings
zeroshot agents list             # available agents
```

`--pr-body` supplies a deterministic pull-request body for `--pr` and `--ship` runs. The
template supports `{{issue_number}}`, `{{issue_title}}`, and `{{issue_reference}}`; all three
expand to empty text for tasks without an issue, so manual runs never emit `Closes #unknown`.
The unrendered template is retained for detached and resumed runs.

</details>

<details>
<summary><strong>Docker credential configuration</strong></summary>

Docker mounts and environment forwarding are explicit and provider-aware. Defaults include `gh`, `git`, and `ssh`; provider-specific authentication follows the registry contract.

```bash
zeroshot settings set dockerMounts '["gh","git","ssh","aws"]'
zeroshot run 123 --docker --mount ~/.aws:/root/.aws:ro
zeroshot run 123 --docker --no-mounts
```

See [`docs/providers.md`](docs/providers.md) for details.

</details>

## Scope and status

Zeroshot performs best when a task has **clear acceptance criteria**. If you can't say what "done" means, an independent verifier can't confirm it.

| Task                                            | Good fit? | Why                     |
| ----------------------------------------------- | --------- | ----------------------- |
| Add rate limiting (sliding window, per-IP, 429) | Yes       | clear requirements      |
| Refactor auth to JWT                            | Yes       | defined end state       |
| Fix a login bug                                 | Yes       | success is measurable   |
| "Make the app faster"                           | No        | needs exploration first |
| "Improve the codebase"                          | No        | no acceptance criteria  |

- **Pre-1.0 in spirit.** Interfaces still move between releases; pin your version. (The npm version auto-increments on every merge, so read it as a build counter, not a stability promise.)
- **Crash-safe.** All state persists to a SQLite ledger; `zeroshot resume <id>` continues at any time.
- **No TUI in this release.** Monitor with `zeroshot logs <id> -f`, `zeroshot list`, and `zeroshot status <id>`.

<details>
<summary><strong>Architecture, quality gates and command proofs</strong></summary>

Zeroshot is a message-driven coordination layer: a conductor classifies each task by complexity and type, a workflow template selects agents and validators, agents publish results to a SQLite ledger, and validators approve or reject with specific findings.

- **Required handoff quality gates**: in `--pr`/`--ship` flows, the git-pusher fails closed until every configured gate has fresh passing evidence.
- **Cmdproof**: make expensive exact commands reusable across agents with `zeroshot cmdproof check <id>`.

See [CLAUDE.md](./CLAUDE.md) for the cluster schema, primitives, and the conductor's classification model.

</details>

## The Open Engine

Zeroshot is **Layer 01 · Verification** of [The Open Engine](https://theopenengine.com), the open stack for autonomous software production. Generating code is easy; trusting it is not. The engine is layered because trust is layered:

|        | Layer                      | Status                      |
| ------ | -------------------------- | --------------------------- |
| **01** | **Verification: Zeroshot** | This repo · open · shipping |
| 02     | Constraints: **Opcore**    | Sibling · alpha             |
| 03-05  | Intent · Context · Runtime | In development              |

Zeroshot runs the loop: an agent writes the change, and an **independent** verifier decides whether it holds: approve, or a reproducible failure. **Opcore** is the sibling layer, a deterministic, local, read-only **constraints** gate for coding agents. Zeroshot packages Opcore `0.2.1` and uses introduced-change validation so existing repository debt never blocks an otherwise clean change. Verification asks _"does this meet the goal?"_; constraints ask _"is this within tolerance?"_

Each layer ships the same way: extracted from the platform we run, then opened. **Trust nothing. Verify everything.**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating, and [SECURITY.md](SECURITY.md) for security reports. More in [`docs/`](docs/) and [CLAUDE.md](./CLAUDE.md).

<!-- discord-placeholder -->

Questions and help: [Discord](https://discord.gg/fZyzf2Cut9).

## License

MIT. [The Open Engine Company](https://github.com/the-open-engine).
