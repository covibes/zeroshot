"""Public client contract tests."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from conftest import read_invocations

from zeroshot import (
    Client,
    ClientClosedError,
    DirectTarget,
    GraphSpec,
    InvalidRequestError,
    LocalTarget,
    RunFailedError,
    RunRequest,
    RunResult,
    RuntimePlan,
    RunWaitTimeout,
    UniformRuntime,
)


def runtime() -> UniformRuntime:
    return UniformRuntime(provider="openrouter", model="gpt-5.6-luna", effort="max")


def direct_client(fake_native: Path) -> Client:
    return Client(
        target=DirectTarget(
            "http://127.0.0.1:8080",
            repository="owner/repo",
            default_branch="main",
        ),
        runtime=runtime(),
        environment={
            "OPENROUTER_API_KEY": "test-only",
            "FAKE_ZEROSHOT_LOG": str(fake_native),
            "FAKE_LIST_ONE": "1",
        },
    )


def test_run_waits_for_terminal_result(fake_native: Path, tmp_path: Path) -> None:
    async def exercise() -> None:
        async with Client(target=LocalTarget(tmp_path), runtime=runtime()) as client:
            result = await client.run("change it", wait_timeout=2)
            assert result.succeeded
            assert result.output == {"ok": True}
            result.raise_for_failure()

    asyncio.run(exercise())
    invocations = read_invocations(fake_native)
    runs = [item for item in invocations if item["args"][0] == "run"]
    assert len(runs) == 2
    assert all(item["--input"] == {"task": "change it"} for item in runs)
    assert all(
        item["--uniform-runtime-config"]
        == {
            "provider": "openrouter",
            "model": "gpt-5.6-luna",
            "effort": "max",
            "size": "standard",
            "sessionScope": "execution",
        }
        for item in runs
    )
    keys = [item["args"][item["args"].index("--submission-key") + 1] for item in runs]
    assert keys[0] == keys[1]
    assert "--validate-only" in runs[0]["args"]
    assert "--detach" in runs[1]["args"]
    watch = next(item["args"] for item in invocations if item["args"][0] == "watch")
    assert watch[watch.index("--after") + 1] == "v2:0"


def test_direct_target_uses_the_same_client_and_durable_run_surface(fake_native: Path) -> None:
    async def exercise() -> None:
        async with direct_client(fake_native) as client:
            run = await client.submit("inspect it")
            status = await run.status()
            assert status.phase == "admitted"
            summaries = await client.list_runs()
            assert len(summaries) == 1
            assert summaries[0].phase == "admitted"
            logs = [event async for event in run.logs(after="v2:2", execution="worker-1")]
            assert [(event.execution, event.message) for event in logs] == [("worker-1", "done")]
            assert logs[0].timestamp == 1_725_000_000_123
            result = await run.force_stop()
            assert not result.succeeded
            assert result.failure == "force_stopped"

    asyncio.run(exercise())
    arguments = [item["args"] for item in read_invocations(fake_native)]
    assert arguments[0][0] == "run"
    assert "--validate-only" in arguments[0]
    assert arguments[1][:2] == ["target", "add"]
    assert arguments[2][:2] == ["target", "setup"]
    run = next(args for args in arguments if args[0] == "run" and "--detach" in args)
    assert run[run.index("--target") : run.index("--target") + 2] == ["--target", "python-sdk"]
    assert run[run.index("--branch") : run.index("--branch") + 2] == ["--branch", "main"]
    logs = next(args for args in arguments if args[0] == "logs")
    assert logs[logs.index("--after") + 1] == "v2:2"
    assert logs[logs.index("--execution") + 1] == "worker-1"


def test_custom_graph_and_runtime_are_forwarded_unchanged(fake_native: Path) -> None:
    graph = {"profile": "openengine.graph.full/v1", "root": {"kind": "succeed"}}
    runtime_plan = {"harness": "codex", "provider": "openai", "size": "tiny", "nodes": {}}
    request = RunRequest(
        title="Exact request",
        graph=GraphSpec.from_dict(graph),
        initial_input={"ticket": "OE-123"},
        runtime=RuntimePlan.from_dict(runtime_plan),
        submission_key="oe-123",
    )

    async def exercise() -> None:
        async with Client() as client:
            await client.submit(request)

    asyncio.run(exercise())
    runs = [
        item for item in read_invocations(fake_native) if item["args"] and item["args"][0] == "run"
    ]
    assert len(runs) == 2
    assert all(item["--input"] == {"ticket": "OE-123"} for item in runs)
    assert all(item["--graph"] == graph for item in runs)
    assert all(item["--runtime-config"] == runtime_plan for item in runs)
    assert all("--uniform-runtime-config" not in item["args"] for item in runs)


def test_presets_are_read_from_rust(fake_native: Path) -> None:
    async def exercise() -> None:
        async with Client() as client:
            assert await client.list_presets() == ("single-worker", "software-change")
            graph = await client.get_preset("software-change", delivery="pull_request")
            assert graph.document["name"] == "software-change"
            assert graph.document["delivery"] == "pull_request"

    asyncio.run(exercise())
    arguments = [item["args"] for item in read_invocations(fake_native)]
    assert ["template", "list"] in arguments
    assert [
        "template",
        "show",
        "software-change",
        "--delivery",
        "pull_request",
    ] in arguments


def test_native_validation_error_is_structured_and_redacted(fake_native: Path) -> None:
    secret = "must-not-escape"

    async def exercise() -> None:
        async with Client(
            runtime=runtime(),
            environment={
                "OPENROUTER_API_KEY": secret,
                "FAKE_ZEROSHOT_LOG": str(fake_native),
            },
        ) as client:
            with pytest.raises(InvalidRequestError) as caught:
                await client.submit("invalid")
            assert caught.value.code == "runtime.missing_binding"
            assert caught.value.node == "worker"
            assert secret not in str(caught.value)
            assert "<redacted>" in str(caught.value)

    asyncio.run(exercise())


def test_invalid_direct_run_never_contacts_target(fake_native: Path) -> None:
    async def exercise() -> None:
        async with direct_client(fake_native) as client:
            with pytest.raises(InvalidRequestError):
                await client.submit("invalid")

    asyncio.run(exercise())
    arguments = [item["args"] for item in read_invocations(fake_native)]
    assert len(arguments) == 1
    assert arguments[0][0] == "run"
    assert "--validate-only" in arguments[0]


def test_wait_timeout_carries_run_and_does_not_force_stop(fake_native: Path) -> None:
    async def exercise() -> None:
        async with Client(
            runtime=runtime(),
            environment={
                "FAKE_WATCH_DELAY": "1",
                "FAKE_ZEROSHOT_LOG": str(fake_native),
                "OPENROUTER_API_KEY": "test-only",
            },
        ) as client:
            run = await client.submit("slow")
            with pytest.raises(RunWaitTimeout) as caught:
                await run.wait(wait_timeout=0.01)
            assert caught.value.run is run

    asyncio.run(exercise())
    assert not any(item["args"][0] == "force-stop" for item in read_invocations(fake_native))


def test_missing_runtime_fails_before_native_preflight(fake_native: Path) -> None:
    async def exercise() -> None:
        async with Client() as client:
            with pytest.raises(InvalidRequestError) as caught:
                await client.submit("missing runtime")
            assert caught.value.code == "runtime.required"

    asyncio.run(exercise())
    assert read_invocations(fake_native) == []


def test_closed_client_rejects_run_handle(fake_native: Path) -> None:
    async def exercise() -> None:
        client = Client()
        run = client.get_run("01900000-0000-7000-8000-000000000001")
        await client.aclose()
        with pytest.raises(ClientClosedError):
            await run.status()

    asyncio.run(exercise())


def test_failed_result_has_opt_in_exception_projection() -> None:
    result = RunResult(run_id="run-1", succeeded=False, failure="worker_failed")
    with pytest.raises(RunFailedError) as caught:
        result.raise_for_failure()
    assert caught.value.result is result
