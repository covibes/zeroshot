# Zeroshot Python SDK

Install the `zeroshot-rust` distribution from PyPI and import it as `zeroshot`:

```console
pip install zeroshot-rust
```

`zeroshot` is a fully typed async client for the native Zeroshot Rust run engine. Each platform
wheel contains the matching `zeroshot-rust` sidecar. Python owns ergonomic orchestration and typed
projections; Rust remains the sole source of truth for templates, runtime materialization,
provider capabilities, graph validation, execution, and durable run state.

```python
from zeroshot import Client, UniformRuntime

runtime = UniformRuntime(
    provider="openrouter",
    model="gpt-5.6-luna",
    effort="max",
)

async with Client(runtime=runtime) as client:
    result = await client.run(
        "Implement the requested change and run the relevant tests.",
        wait_timeout=21_600,
    )

result.raise_for_failure()
```

`Client()` defaults to `LocalTarget()` and `Preset("software-change")`, but it never guesses a
provider or model. `run()` submits one durable graph run and waits for its terminal result.
`submit()` returns a `Run` immediately for status, resumable watch/log streams, waiting, or durable
force-stop control.

## Local and direct targets

Local execution uses the current Git workspace by default. Agents mutate that workspace in place:

```python
from zeroshot import Client, LocalTarget, UniformRuntime

runtime = UniformRuntime(provider="openai", model="gpt-5.6-luna", effort="max")
async with Client(target=LocalTarget("/path/to/repository"), runtime=runtime) as client:
    result = await client.run("Update the parser.")
```

The same client reaches an unauthenticated Docker deployment or another direct target by changing
only the target:

```python
from zeroshot import Client, DirectTarget, UniformRuntime

target = DirectTarget(
    "http://127.0.0.1:8080",
    repository="the-open-engine/zeroshot",
    default_branch="main",
)
runtime = UniformRuntime(provider="openai", model="gpt-5.6-luna", effort="max")

async with Client(target=target, runtime=runtime) as client:
    result = await client.run("Inspect the repository and report success.")
```

Docker is a deployment of `DirectTarget`, not a separate client or target type. Authentication and
hosted targets are intentionally outside this contract.

## Exact graph and runtime control

Use `GraphSpec` and `RuntimePlan` to pass exact JSON values unchanged. Python does not traverse or
validate either document:

```python
from zeroshot import GraphSpec, RunRequest, RuntimePlan

request = RunRequest(
    title="Repair checkout",
    graph=GraphSpec.from_dict(graph_document),
    initial_input={"ticket": "OE-123"},
    runtime=RuntimePlan.from_dict(runtime_document),
    submission_key="oe-123-attempt-1",
)
result = await client.run(request)
```

`await client.list_presets()` and `await client.get_preset(...)` query the bundled Rust catalog.
The Python package contains no copied preset registry, provider/model registry, graph schema, or
semantic validator. Every submission runs a source-neutral Rust preflight before a local controller
starts or a direct target is contacted.

## Durable observation

`Run.watch(after=...)` and `Run.logs(after=..., execution=...)` resume strictly after opaque native
cursors. A `wait_timeout` expiry raises `RunWaitTimeout` carrying the still-active `Run`; cancelling
the Python await also detaches without stopping it. `Run.force_stop()` is the only operation that
changes run lifetime. Each `LogEvent.timestamp` is the positive, JavaScript-safe Unix epoch
millisecond captured at the producer and preserved unchanged by durable replay.

## Environment values

With `environment=None`, declared values are read from `os.environ` at submission. An explicit
mapping is the complete credential source, apart from ordinary process variables needed to start
the sidecar. Runtime documents contain names only; Rust selects and forwards only the names declared
by the effective runtime. Uniform provider defaults are owned by Rust.

## Packaging and versions

The package is released only as platform wheels because each wheel bundles one matching native
executable; there is no first-run download, Node dependency, PyO3 ABI, or auth dependency. The
distribution and import name are both `zeroshot`, and `py.typed` is included.

An SDK release tag is `zeroshot-python-vRUST_SDK`, for example
`zeroshot-python-v0.3.1_1`; its PEP 440 package version is `0.3.1.post1`. Revision `1` is released
automatically after the corresponding Rust release. Later SDK-only revisions may be released
independently against the same immutable Rust release.
