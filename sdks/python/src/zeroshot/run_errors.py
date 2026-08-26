"""Run-specific public exceptions for the Zeroshot Python SDK."""

from __future__ import annotations

from typing import Protocol

from .errors import TargetError, ZeroshotError


class _RunHandle(Protocol):
    @property
    def id(self) -> str: ...


class _FailedResult(Protocol):
    @property
    def run_id(self) -> str: ...

    @property
    def failure(self) -> str | None: ...


class RunNotFoundError(TargetError):
    """Raised when a target retains no run with the requested public identity."""


class SubmissionConflictError(TargetError):
    """Raised when an idempotency key conflicts with a different submission.

    Args:
        message: Secret-safe native conflict diagnostic.
        existing_run_id: Public identity already bound to the submission key.
    """

    def __init__(
        self,
        message: str,
        *,
        existing_run_id: str,
        exit_code: int | None = None,
    ) -> None:
        super().__init__(message, exit_code=exit_code)
        self.existing_run_id = existing_run_id


class RunWaitTimeout(ZeroshotError):
    """Raised when observation times out while the durable run remains active.

    Args:
        run: Durable run handle that can resume observation while its client remains open.
        wait_timeout: Caller-supplied non-negative deadline in seconds.
    """

    def __init__(self, run: _RunHandle, wait_timeout: float) -> None:
        super().__init__(f"run {run.id} did not finish within {wait_timeout} seconds")
        self.run = run
        self.wait_timeout = wait_timeout


class RunFailedError(ZeroshotError):
    """Raised only by RunResult.raise_for_failure().

    Args:
        result: Failed terminal result being projected as an exception.
    """

    def __init__(self, result: _FailedResult) -> None:
        super().__init__(result.failure or f"run {result.run_id} failed")
        self.result = result
