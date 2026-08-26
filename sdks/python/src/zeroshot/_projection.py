"""Strict projections from native JSON into public immutable read models."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal, TypeAlias, cast

from .errors import ProtocolError
from .runs import ActiveExecution, LogEvent, ResolvedSource, RunResult, RunStatus, RunSummary
from .values import JsonValue

_Size: TypeAlias = Literal["tiny", "small", "standard", "large"]
_Phase: TypeAlias = Literal["admitted", "running", "stopping", "finished"]
_Level: TypeAlias = Literal["debug", "info", "error"]


def _status(value: object) -> RunStatus:
    root = _mapping(value, "run status")
    native_status = _mapping(root.get("status"), "run status.status")
    phase = cast(
        _Phase,
        _enum_string(
            native_status,
            "phase",
            {"admitted", "running", "stopping", "finished"},
            "run status.status",
        ),
    )
    active = tuple(
        ActiveExecution(
            execution=_string(item, "execution", "active execution"),
            node=_string(item, "node", "active execution"),
        )
        for item in _mapping_list(
            native_status.get("activeExecutions", []),
            "run status.status.activeExecutions",
        )
    )
    result = None
    if phase == "finished":
        result = _terminal_result(
            _string(root, "runId", "run status"),
            native_status.get("terminalResult"),
        )
    return RunStatus(
        run_id=_string(root, "runId", "run status"),
        title=_string(root, "title", "run status"),
        source=_source(root.get("source")),
        size=cast(
            _Size,
            _enum_string(
                root,
                "size",
                {"tiny", "small", "standard", "large"},
                "run status",
            ),
        ),
        cursor=_cursor(root),
        phase=phase,
        active_executions=active,
        result=result,
    )


def _summary(status: RunStatus) -> RunSummary:
    failure = status.result.failure if status.result is not None else None
    return RunSummary(
        run_id=status.run_id,
        title=status.title,
        source=status.source,
        size=status.size,
        cursor=status.cursor,
        phase=status.phase,
        force_stop_requested=status.phase == "stopping" or failure == "force_stopped",
    )


def _log_event(value: object) -> LogEvent:
    root = _mapping(value, "log event")
    record = _mapping(root.get("record"), "log event.record")
    execution = root.get("execution")
    if execution is not None and not isinstance(execution, str):
        raise ProtocolError("Zeroshot Rust emitted a non-string log execution selector")
    return LogEvent(
        run_id=_string(root, "runId", "log event"),
        cursor=_string(root, "cursor", "log event"),
        execution=execution,
        level=cast(
            _Level,
            _enum_string(record, "level", {"debug", "info", "error"}, "log event.record"),
        ),
        target=_string(record, "target", "log event.record"),
        message=_string(record, "message", "log event.record"),
    )


def _source(value: object) -> ResolvedSource:
    source = _mapping(value, "run status.source")
    return ResolvedSource(
        repository=_string(source, "repository", "run status.source"),
        branch=_string(source, "branch", "run status.source"),
        revision=_string(source, "revision", "run status.source"),
    )


def _terminal_result(run_id: str, value: object) -> RunResult:
    terminal = _mapping(value, "run status.status.terminalResult")
    kind = _enum_string(
        terminal,
        "status",
        {"succeeded", "failed"},
        "run status.status.terminalResult",
    )
    if kind == "succeeded":
        if "output" not in terminal:
            raise ProtocolError("Zeroshot Rust omitted terminal success output")
        return RunResult(
            run_id=run_id,
            succeeded=True,
            output=cast(JsonValue, terminal["output"]),
        )
    return RunResult(
        run_id=run_id,
        succeeded=False,
        failure=_string(terminal, "reason", "run status.status.terminalResult"),
    )


def _cursor(value: Mapping[str, object]) -> str:
    for name in ("cursor", "atCursor"):
        candidate = value.get(name)
        if isinstance(candidate, str):
            return candidate
    raise ProtocolError("Zeroshot Rust omitted the run status cursor")


def _mapping(value: object, kind: str) -> Mapping[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ProtocolError(f"Zeroshot Rust emitted malformed {kind}")
    return value


def _mapping_list(value: object, kind: str) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, list):
        raise ProtocolError(f"Zeroshot Rust emitted malformed {kind}")
    return tuple(_mapping(item, kind) for item in value)


def _string(value: Mapping[str, object], name: str, kind: str) -> str:
    selected = value.get(name)
    if not isinstance(selected, str):
        raise ProtocolError(f"Zeroshot Rust emitted malformed {kind}.{name}")
    return selected


def _enum_string(
    value: Mapping[str, object],
    name: str,
    allowed: set[str],
    kind: str,
) -> str:
    selected = _string(value, name, kind)
    if selected not in allowed:
        raise ProtocolError(f"Zeroshot Rust emitted unsupported {kind}.{name} {selected!r}")
    return selected
