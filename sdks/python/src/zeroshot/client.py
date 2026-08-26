"""Async single-run client over the bundled Zeroshot Rust sidecar."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict, Unpack, overload

from ._binary import resolve_binary
from ._process import NativeProcess
from ._projection import _log_event, _status, _summary
from .errors import ClientClosedError, InvalidRequestError, ProtocolError
from .run_errors import RunWaitTimeout
from .runs import LogEvent, RunRequest, RunResult, RunStatus, RunSummary
from .runtime import (
    DirectTarget,
    GraphSpec,
    LocalTarget,
    Preset,
    RuntimePlan,
    Target,
    UniformRuntime,
)
from .values import JsonValue

_Runtime = UniformRuntime | RuntimePlan
_Graph = Preset | GraphSpec

_OPERATING_ENVIRONMENT = (
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
)


@dataclass(frozen=True, slots=True)
class _Submission:
    title: str
    graph: _Graph
    initial_input: JsonValue
    runtime: _Runtime
    branch: str | None
    submission_key: str


@dataclass(frozen=True, slots=True)
class _Overrides:
    title: str | None
    preset: Preset | None
    runtime: _Runtime | None
    branch: str | None
    submission_key: str | None


class _SubmitOptions(TypedDict, total=False):
    title: str | None
    preset: Preset | None
    runtime: _Runtime | None
    branch: str | None
    submission_key: str | None


class _RunOptions(_SubmitOptions, total=False):
    wait_timeout: float | None


class Client:
    """Submit and observe one-turn graph agents through Zeroshot Rust.

    Args:
        target: Local target by default, or an unauthenticated direct target such as Docker.
        preset: Default Rust-owned graph preset. None selects software-change.
        runtime: Default runtime. None requires a runtime on each string submission.
        environment: Source for runtime-declared environment values. None reads the ambient
            environment at submission time. An explicit mapping is the complete value source.

    The SDK never guesses a provider or model. Closing the client detaches observation and never
    stops runs.
    """

    def __init__(
        self,
        *,
        target: Target | None = None,
        preset: Preset | None = None,
        runtime: _Runtime | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.target = target or LocalTarget()
        self.preset = preset or Preset("software-change")
        self.runtime = runtime
        self._provided_environment = environment
        self._closed = False
        self._opened = False
        self._workspace: Path | None = None
        self._direct_directory: tempfile.TemporaryDirectory[str] | None = None
        self._direct_ready = False
        self._direct_lock = asyncio.Lock()

    async def __aenter__(self) -> Client:
        """Open the client and capture a default local workspace.

        Returns:
            This client.

        Raises:
            ClientClosedError: If this client was already closed.
        """
        self._ensure_open()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object,
    ) -> None:
        """Close client-owned routing state without stopping durable runs."""
        await self.aclose()

    async def aclose(self) -> None:
        """Release client-owned routing state without stopping submitted runs."""
        if self._closed:
            return
        self._closed = True
        if self._direct_directory is not None:
            self._direct_directory.cleanup()
            self._direct_directory = None
        self._direct_ready = False

    @overload
    async def run(
        self,
        task: str,
        *,
        title: str | None = None,
        preset: Preset | None = None,
        runtime: _Runtime | None = None,
        branch: str | None = None,
        submission_key: str | None = None,
        wait_timeout: float | None = None,
    ) -> RunResult: ...

    @overload
    async def run(
        self,
        task: RunRequest,
        *,
        wait_timeout: float | None = None,
    ) -> RunResult: ...

    async def run(
        self,
        task: str | RunRequest,
        **options: Unpack[_RunOptions],
    ) -> RunResult:
        """Submit one graph run and wait for its terminal result.

        Args:
            task: Task text for a built-in preset, or a complete exact RunRequest.
            options: Typed keyword options. title, preset, runtime, branch, and submission_key
                apply to string submissions. wait_timeout is a non-negative observation deadline
                in seconds; omit it to wait indefinitely.

        Returns:
            The terminal result. Graph failure remains data until raise_for_failure() is called.

        Raises:
            InvalidRequestError: If a string submission has no effective preset or runtime, or Rust
                rejects the request.
            RunWaitTimeout: If observation expires; its run attribute can resume waiting.
            TargetError: If the sidecar or selected target is unavailable.
            ProtocolError: If native output is malformed or incompatible.

        Cancellation detaches observation and leaves the durable run active.
        """
        submitted = await self._submit(task, _overrides(options))
        return await submitted.wait(wait_timeout=options.get("wait_timeout"))

    @overload
    async def submit(
        self,
        task: str,
        **options: Unpack[_SubmitOptions],
    ) -> Run: ...

    @overload
    async def submit(self, task: RunRequest) -> Run: ...

    async def submit(
        self,
        task: str | RunRequest,
        **options: Unpack[_SubmitOptions],
    ) -> Run:
        """Preflight in Rust, submit one durable run, and return its handle.

        Args:
            task: Task text for a built-in preset, or a complete exact RunRequest.
            options: Typed keyword options for string submissions: title, preset, runtime, branch,
                and submission_key.

        Returns:
            A durable run handle bound to this client's target.

        Raises:
            InvalidRequestError: If required selection is absent or native preflight rejects it.
            TargetError: If native execution or target submission fails.
            ProtocolError: If native output is malformed.

        Exact RunRequest values cannot be combined with string-submission overrides. Preflight
        completes before local controller startup or direct-target contact.
        """
        return await self._submit(task, _overrides(options))

    async def _submit(self, request: str | RunRequest, overrides: _Overrides) -> Run:
        self._ensure_open()
        selected = self._submission(request, overrides)
        with tempfile.TemporaryDirectory(prefix="zeroshot-python-run-") as directory:
            arguments = self._submission_arguments(selected, Path(directory))
            await self._native(static=True).json([*arguments[:-1], "--validate-only"])
            await self._ready()
            receipt = await self._native().json(arguments)
        if not isinstance(receipt, dict) or not isinstance(receipt.get("runId"), str):
            raise ProtocolError("Zeroshot Rust returned a malformed submission receipt")
        return Run(self, receipt["runId"])

    def get_run(self, run_id: str) -> Run:
        """Reconstruct a durable handle without target I/O.

        Args:
            run_id: Opaque public run identity.

        Returns:
            A handle resolved lazily against this client's target.

        Raises:
            ClientClosedError: If this client is closed.
        """
        if self._closed:
            raise ClientClosedError("the Zeroshot client is closed")
        return Run(self, run_id)

    async def list_runs(self) -> tuple[RunSummary, ...]:
        """Return durable inventory summaries retained by this client's target."""
        await self._ready()
        value = await self._native().json(["list", *self._route_arguments()])
        if not isinstance(value, dict) or not isinstance(value.get("runs"), list):
            raise ProtocolError("Zeroshot Rust returned a malformed run inventory")
        return tuple(_summary(_status(item)) for item in value["runs"])

    async def list_presets(self) -> tuple[str, ...]:
        """Return built-in preset names read dynamically from the bundled Rust binary."""
        value = await self._native(static=True).json(["template", "list"])
        if not isinstance(value, list) or not all(isinstance(name, str) for name in value):
            raise ProtocolError("Zeroshot Rust returned a malformed template catalog")
        return tuple(value)

    async def get_preset(self, name: str, *, delivery: str = "none") -> GraphSpec:
        """Materialize one built-in preset through the bundled Rust binary.

        Args:
            name: Exact native preset name.
            delivery: Native delivery selector, such as none, pull_request, or merge.

        Returns:
            The lossless Rust-emitted GraphSpec.

        Raises:
            InvalidRequestError: If Rust rejects the name or delivery combination.
            ProtocolError: If Rust emits a malformed graph document.
        """
        value = await self._native(static=True).json(
            ["template", "show", name, "--delivery", delivery]
        )
        if not isinstance(value, dict):
            raise ProtocolError("Zeroshot Rust returned a malformed GraphSpec")
        return GraphSpec.from_dict(value)

    def _submission(self, request: str | RunRequest, overrides: _Overrides) -> _Submission:
        if isinstance(request, RunRequest):
            return _exact_submission(request, overrides)
        selected_preset = overrides.preset or self.preset
        if selected_preset is None:
            raise InvalidRequestError("a preset is required", code="template.required")
        selected_runtime = overrides.runtime or self.runtime
        if selected_runtime is None:
            raise InvalidRequestError(
                "a runtime is required; configure Client.runtime or pass runtime=",
                code="runtime.required",
            )
        return _Submission(
            title=overrides.title if overrides.title is not None else "Zeroshot run",
            graph=selected_preset,
            initial_input={"task": request},
            runtime=selected_runtime,
            branch=overrides.branch,
            submission_key=(
                overrides.submission_key
                if overrides.submission_key is not None
                else _submission_key()
            ),
        )

    def _submission_arguments(self, submission: _Submission, root: Path) -> list[str]:
        input_path = _write_json(root / "input.json", submission.initial_input)
        arguments = ["run", "--title", submission.title, "--input", str(input_path)]
        self._append_graph(arguments, submission.graph, root)
        self._append_runtime(arguments, submission.runtime, root)
        effective_branch = submission.branch
        if effective_branch is None and isinstance(self.target, DirectTarget):
            effective_branch = self.target.default_branch
        if effective_branch is not None:
            arguments.extend(["--branch", effective_branch])
        arguments.extend(["--submission-key", submission.submission_key])
        return [*arguments, *self._route_arguments(), "--detach"]

    @staticmethod
    def _append_graph(arguments: list[str], selected: _Graph, root: Path) -> None:
        if isinstance(selected, GraphSpec):
            graph_path = _write_json(root / "graph.json", selected.to_dict())
            arguments.extend(["--graph", str(graph_path)])
            return
        arguments.extend(["--template", selected.name, "--delivery", selected.delivery])

    @staticmethod
    def _append_runtime(arguments: list[str], selected: _Runtime, root: Path) -> None:
        runtime_path = _write_json(root / "runtime.json", selected.to_dict())
        option = (
            "--uniform-runtime-config"
            if isinstance(selected, UniformRuntime)
            else "--runtime-config"
        )
        arguments.extend([option, str(runtime_path)])

    async def _ready(self) -> None:
        self._ensure_open()
        if isinstance(self.target, DirectTarget):
            await self._ensure_direct_target()

    async def _ensure_direct_target(self) -> None:
        if self._direct_ready:
            return
        async with self._direct_lock:
            if self._direct_ready:
                return
            target = self.target
            if not isinstance(target, DirectTarget):
                return
            if self._direct_directory is None:
                self._direct_directory = tempfile.TemporaryDirectory(
                    prefix="zeroshot-python-target-"
                )
            native = self._native(static=True)
            await native.check(["target", "add", "python-sdk", "--url", target.origin, "--direct"])
            setup = ["target", "setup", "python-sdk", "--repository", target.repository]
            if target.default_branch is not None:
                setup.extend(["--branch", target.default_branch])
            await native.check(setup)
            self._direct_ready = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise ClientClosedError("the Zeroshot client is closed")
        if self._opened:
            return
        if isinstance(self.target, LocalTarget):
            workspace = self.target.workspace
            self._workspace = (
                Path.cwd().resolve()
                if workspace is None
                else Path(workspace).expanduser().resolve()
            )
        self._opened = True

    def _native(self, *, static: bool = False) -> NativeProcess:
        if self._closed:
            raise ClientClosedError("the Zeroshot client is closed")
        if not static and isinstance(self.target, DirectTarget) and not self._direct_ready:
            raise RuntimeError("direct target routing has not been prepared")
        environment, secrets = self._environment()
        return NativeProcess(
            resolve_binary(),
            cwd=self._workspace or Path.cwd(),
            environment=environment,
            secrets=secrets,
        )

    def _environment(self) -> tuple[dict[str, str], tuple[str, ...]]:
        if self._provided_environment is None:
            environment = dict(os.environ)
            secrets = _ambient_secrets(environment)
        else:
            environment = {
                name: value
                for name in _OPERATING_ENVIRONMENT
                if (value := os.environ.get(name)) is not None
            }
            environment.update(self._provided_environment)
            secrets = tuple(self._provided_environment.values())
        if isinstance(self.target, LocalTarget) and self.target.state_dir is not None:
            environment["ZEROSHOT_RUST_STATE_DIR"] = str(
                Path(self.target.state_dir).expanduser().resolve()
            )
        if isinstance(self.target, DirectTarget) and self._direct_directory is not None:
            environment["ZEROSHOT_RUST_CONFIG_DIR"] = self._direct_directory.name
        environment["ZEROSHOT_RUST_ERROR_FORMAT"] = "json"
        return environment, secrets

    def _route_arguments(self) -> list[str]:
        return ["--target", "python-sdk"] if isinstance(self.target, DirectTarget) else []

    async def _status(self, run_id: str) -> RunStatus:
        await self._ready()
        value = await self._native().json(["status", run_id, *self._route_arguments()])
        return _status(value)

    async def _watch(self, run_id: str, after: str | None) -> AsyncGenerator[RunStatus, None]:
        await self._ready()
        arguments = ["watch", run_id]
        if after is not None:
            arguments.extend(["--after", after])
        stream = self._native().json_lines([*arguments, *self._route_arguments()])
        async with aclosing(stream) as values:
            async for value in values:
                yield _status(value)

    async def _logs(
        self,
        run_id: str,
        after: str | None,
        execution: str | None,
    ) -> AsyncGenerator[LogEvent, None]:
        await self._ready()
        arguments = ["logs", run_id]
        if after is not None:
            arguments.extend(["--after", after])
        if execution is not None:
            arguments.extend(["--execution", execution])
        stream = self._native().json_lines([*arguments, *self._route_arguments()])
        async with aclosing(stream) as values:
            async for value in values:
                yield _log_event(value)

    async def _force_stop(self, run_id: str) -> RunStatus:
        await self._ready()
        value = await self._native().json(["force-stop", run_id, *self._route_arguments()])
        return _status(value)


class Run:
    """Durable public run handle bound to one Client target."""

    __slots__ = ("_client", "_id")

    def __init__(self, client: Client, run_id: str) -> None:
        self._client = client
        self._id = run_id

    @property
    def id(self) -> str:
        """Return the opaque public Rust run identity."""
        return self._id

    async def status(self) -> RunStatus:
        """Read the current durable run status.

        Returns:
            The latest target projection.

        Raises:
            RunNotFoundError: If the target no longer retains this run.
            TargetError: If the selected target is unavailable.
            ProtocolError: If native output is malformed.
        """
        return await self._client._status(self.id)

    def watch(self, *, after: str | None = None) -> AsyncIterator[RunStatus]:
        """Open a durable status stream strictly after an optional cursor.

        Args:
            after: Last consumed opaque status cursor. None replays retained history.

        Returns:
            An async iterator of immutable status snapshots.

        Cancelling or closing the iterator detaches observation and does not stop the run.
        """
        return self._client._watch(self.id, after)

    def logs(
        self,
        *,
        after: str | None = None,
        execution: str | None = None,
    ) -> AsyncIterator[LogEvent]:
        """Open the durable redacted log stream with resume and execution filters.

        Args:
            after: Last consumed opaque log cursor. None replays retained logs.
            execution: Opaque execution selector from RunStatus, or None for all records.

        Returns:
            An async iterator of safe native log records.

        Cancelling or closing the iterator detaches observation and does not stop the run.
        """
        return self._client._logs(self.id, after, execution)

    async def wait(self, *, wait_timeout: float | None = None) -> RunResult:
        """Wait for the durable terminal result without controlling run lifetime.

        Args:
            wait_timeout: Non-negative observation deadline in seconds. None waits indefinitely.

        Returns:
            The successful or failed terminal result.

        Raises:
            ValueError: If wait_timeout is negative.
            RunWaitTimeout: If the deadline expires. The exception carries this run handle.
            RunNotFoundError: If the target no longer retains this run.
            TargetError: If observation fails.
            ProtocolError: If native output is malformed.

        Python task cancellation remains asyncio.CancelledError and leaves the run active.
        """
        if wait_timeout is not None and wait_timeout < 0:
            raise ValueError("wait_timeout must be non-negative")

        async def observe() -> RunResult:
            current = await self.status()
            if current.result is not None:
                return current.result
            stream = self._client._watch(self.id, current.cursor)
            async with aclosing(stream) as statuses:
                async for status in statuses:
                    if status.result is not None:
                        return status.result
            current = await self.status()
            if current.result is not None:
                return current.result
            raise ProtocolError("Zeroshot Rust watch closed before a terminal result")

        if wait_timeout is None:
            return await observe()
        try:
            async with asyncio.timeout(wait_timeout):
                return await observe()
        except TimeoutError as error:
            raise RunWaitTimeout(self, wait_timeout) from error

    async def force_stop(self) -> RunResult:
        """Force-stop this run and wait for its durable terminal result.

        Returns:
            The existing terminal result, or a failed result whose reason is force_stopped.

        Raises:
            RunNotFoundError: If the target no longer retains this run.
            TargetError: If mutation or observation fails.
            ProtocolError: If native output is malformed.
        """
        status = await self._client._force_stop(self.id)
        if status.result is not None:
            return status.result
        return await self.wait()


def _submission_key() -> str:
    return f"python-{uuid.uuid4().hex}"


def _overrides(options: _SubmitOptions) -> _Overrides:
    return _Overrides(
        options.get("title"),
        options.get("preset"),
        options.get("runtime"),
        options.get("branch"),
        options.get("submission_key"),
    )


def _exact_submission(request: RunRequest, overrides: _Overrides) -> _Submission:
    if any(
        value is not None
        for value in (
            overrides.title,
            overrides.preset,
            overrides.runtime,
            overrides.branch,
            overrides.submission_key,
        )
    ):
        raise TypeError("RunRequest cannot be combined with string-submission overrides")
    return _Submission(
        title=request.title,
        graph=request.graph,
        initial_input=request.initial_input,
        runtime=request.runtime,
        branch=request.branch,
        submission_key=(
            request.submission_key if request.submission_key is not None else _submission_key()
        ),
    )


def _write_json(path: Path, value: JsonValue) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _ambient_secrets(environment: Mapping[str, str]) -> tuple[str, ...]:
    markers = ("KEY", "TOKEN", "SECRET", "PASSWORD")
    return tuple(
        value
        for name, value in environment.items()
        if any(marker in name.upper() for marker in markers)
    )
