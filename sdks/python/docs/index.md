# Zeroshot Python SDK

The SDK exposes one typed async `Client` for local and unauthenticated direct targets. One call to
`run()` is one high-level autonomous agent turn backed by one durable Rust graph execution.

```python
from zeroshot import Client, UniformRuntime

runtime = UniformRuntime(provider="openai", model="gpt-5.6-luna", effort="max")
async with Client(runtime=runtime) as client:
    result = await client.run("Implement the requested change.", wait_timeout=21_600)

result.raise_for_failure()
```

Use `submit()` when a durable run handle is needed before completion. Built-in graph discovery,
uniform runtime expansion, provider compatibility, and every semantic validation decision are
delegated to the bundled `zeroshot-rust` executable.

The lifecycle boundary is compatible with a future ACP edge adapter, but this package intentionally
does not expose ACP sessions or claim ACP protocol conformance.
