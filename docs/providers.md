# Providers

Zeroshot supports two provider shapes:

- CLI-backed providers that shell out to a full agent CLI
- One bundled `gateway` provider that wraps OpenAI-compatible or Anthropic-compatible
  model APIs with a Zeroshot-owned tool runner

## Supported Providers

| Provider | CLI                              | Install                                                                  |
| -------- | -------------------------------- | ------------------------------------------------------------------------ |
| Claude   | Claude Code                      | `npm install -g @anthropic-ai/claude-code`                               |
| Codex    | Codex                            | `npm install -g @openai/codex`                                           |
| Gateway  | Bundled                          | No external CLI required                                                 |
| Gemini   | Gemini                           | `npm install -g @google/gemini-cli`                                      |
| Opencode | Opencode                         | See https://opencode.ai                                                  |
| Pi       | Pi                               | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.3` |
| OMP      | OMP (Oh My Pi), alias `oh-my-pi` | `bun install -g @oh-my-pi/pi-coding-agent@17.2.1`                        |
| Kiro     | Kiro                             | See https://kiro.dev/docs/cli/                                           |
| Copilot  | Copilot                          | `npm install -g @github/copilot`                                         |

## Selecting a Provider

- List providers: `zeroshot providers`
- Set default: `zeroshot providers set-default <provider>`
- Configure levels: `zeroshot providers setup <provider>`
- Override per run: `zeroshot run ... --provider <provider>`
- Env override: `ZEROSHOT_PROVIDER=codex`

## Opt-in native web search

Native or bundled search is off by default. It can be enabled only for Codex or
OpenCode with strict boolean provider settings:

```json
{
  "providerSettings": {
    "codex": { "webSearch": true },
    "opencode": { "webSearch": true }
  }
}
```

| Provider | Setting                               | Canonical child control                       | Minimum CLI |
| -------- | ------------------------------------- | --------------------------------------------- | ----------- |
| Codex    | `providerSettings.codex.webSearch`    | `codex exec --config 'web_search="live"' ...` | `0.146.0`   |
| OpenCode | `providerSettings.opencode.webSearch` | command environment `OPENCODE_ENABLE_EXA=1`   | `1.0.137`   |

Both settings default to `false`; absent and explicit `false` settings leave
the child command and environment unchanged. Codex applies the config override
before the prompt and, for a resumed session, before `resume`. OpenCode applies
the environment control to fresh `run` commands and to `run --session` or
`run --continue`.

Enabled mode fails closed before starting the provider when local support
cannot be proved. Codex requires nonempty `codex exec --help` output advertising
`--config` and a parseable version at or above `0.146.0`. OpenCode requires a
parseable version at or above `1.0.137`. Missing, malformed, or older versions
are unsupported. These checks attest only the installed CLI control: they do
not claim provider-account access, backend availability, or network reachability.
Executable probe and build-command output report `supportsWebSearch` separately
from `configuration.webSearch.requested` and `.effective`; effective is true
only after local support proof.

Codex does **not** use `codex exec --search`: current `ExecCli` rejects that
argument, while the top-level TUI flag does not configure noninteractive exec.
The config override above matches the
[Codex TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)
for fresh and resumed commands. OpenCode documents the environment control in
its [web-search tool guide](https://opencode.ai/docs/tools/#websearch); the
[versioned runtime flag](https://github.com/anomalyco/opencode/blob/v1.18.10/packages/opencode/src/effect/runtime-flags.ts)
and [tool registration](https://github.com/anomalyco/opencode/blob/v1.18.10/packages/opencode/src/tool/registry.ts)
show the corresponding bundled control.

Claude, Gemini, Kiro, Copilot, Pi, OMP, and Gateway do not declare `webSearch`;
setting it for those providers is rejected. No equally safe, explicit,
support-detectable additive native-search control is established for them.
Permission or tool allowlists authorize already-present tools; they must not be
presented as controls that enable search.

## OMP (Oh My Pi)

OMP uses a dedicated `rpc-stdio` invoke lane (`{lane: 'rpc-stdio', protocol: 'omp-v2'}`) that
speaks OMP's bidirectional RPC v2 protocol over stdio, instead of a one-shot CLI invocation.
Install is version-selected package installation, not release-asset digest attestation — do not
use OMP's shell installer, which downloads an asset without checking its SHA-256. OAuth users
authenticate afterward with OMP's own interactive `omp` then `/login` flow.

Capabilities: `worktreeIsolation:true`, `streamJson:true`, `thinkingMode:true`,
`reasoningEffort:true`, `jsonSchema:false`, `mcpServers:false`, `webSearch:false`,
`sessionResume:true`, `dockerIsolation:false`. `mcpServers` and `webSearch` mean Zeroshot's own
command-level injection/toggle surfaces, which OMP does not expose — OMP's own discovered
MCP/web tools remain governed by its native config, not by Zeroshot. `dockerIsolation` is false:
`--provider omp --docker` fails before any container is created, and `--provider omp --worktree`
is supported. `sessionResume` is true — see "OMP session persistence and resume" below; Docker
stays fresh-only (sessionless), independent of this capability.

### OMP session persistence and resume

Fresh runs (host, worktree, and standalone) pass `--session-dir <partition>`; a verified resume
adds `--resume <partition>/<file>` — always the exact absolute path Zeroshot already verified,
never a bare `--resume`/`--continue` or an ID search. `--no-session` is emitted only for the
Docker/sessionless lane.

Each session lives in its own random, secret-free UUID partition under
`<storageRoot>/omp-sessions/<uuid>/` — the owning cluster's `storageDir` for cluster-agent tasks,
the standalone `TASKS_DIR` otherwise (`task-lib/omp-storage-root.js`). The partition id is
allocated and its ownership row persisted **before** the directory is created on disk
(`task-lib/runner.js#spawnTask`); a crash between those two lines leaves a provisional row
pointing at a path with nothing there yet, which cleanup safely no-ops on.

`src/omp-session-verifier.js` streams every session and artifact file in fixed-size chunks
(never proportional to file size) against the fixed `OMP_SESSION_LIMITS` bounds
(`src/omp-session-limits.js`), checking both the declared and the bytes actually observed while
reading. Existing (resume) partitions are fully verified twice — before spawn and again from the
`ready` hook right before the prompt — and a fresh partition is descriptor/header/tree-verified
only after terminal materialization, before its evidence may ever be committed. Every check is
descriptor-pinned: a path is opened once with `O_NOFOLLOW`/`O_NONBLOCK` and every type, owner,
link-count, size, identity, and content check reads from that same descriptor, so the object that
was checked is the object that is read. Only owner-held directories and regular, single-link files
are accepted; symlinks, sockets, devices, and hard links are rejected.

CAS blobs live outside the partition, in OMP's shared machine-wide store. OMP externalizes large
payloads there and leaves a nested `blob:sha256:<64-lower-hex>` reference *inside* the session
JSONL records (v17.2.1 `session/blob-store.ts`, `session/session-loader.ts`). Verification parses
the transcript, collects those references, and resolves them at the real root reported by
`@oh-my-pi/pi-utils::getBlobsDir()` — `~/.omp/agent/blobs`, honouring `PI_CONFIG_DIR`,
`PI_CODING_AGENT_DIR`, `OMP_PROFILE`/`PI_PROFILE`, and XDG (`src/omp-blob-root.js`). A reference
that is missing, non-canonical, or whose bytes don't match its digest makes the continuation
invalid.

Ownership itself is a small owner-fenced state machine persisted as `task.ompSessionOwnership`
(`task-lib/store.js` schema v5): `provisional -> committed | cleanup-required`, with every
transition a SQL compare-and-swap so a duplicate/re-entrant completion call can never clobber a
state a concurrent writer already advanced past (`task-lib/omp-session-ownership.js`). A
standalone task's watcher run is its own terminal boundary, so it commits directly once its
output is validated. A cluster-agent task's watcher only records the owner-fenced verified
materialization evidence and leaves the row `provisional` — only the spawning agent's post-hook
success boundary (`src/agent/agent-lifecycle.js`, after `executeOnCompleteHookWithRetry`
succeeds) may advance it to `committed`; every failed, cancelled, or uncertain boundary on either
path marks the row `cleanup-required` instead. `task-lib/commands/resume.js` requires
`state === 'committed'` and reuses the exact persisted partition; an incomplete or non-committed
record fails resume closed rather than guessing.

A resume is an atomic owner transfer rather than a second claim: one transaction moves the prior
committed owner's lineage onto the resumed task's row and clears the prior row, both sides fenced
on their exact persisted value, and the watcher runs it from the `ready` hook strictly before the
prompt is written. The resumed row stays `provisional` until its own success boundary, so the
partition never has two committed owners and a half-finished continuation is never published as
resumable. It does, however, spend the whole resumed turn with *no* committed owner, and it can be
named by several rows at once — a resumed row exists before its transfer runs, and two competing
resumes leave three rows on one partition — which is why cleanup fences on every authoritative
claim rather than on the committed rows. The watcher compares the complete committed tuple — full session id, full
session file path (never a basename), partition and session-file inode identity, artifact manifest
digest, and an `executionFingerprint` binding the pinned OMP release, the config overlay's content,
the requested `--model`/`--thinking`/`--approval-mode` selectors, and the concrete provider, model,
and thinking level OMP reported.

Task `clean`, cluster clear, and global `purge` all reclaim partitions through
`task-lib/omp-session-cleanup.js`, validating the persisted owner uid and the storage-root and
partition inode identities first, then staging the directory under an unguessable name before
removing it so a substituted directory is reported rather than deleted. The owner check and the
staging rename run together in one task-store write transaction, fenced on every other row holding
an authoritative (`provisional` or `committed`) claim on the partition — after a successful resume
transfer the live owner is `provisional`, so a committed-only check would let a retired competing
resume delete a session that is still in use. An unsafe or unresolvable
path keeps the owner record and prints a warning instead of deleting. **OMP's shared blob store is
never written to or deleted by any Zeroshot cleanup surface** — it is machine-wide and addressed by
other sessions' transcripts, so `deleteOmpSessionPartition` refuses outright any path that resolves
inside it.

`providerSettings.omp` stays empty; OMP's own settings/model roles/profiles remain under its
documented config. Zeroshot controls only its existing agent `modelLevel`, explicit `model`, and
`reasoningEffort` surfaces, plus a fixed safety config overlay applied per task (pins
`marketplace.autoUpdate` off and neutral `todo`/`task`/`memory`/`advisor`/`async`/
`bash.autoBackground` defaults, while leaving project/user context, skills, rules, extensions,
and MCP flowing from OMP's native config).

## Gateway Provider

Use `gateway` for OpenAI-compatible or Anthropic-compatible model endpoints.
These stay model configs behind one provider engine; do not add them as
standalone provider ids.

Required settings:

```json
{
  "providerSettings": {
    "gateway": {
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:11434",
      "apiKey": "gateway-key",
      "model": "openrouter/meta-llama/test-model",
      "toolPolicy": {
        "roots": ["/absolute/path/to/worktree"],
        "commands": ["node"]
      }
    }
  }
}
```

Notes:

- `protocol` defaults to `openai`; set it to `anthropic` for Messages API endpoints.
- Anthropic-compatible configurations require a positive `maxTokens` value.
- `toolPolicy` is required. There is no default file or shell access.
- `headers` is optional for extra gateway-specific request headers.
- `model` may be any non-empty provider-specific model id.

### MiniMax

The gateway model catalog includes `MiniMax-M3` and `MiniMax-M2.7`. Choose the
region and protocol with the matching base URL:

| Region | Protocol    | Base URL                             |
| ------ | ----------- | ------------------------------------ |
| Global | `openai`    | `https://api.minimax.io/v1`          |
| Global | `anthropic` | `https://api.minimax.io/anthropic`   |
| China  | `openai`    | `https://api.minimaxi.com/v1`        |
| China  | `anthropic` | `https://api.minimaxi.com/anthropic` |

Example Anthropic-compatible settings:

```json
{
  "providerSettings": {
    "gateway": {
      "protocol": "anthropic",
      "baseUrl": "https://api.minimax.io/anthropic",
      "apiKey": "your-api-key",
      "model": "MiniMax-M3",
      "maxTokens": 8192,
      "toolPolicy": {
        "roots": ["/absolute/path/to/worktree"],
        "commands": ["node"]
      }
    }
  }
}
```

Pass the Anthropic base URL exactly as shown. The bundled client appends
`/v1/messages` for each request. For OpenAI-compatible settings, use
`"protocol": "openai"` and omit `maxTokens` unless the endpoint needs a custom
limit.

## Model Levels

Zeroshot uses provider-agnostic levels:

- `level1`: cheapest/fastest
- `level2`: default
- `level3`: most capable

Set levels per provider in settings:

```json
{
  "providerSettings": {
    "codex": {
      "minLevel": "level1",
      "maxLevel": "level3",
      "defaultLevel": "level2",
      "levelOverrides": {
        "level1": { "model": "codex-model-main", "reasoningEffort": "low" },
        "level3": { "model": "codex-model-main", "reasoningEffort": "xhigh" }
      }
    }
  }
}
```

Notes:

- `reasoningEffort` accepts `low`, `medium`, `high`, `xhigh`, or `max`.
- Claude passes reasoning effort to Claude Code as `--effort`.
- Codex passes reasoning effort as the `model_reasoning_effort` config override.
- Opencode passes reasoning effort as `--variant`.
- `model` is still supported as a provider-specific escape hatch.

### External Opencode models

Opencode models outside Zeroshot's built-in catalog must be configured in the
Opencode provider's level overrides:

```bash
zeroshot settings set providerSettings.opencode.levelOverrides.level2.model kimi/kimi-k2-5
```

Configured IDs must use Opencode's `provider/model` shape. Nested model paths
such as `openrouter/anthropic/claude-sonnet-4` are accepted; whitespace and
empty path segments are rejected before Opencode is started. Direct agent
`model` fields remain limited to the built-in catalog. Nested Docker tasks
receive only a temporary settings-file projection for the requested level/model
and an explicitly enabled declared `webSearch`; arbitrary provider settings and
environment overlays are not trusted or forwarded to the provider process.

### Current explicit model IDs

Zeroshot keeps provider-agnostic `modelLevel` defaults and also recognizes these
provider-specific IDs for explicit overrides:

- Codex: `gpt-5.6` (alias for Sol), `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`.
- Claude aliases: `haiku`, `sonnet`, `opus`, and `fable`.
- Claude current IDs: `claude-fable-5`, `claude-opus-4-8`,
  `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`,
  `claude-opus-4-5-20251101`, `claude-sonnet-5`, `claude-sonnet-4-6`,
  `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`,
  `claude-haiku-4-5`, and `claude-haiku-4-5-20251001`.
- Claude limited-access IDs: `claude-mythos-5` and `claude-mythos-preview`.
  Recognition does not grant account access.

The legacy Claude `maxModel` ceiling treats `fable` as a top-tier alias alongside
`opus`. Explicit canonical Claude IDs remain provider-specific overrides and are
not ranked by the legacy alias ceiling.

Sources: [OpenAI models](https://developers.openai.com/api/docs/models),
[Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
[Anthropic model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
and [Anthropic model ID rules](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions).

## Docker Isolation and Credentials

Zeroshot does not inject credentials for external CLIs. When using `--docker`,
mount your provider config directories explicitly.

Examples:

```bash
# Codex
zeroshot run 123 --docker --mount ~/.config/codex:/home/node/.config/codex:ro

# Gemini (use gemini or gcloud config as needed)
zeroshot run 123 --docker --mount ~/.config/gemini:/home/node/.config/gemini:ro
zeroshot run 123 --docker --mount ~/.config/gcloud:/home/node/.config/gcloud:ro
```

Mount presets in `dockerMounts` include: `codex`, `gemini`, `gcloud`, `claude`, `opencode`.

Use `--no-mounts` to disable all credential mounts (you will get a warning if
credentials are missing).

## Provider CLI Helper

Provider command construction, feature probing, model resolution, output
parsing, error classification, redaction metadata, and executable JSON behavior
live behind the strict TypeScript helper in `src/agent-cli-provider/`.

The public process contract is `zeroshot-agent-provider`, a JSON stdin/stdout
executable for provider-only commands: `probe`, `build-command`,
`parse-output`, `classify-error`, and `invoke`.

This helper does not share Zeroshot clusters, task store, message bus,
scheduler, PR/ship flow, TUI, or orchestration policy. Consumers such as
Orchestra must call the JSON executable contract and must not import Zeroshot
internals.

See `docs/provider-cli-helper.md` for the ownership boundary, non-goals, rollout
rules, and required verification commands.

## Live Provider Smoke Tests

The normal test suite is deterministic and offline. To verify a provider against
the real installed CLI or a real gateway endpoint, run the opt-in live smoke
command:

```bash
ZEROSHOT_LIVE_PROVIDERS=all npm run test:providers:live
ZEROSHOT_LIVE_PROVIDERS=claude,codex,gemini npm run test:providers:live
ZEROSHOT_LIVE_PROVIDERS=pi npm run test:providers:live
ZEROSHOT_LIVE_PROVIDERS=copilot npm run test:providers:live
```

Gateway requires endpoint settings:

```bash
ZEROSHOT_LIVE_PROVIDERS=gateway \
  ZEROSHOT_LIVE_GATEWAY_BASE_URL=https://openrouter.ai/api/v1 \
  ZEROSHOT_LIVE_GATEWAY_API_KEY=... \
  ZEROSHOT_LIVE_GATEWAY_MODEL=openai/gpt-5.4 \
  npm run test:providers:live
```

The live command invokes the provider through Zeroshot's executable provider
contract and requires the provider to return the sentinel
`ZEROSHOT_LIVE_SMOKE_OK`. It is not part of CI because it may require local
auth, network access, and paid API calls.

### GitHub Actions Live Smoke

Use the `Live Provider Smoke` workflow for release-gating real providers. It is
manual by default and scheduled only when the repository variable
`ZEROSHOT_LIVE_PROVIDER_SMOKE_ENABLED` is set to `true`.

Recommended release gate:

```text
claude,codex,gemini,copilot,gateway
```

Run `all` only on a runner that also has Opencode, Pi, and Kiro installed and
authenticated. The workflow fails selected providers when the executable or
required credential is missing; it does not convert missing live coverage into a
passing skip.

Credential names:

| Provider | Required CI credential                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| Claude   | `ZEROSHOT_LIVE_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`                                         |
| Codex    | `ZEROSHOT_LIVE_OPENAI_API_KEY` or `OPENAI_API_KEY`                                               |
| Gemini   | `ZEROSHOT_LIVE_GEMINI_API_KEY` / `ZEROSHOT_LIVE_GOOGLE_API_KEY`                                  |
| Copilot  | `ZEROSHOT_LIVE_COPILOT_GITHUB_TOKEN`                                                             |
| Gateway  | `ZEROSHOT_LIVE_GATEWAY_BASE_URL`, `ZEROSHOT_LIVE_GATEWAY_API_KEY`, `ZEROSHOT_LIVE_GATEWAY_MODEL` |
| Kiro     | `ZEROSHOT_LIVE_KIRO_API_KEY` plus a runner with `kiro-cli` installed                             |
| Pi       | A runner with `pi` installed and authenticated                                                   |
| Opencode | A runner with `opencode` installed and authenticated                                             |
