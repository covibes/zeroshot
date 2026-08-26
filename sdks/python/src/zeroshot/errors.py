"""Core public exception hierarchy for the Zeroshot Python SDK."""

from __future__ import annotations

from collections.abc import Mapping

from .values import JsonValue


class ZeroshotError(Exception):
    """Base class for every SDK-originated failure."""


class ClientClosedError(ZeroshotError):
    """Raised when an operation uses a client after it has closed."""


class TargetError(ZeroshotError):
    """Raised when the local sidecar or selected target is unavailable.

    Args:
        message: Secret-safe target diagnostic.
        exit_code: Native process exit code when a sidecar command started.
    """

    def __init__(self, message: str, *, exit_code: int | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class ProtocolError(ZeroshotError):
    """Raised when native output is malformed or incompatible."""


class InvalidRequestError(ZeroshotError):
    """Raised when Rust rejects graph, input, runtime, or run options.

    Args:
        message: Complete secret-safe native diagnostic.
        code: Stable machine-readable error category.
        path: Offending JSON path when native diagnostics provide one.
        node: Executable graph node when native diagnostics provide one.
        details: Additional bounded, non-secret native context.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "request.invalid",
        path: tuple[str | int, ...] | None = None,
        node: str | None = None,
        details: Mapping[str, JsonValue] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.path = path
        self.node = node
        self.details = dict(details or {})
