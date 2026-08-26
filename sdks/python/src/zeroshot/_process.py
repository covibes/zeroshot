"""Async subprocess transport for the bundled Zeroshot Rust CLI."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any

from .errors import InvalidRequestError, ProtocolError, TargetError, ZeroshotError
from .run_errors import RunNotFoundError, SubmissionConflictError

_ERROR_SCHEMA = "zeroshot.error/v1"


class NativeProcess:
    """Run one native command at a time with secret-redacted diagnostics."""

    def __init__(
        self,
        binary: Path,
        *,
        cwd: Path,
        environment: Mapping[str, str],
        secrets: Sequence[str],
    ) -> None:
        self._binary = binary
        self._cwd = cwd
        self._environment = dict(environment)
        self._secrets = tuple(value for value in secrets if value)

    async def json(self, arguments: Sequence[str]) -> Any:
        """Run a unary command and decode its single JSON value."""
        process = await self._spawn(arguments)
        stdout, stderr = await self._communicate(process)
        return_code = process.returncode
        assert return_code is not None
        if return_code != 0:
            raise self._error(stderr, return_code)
        try:
            return json.loads(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProtocolError("Zeroshot Rust emitted malformed JSON") from error

    async def text(self, arguments: Sequence[str]) -> str:
        """Run a unary command and decode its successful UTF-8 text output."""
        process = await self._spawn(arguments)
        stdout, stderr = await self._communicate(process)
        return_code = process.returncode
        assert return_code is not None
        if return_code != 0:
            raise self._error(stderr, return_code)
        try:
            return stdout.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ProtocolError("Zeroshot Rust emitted malformed UTF-8") from error

    async def check(self, arguments: Sequence[str]) -> None:
        """Run a successful command that intentionally emits no output."""
        process = await self._spawn(arguments)
        _, stderr = await self._communicate(process)
        return_code = process.returncode
        assert return_code is not None
        if return_code != 0:
            raise self._error(stderr, return_code)

    async def json_lines(self, arguments: Sequence[str]) -> AsyncGenerator[Mapping[str, Any], None]:
        """Run an NDJSON command and yield decoded objects until native completion."""
        process = await self._spawn(arguments)
        assert process.stdout is not None
        assert process.stderr is not None
        stderr_task = asyncio.create_task(process.stderr.read())
        try:
            async for line in process.stdout:
                try:
                    value = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ProtocolError("Zeroshot Rust emitted malformed NDJSON") from error
                if not isinstance(value, dict):
                    raise ProtocolError("Zeroshot Rust emitted a non-object NDJSON event")
                yield value
            return_code = await process.wait()
            stderr = await stderr_task
            if return_code != 0:
                raise self._error(stderr, return_code)
        finally:
            await self._stop(process)
            if not process.stdout.at_eof():
                await process.stdout.read()
            if not stderr_task.done():
                stderr_task.cancel()
            with suppress(asyncio.CancelledError):
                await stderr_task

    async def _spawn(self, arguments: Sequence[str]) -> asyncio.subprocess.Process:
        spawn = asyncio.create_task(
            asyncio.create_subprocess_exec(
                str(self._binary),
                *arguments,
                cwd=self._cwd,
                env=self._environment,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        )
        try:
            return await asyncio.shield(spawn)
        except asyncio.CancelledError:
            process = await spawn
            await self._stop_and_communicate(process)
            raise
        except OSError as error:
            raise TargetError(f"could not start Zeroshot Rust: {error}") from error

    async def _communicate(self, process: asyncio.subprocess.Process) -> tuple[bytes, bytes]:
        try:
            return await process.communicate()
        except asyncio.CancelledError:
            await self._stop_and_communicate(process)
            raise

    async def _stop_and_communicate(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.communicate(), timeout=2)
        except TimeoutError:
            process.kill()
            await process.communicate()

    async def _stop(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except TimeoutError:
            process.kill()
            await process.wait()

    def _error(self, stderr: bytes, exit_code: int) -> ZeroshotError:
        raw = stderr.decode("utf-8", errors="replace").strip()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = None
        if isinstance(value, dict) and value.get("schema") == _ERROR_SCHEMA:
            redacted = _redact_value(value, self._secrets)
            assert isinstance(redacted, dict)
            return _project_diagnostic(redacted, exit_code)
        message = _redact_text(raw, self._secrets)
        if message.startswith("zeroshot-rust: "):
            message = message.removeprefix("zeroshot-rust: ")
        message = message or "Zeroshot Rust exited unsuccessfully"
        return TargetError(message, exit_code=exit_code)


def _project_diagnostic(value: Mapping[str, Any], exit_code: int) -> ZeroshotError:
    kind = value.get("kind")
    code = value.get("code")
    message = value.get("message")
    details = value.get("details")
    node = value.get("node")
    path = value.get("path")
    if not _valid_diagnostic_fields(kind, code, message, details, node, path):
        return _malformed_diagnostic()
    assert isinstance(kind, str)
    assert isinstance(code, str)
    assert isinstance(message, str)
    assert isinstance(details, dict)
    assert node is None or isinstance(node, str)
    projector = _DIAGNOSTIC_PROJECTORS.get(kind)
    if projector is None:
        return ProtocolError("Zeroshot Rust emitted an unknown error diagnostic kind")
    return projector(message, code, details, node, _diagnostic_path(path), exit_code)


def _valid_diagnostic_fields(
    kind: Any,
    code: Any,
    message: Any,
    details: Any,
    node: Any,
    path: Any,
) -> bool:
    scalars_valid = isinstance(kind, str) and isinstance(code, str) and isinstance(message, str)
    node_valid = node is None or isinstance(node, str)
    path_valid = path is None or _diagnostic_path(path) is not None
    return scalars_valid and isinstance(details, dict) and node_valid and path_valid


def _malformed_diagnostic() -> ProtocolError:
    return ProtocolError("Zeroshot Rust emitted a malformed error diagnostic")


def _invalid_request_diagnostic(
    message: str,
    code: str,
    details: dict[str, Any],
    node: str | None,
    path: tuple[str | int, ...] | None,
    _exit_code: int,
) -> InvalidRequestError:
    return InvalidRequestError(message, code=code, path=path, node=node, details=details)


def _run_not_found_diagnostic(
    message: str,
    _code: str,
    _details: dict[str, Any],
    _node: str | None,
    _path: tuple[str | int, ...] | None,
    exit_code: int,
) -> RunNotFoundError:
    return RunNotFoundError(message, exit_code=exit_code)


def _submission_conflict_diagnostic(
    message: str,
    _code: str,
    details: dict[str, Any],
    _node: str | None,
    _path: tuple[str | int, ...] | None,
    exit_code: int,
) -> SubmissionConflictError:
    existing = details.get("existingRunId")
    return SubmissionConflictError(
        message,
        existing_run_id=existing if isinstance(existing, str) else "",
        exit_code=exit_code,
    )


def _protocol_diagnostic(
    message: str,
    _code: str,
    _details: dict[str, Any],
    _node: str | None,
    _path: tuple[str | int, ...] | None,
    _exit_code: int,
) -> ProtocolError:
    return ProtocolError(message)


def _target_diagnostic(
    message: str,
    _code: str,
    _details: dict[str, Any],
    _node: str | None,
    _path: tuple[str | int, ...] | None,
    exit_code: int,
) -> TargetError:
    return TargetError(message, exit_code=exit_code)


def _diagnostic_path(value: Any) -> tuple[str | int, ...] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        return None
    if not all(isinstance(item, str) or type(item) is int for item in value):
        return None
    return tuple(value)


def _redact_text(value: str, secrets: Sequence[str]) -> str:
    for secret in secrets:
        value = value.replace(secret, "<redacted>")
    return value


def _redact_value(value: Any, secrets: Sequence[str]) -> Any:
    if isinstance(value, str):
        return _redact_text(value, secrets)
    if isinstance(value, list):
        return [_redact_value(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: _redact_value(item, secrets) for key, item in value.items()}
    return value


_DIAGNOSTIC_PROJECTORS = {
    "invalid_request": _invalid_request_diagnostic,
    "protocol": _protocol_diagnostic,
    "run_not_found": _run_not_found_diagnostic,
    "submission_conflict": _submission_conflict_diagnostic,
    "target": _target_diagnostic,
}
