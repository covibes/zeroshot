# Providers

Zeroshot supports two provider shapes:

- CLI-backed providers that shell out to a full agent CLI
- One bundled `gateway` provider that wraps OpenAI-compatible or Anthropic-compatible
  model APIs with a Zeroshot-owned tool runner

## Supported Providers

| Provider | CLI         | Install                                                                  |
| -------- | ----------- | ------------------------------------------------------------------------ |
| Claude   | Claude Code | `npm install -g @anthropic-ai/claude-code`                               |
| Codex    | Codex       | `npm install -g @openai/codex`                                           |
| Gateway  | Bundled     | No external CLI required                                                 |
| Gemini   | Gemini      | `npm install -g @google/gemini-cli`                                      |
| Opencode | Opencode    | See https://opencode.ai                                                  |
| Pi       | Pi          | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.3` |
| OMP      | OMP         | `npm install -g --ignore-scripts @oh-my-pi/pi-coding-agent`              |
| Kiro     | Kiro        | See https://kiro.dev/docs/cli/                                           |
| Copilot  | Copilot     | `npm install -g @github/copilot`                                         |

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
