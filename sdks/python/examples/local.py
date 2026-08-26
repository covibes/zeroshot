"""Run one software-change task in the current Git workspace."""

import asyncio

from zeroshot import Client, UniformRuntime


async def main() -> None:
    """Submit one local run and wait for its terminal result."""
    runtime = UniformRuntime(provider="openai", model="gpt-5.6-luna", effort="max")
    async with Client(runtime=runtime) as client:
        result = await client.run("Implement the requested change.", wait_timeout=21_600)
    result.raise_for_failure()


if __name__ == "__main__":
    asyncio.run(main())
