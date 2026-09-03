"""Immutable run request, observation, and result models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .runtime import GraphSpec, RuntimePlan
from .values import JsonValue


@dataclass(frozen=True, slots=True, kw_only=True)
class RunRequest:
    """Exact input for one custom Zeroshot graph run.

    Args:
        title: Human-readable persisted run title.
        graph: Exact opaque GraphSpec.
        initial_input: Exact closed JSON input validated by Rust against the graph.
        runtime: Exact opaque RuntimePlan.
        branch: Direct-target source branch override.
        submission_key: Stable idempotency key; None generates one before native preflight.
    """

    title: str
    graph: GraphSpec
    initial_input: JsonValue
    runtime: RuntimePlan
    branch: str | None = None
    submission_key: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class ResolvedSource:
    """Immutable source snapshot selected by the target.

    Args:
        repository: Native repository identity.
        branch: Attached source branch.
        revision: Exact forty-character Git revision.
    """

    repository: str
    branch: str
    revision: str


@dataclass(frozen=True, slots=True, kw_only=True)
class ActiveExecution:
    """One graph-visible active execution.

    Args:
        execution: Opaque selector accepted by log filtering.
        node: Executable graph node name.
    """

    execution: str
    node: str


@dataclass(frozen=True, slots=True, kw_only=True)
class RunResult:
    """Terminal outcome from Client.run(), Run.wait(), or Run.force_stop().

    Args:
        run_id: Public durable run identity.
        succeeded: Whether the graph completed successfully.
        output: Successful graph output, which may be JSON null.
        failure: Stable nonempty failure reason when succeeded is false.
    """

    run_id: str
    succeeded: bool
    output: JsonValue = None
    failure: str | None = None

    def raise_for_failure(self) -> None:
        """Raise RunFailedError for a failed graph result; otherwise return None."""
        if not self.succeeded:
            from .run_errors import RunFailedError

            raise RunFailedError(self)


@dataclass(frozen=True, slots=True, kw_only=True)
class RunStatus:
    """Current durable projection for one run.

    Args:
        run_id: Public durable run identity.
        title: Immutable persisted title.
        source: Immutable resolved source snapshot.
        size: Native run size.
        cursor: Opaque durable status cursor.
        phase: admitted, running, stopping, or finished.
        active_executions: Every currently active graph execution.
        result: Terminal result only when phase is finished.
    """

    run_id: str
    title: str
    source: ResolvedSource
    size: Literal["tiny", "small", "standard", "large"]
    cursor: str
    phase: Literal["admitted", "running", "stopping", "finished"]
    active_executions: tuple[ActiveExecution, ...] = ()
    result: RunResult | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class RunSummary:
    """Inventory projection returned by Client.list_runs().

    Args:
        run_id: Public durable run identity.
        title: Immutable persisted title.
        source: Immutable resolved source snapshot.
        size: Native run size.
        cursor: Opaque durable status cursor.
        phase: admitted, running, stopping, or finished.
        force_stop_requested: Whether the current projection reflects a force-stop request.
    """

    run_id: str
    title: str
    source: ResolvedSource
    size: Literal["tiny", "small", "standard", "large"]
    cursor: str
    phase: Literal["admitted", "running", "stopping", "finished"]
    force_stop_requested: bool


@dataclass(frozen=True, slots=True, kw_only=True)
class LogEvent:
    """One safe durable native log record.

    Args:
        run_id: Public durable run identity.
        cursor: Opaque durable log cursor.
        timestamp: Producer-captured Unix epoch milliseconds, preserved by replay.
        execution: Opaque execution selector, or None for run-wide records.
        level: Native debug, info, or error level.
        target: Bounded native log target.
        message: Bounded secret-safe message.
    """

    run_id: str
    cursor: str
    timestamp: int
    execution: str | None
    level: Literal["debug", "info", "error"]
    target: str
    message: str
