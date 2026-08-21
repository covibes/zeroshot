# Zeroshot Rust self-hosted target

This image runs one long-lived, no-login Zeroshot Rust target for a trusted private VM. It can
host many runs, each with its own workspace and runtime homes. It includes the native server,
Codex, Claude Code, Git, and GitHub CLI. It is not a tenant-isolation boundary and does not include
a queue or scheduler.

Build it from the root of a Zeroshot source checkout; the Node npm package does not contain the
Rust workspace used by this Dockerfile. Start it on host loopback:

```sh
docker build -f docker/zeroshot-rust-target/Dockerfile -t zeroshot-rust-target .
docker run -d --name zeroshot-rust-target --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v zeroshot-rust-data:/var/lib/zeroshot/native-v2 \
  zeroshot-rust-target
```

Register and configure the target with the native CLI:

```sh
zeroshot-rust target add vm --direct --url http://127.0.0.1:8080
zeroshot-rust target setup vm --repository owner/repository --branch main
```

`run --branch <branch>` overrides the target default for that run. The CLI submits only values for
environment names declared by the materialized runtime plan. `GH_TOKEN`, when present, is carried
separately as the ephemeral trusted checkout/delivery credential; provider children receive it
only when their own binding explicitly declares it. The checked-in example uses Claude with
Anthropic:

```sh
ANTHROPIC_API_KEY=... GH_TOKEN=... zeroshot-rust run \
  --target vm \
  --title "Ship the change" \
  --template software-change \
  --ship \
  --input docker/zeroshot-rust-target/examples/software-change-input.json \
  --runtime-config docker/zeroshot-rust-target/examples/claude-anthropic-runtime.json
```

Use `list`, `status`, `watch`, `logs`, and read-only `attach` with `--target vm`. Direct targets
start runs immediately and therefore never report the cloud-owned `queued` phase.

Managed private deployments may set `ZEROSHOT_TARGET_BOOTSTRAP_KEY` to a task-bound 32-byte
lowercase-hex key. The entrypoint moves it into a 0600 task-local file, clears the environment, and
enables the ordinary server's one-time private capability bootstrap. With no key, the image keeps
the normal auth-free direct-target behavior shown above.

When the CLI is not on the VM, keep the target reachable only through a trusted private network,
VPN, or equivalent network access control; TLS alone does not authenticate this direct target. Use
HTTPS through an external reverse proxy, forward WebSocket upgrades on `/native-v2/oecp`, and
override `--public-origin` with that HTTPS origin. Unencrypted direct targets are accepted only on
literal loopback.
