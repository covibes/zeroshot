# Remote runs with the private Zeroshot candidate

This guide applies only to the unpublished private candidate. The public Zeroshot package does not
contain these commands, this guide, or the accompanying examples.

A remote run has four inputs:

- A **target** names the remote Zeroshot service and holds your authenticated session.
- A **runtime config** selects the model API, Zeroshot harness, model, credentials, and normal
  Zeroshot settings.
- The supplied **graph** is the candidate's fixed delivery contract. The **input** contains the work
  request.
- A **delivery mode** decides whether Zeroshot opens a pull request (`--pr`) or also requests its
  merge (`--ship`). Every remote run requires one of these modes.

## Prerequisites

- Node.js 22 or newer and npm.
- A target URL and account, plus an operating-system credential store that the target login can use.
- A GitHub repository and token that can clone it, push a branch, and open pull requests. `--ship`
  also needs permission to merge or enable auto-merge.
- The provider credential and routing variables referenced by the runtime config you choose.

The commands below use GitHub CLI to obtain a token, so `gh` must already be authenticated. You may
instead export a suitable `GH_TOKEN` or `GITHUB_TOKEN` yourself.

## First run

Install the candidate tarball supplied by your operator, copy its examples into a durable working
directory, and confirm that its commands are present:

```bash
npm install --global /absolute/path/to/the-open-engine-zeroshot-private-hosted-candidate.tgz
private_candidate_root="$(npm root --global)/@the-open-engine/zeroshot-private-hosted-candidate/lib/private-hosted-cli"
test -f "$private_candidate_root/examples/graph.json"
mkdir zeroshot-remote-run
cp -R "$private_candidate_root/examples" zeroshot-remote-run/
cd zeroshot-remote-run
zeroshot target --help
```

Keep this directory after setup: Zeroshot rereads the selected runtime file for every run.

Register and authenticate a target:

```bash
zeroshot target add team --url https://target.example
zeroshot target login team
```

Choose a runtime config from `examples/`, export the local variables referenced by that file, and
bind it to a GitHub repository:

```bash
export GH_TOKEN="$(gh auth token)"
export OPENAI_API_KEY=...
zeroshot target setup team \
  --repository your-org/your-repository \
  --base main \
  --runtime-config examples/runtime-openai-codex.json
```

`--base` may be a branch or an exact lowercase 40-character commit. When it is an exact commit,
also pass `--target-branch` to name the branch that receives the pull request. If `--base` is
omitted, Zeroshot resolves the repository's default branch for each submission.

Start a run with Zeroshot's built-in coordinator by omitting `--config`:

```bash
zeroshot run \
  --target team \
  --graph examples/graph.json \
  --input examples/input.json \
  --ship
```

Keep `examples/graph.json` unchanged. The included input asks the run to make a real repository
change; replace only its prompt with your own work before submitting it to a repository you care
about. `examples/cluster.json` is independent and is used only when you want a custom agent
topology.

`--pr` commits the change, pushes a delivery branch, and opens a pull request. `--ship` additionally
requests an allowed merge or enables auto-merge. It succeeds only after the target reports that the
pull request is merged or that GitHub accepted auto-merge. Checks, approvals, conflicts, branch
protection, or insufficient token permissions can prevent shipping; inspect the retained pull
request to resolve those repository conditions.

## Runtime config

The runtime config is ordinary JSON with these fields:

| Field          | Required | Meaning                                                                                                   |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `provider`     | yes      | Stable label for the model API, such as `openai` or `openrouter`.                                         |
| `harness`      | no       | Agent program Zeroshot uses to call the API, such as `claude`, `codex`, or `omp`. Defaults to `provider`. |
| `model`        | no       | Model selector understood by the chosen harness.                                                          |
| `environment`  | no       | Environment values supplied to the harness.                                                               |
| `files`        | no       | Text files materialized for the harness.                                                                  |
| `settings`     | no       | Normal Zeroshot settings used by the cluster.                                                             |
| `command`      | no       | Custom command invoked through the registered harness name.                                               |
| `setupCommand` | no       | Bounded setup command run before the harness is checked and started.                                      |

Environment values may be inline strings or local environment references:

```json
{
  "environment": {
    "OPENAI_API_KEY": { "from": "OPENAI_API_KEY" },
    "PROVIDER_REGION": "eu-west-1"
  }
}
```

File values may likewise be inline text or references to local regular files. Relative source
paths are resolved from the runtime config's directory:

```json
{
  "files": {
    ".config/provider.json": { "from": "provider.json" }
  }
}
```

Target setup stores the runtime config's absolute path. Zeroshot reads it again at submission time
and resolves references then, so rotated local credentials apply without repeating setup. Do not
put GitHub delivery credentials in `environment`; use `GH_TOKEN` or `GITHUB_TOKEN` in the shell
that starts the run.

The example directory contains complete configurations for OpenRouter with the Claude harness,
OpenAI with the Codex harness, and Azure OpenAI with the OMP harness. The Azure OMP configuration
expects these local variables:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_API_VERSION=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/v1
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP='{"gpt-5.1":"your-deployment"}'
```

Treat each runtime example as one atomic starting point. To change the model without changing its
harness, update the top-level `model` and every model entry under
`settings.providerSettings.<harness>.levelOverrides`. The top-level `harness` selects the agent
program; keep `settings.defaultProvider` aligned with it so the settings remain internally
consistent. When changing the model API, also update its `provider` label, environment routing, and
harness-specific authentication settings together.

## Coordinator and custom clusters

Keep the supplied graph unchanged. Omit `--config` to use Zeroshot's built-in coordinator. To
control the agent topology, pass a declarative Zeroshot cluster config:

```bash
zeroshot run \
  --target team \
  --graph examples/graph.json \
  --input examples/input.json \
  --config examples/cluster.json \
  --ship
```

Remote custom configs accept normal declarative agent, trigger, prompt, model-level, and completion
hook data. They reject executable scripts, config loaders, task executors, and system-command hooks.
Provider, harness, model, credentials, and shared settings belong in the runtime config rather than
the cluster file.

## Following and recovery

Runs follow their output by default. `--detach` returns after submission. Pressing Ctrl+C while
following detaches without cancelling the remote work.

Immediately before sending the submission request, the CLI prints `Submission key: <uuid>`. After
acceptance it prints `Run <run-intent-id> submitted` and the exact `zeroshot attach` resume command.
Save this output when you detach.

```bash
zeroshot attach <run-intent-id> --target team
zeroshot target status team <run-intent-id>
zeroshot target cancel team <run-intent-id>
zeroshot list --target team
```

If submission ended without a definite response, the error includes the submission key that was
printed before the request. The key is an idempotency key, not a lookup: retry only when the fully
resolved request is unchanged. That means the graph, input, custom cluster, runtime file and its
referenced environment values and files, GitHub token, size, delivery mode, and resolved repository
revision must all match the first request. A changed request with the same key is rejected rather
than creating a second run.

For a recoverable run, configure an exact commit base and keep all referenced inputs unchanged
until submission is confirmed. Then repeat the exact run with the canonical UUID as
`--submission-key`. If you cannot guarantee an identical request, do not resubmit with that key;
ask the target operator to determine whether the original request was accepted.

```bash
zeroshot run \
  --target team \
  --graph examples/graph.json \
  --input examples/input.json \
  --ship \
  --submission-key 019fd17d-d9a7-4ef7-8a62-4e46f907c8ec
```

## Current command boundary

- Remote runs accept explicit JSON graph and input files; general text or issue positionals remain
  local-only.
- The remote graph is the included single-worker delivery graph with one attempt; keep it unchanged.
- Remote delivery always uses `--pr` or `--ship`; there is no delivery-free remote run.
- `logs --target`, the `ls` alias with `--target`, and cross-target listing are not available.
- A target can reject a harness, model, size, or runtime command that it does not provide.

Use `zeroshot run --help`, `zeroshot target --help`, and
`zeroshot target setup --help` for the concise command reference.
