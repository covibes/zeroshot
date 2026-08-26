"""Run one task on an unauthenticated local Docker target."""

import asyncio

from zeroshot import Client, DirectTarget, UniformRuntime


async def main() -> None:
    """Submit one direct-target run and wait for its terminal result."""
    target = DirectTarget(
        "http://127.0.0.1:8080",
        repository="the-open-engine/zeroshot",
        default_branch="main",
    )
    runtime = UniformRuntime(provider="openai", model="gpt-5.6-luna", effort="max")
    async with Client(target=target, runtime=runtime) as client:
        result = await client.run(
            "Inspect the repository and report success.",
            wait_timeout=21_600,
        )
    result.raise_for_failure()


if __name__ == "__main__":
    asyncio.run(main())
