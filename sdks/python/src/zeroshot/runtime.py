"""Targets, graphs, and runtimes accepted by the Zeroshot Python SDK."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from os import PathLike
from typing import TypeAlias

from .values import JsonValue


@dataclass(frozen=True, slots=True)
class LocalTarget:
    """Execute against the local Zeroshot Rust controller.

    Args:
        workspace: Git workspace used in place by new runs. None captures the current directory
            when the client opens.
        state_dir: Optional native controller state directory. Reuse it to observe local runs from
            later client instances; None uses the native package-owned default.
    """

    workspace: str | PathLike[str] | None = None
    state_dir: str | PathLike[str] | None = field(default=None, kw_only=True)


@dataclass(frozen=True, slots=True)
class DirectTarget:
    """Connect to an auth-less Zeroshot Rust target, including the Docker image.

    Args:
        origin: Target HTTP(S) origin. Native validation permits plain HTTP only on loopback.
        repository: GitHub repository in owner/name form used for source resolution.
        default_branch: Default source branch. A request-level branch overrides this value.
    """

    origin: str
    repository: str = field(kw_only=True)
    default_branch: str | None = field(default=None, kw_only=True)


Target: TypeAlias = LocalTarget | DirectTarget


@dataclass(frozen=True, slots=True)
class Preset:
    """Select a Rust-owned built-in graph template.

    Args:
        name: Exact name returned by Client.list_presets().
        delivery: Native delivery selector: none, pull_request, or merge.
    """

    name: str
    delivery: str = field(default="none", kw_only=True)


@dataclass(frozen=True, slots=True)
class _OpaqueDocument:
    document: Mapping[str, JsonValue]

    def __post_init__(self) -> None:
        object.__setattr__(self, "document", deepcopy(dict(self.document)))

    def to_dict(self) -> dict[str, JsonValue]:
        return deepcopy(dict(self.document))


@dataclass(frozen=True, slots=True)
class GraphSpec(_OpaqueDocument):
    """Lossless custom GraphSpec passed unchanged to Zeroshot Rust.

    Args:
        document: JSON-compatible GraphSpec mapping. Python performs no semantic validation.
    """

    @classmethod
    def from_dict(cls, value: Mapping[str, JsonValue]) -> GraphSpec:
        """Construct an opaque GraphSpec without validating or traversing it."""
        return cls(value)

    def to_dict(self) -> dict[str, JsonValue]:
        """Return a defensive mutable copy suitable for native JSON encoding."""
        return _OpaqueDocument.to_dict(self)


@dataclass(frozen=True, slots=True, kw_only=True)
class UniformRuntime:
    """Ask Rust to bind one agent runtime across every executable graph node.

    Args:
        provider: Native provider name.
        model: Native model identifier.
        harness: Optional codex or claude override. Rust infers it only when unambiguous.
        effort: Optional native reasoning effort.
        size: Native run size.
        session_scope: Native execution or node_instance session scope.
        env: Environment variable names available to agent nodes. Rust owns provider defaults when
            this tuple is empty; values are read only from Client.environment.
    """

    provider: str
    model: str
    harness: str | None = None
    effort: str | None = None
    size: str = "standard"
    session_scope: str = "execution"
    env: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, JsonValue]:
        """Encode the declarative uniform runtime consumed and validated by Rust."""
        value: dict[str, JsonValue] = {
            "provider": self.provider,
            "model": self.model,
            "size": self.size,
            "sessionScope": self.session_scope,
        }
        if self.harness is not None:
            value["harness"] = self.harness
        if self.effort is not None:
            value["effort"] = self.effort
        if self.env:
            value["env"] = list(self.env)
        return value


@dataclass(frozen=True, slots=True)
class RuntimePlan(_OpaqueDocument):
    """Lossless exact native runtime plan passed unchanged to Zeroshot Rust.

    Args:
        document: JSON-compatible RuntimePlan mapping. Python performs no semantic validation.
    """

    @classmethod
    def from_dict(cls, value: Mapping[str, JsonValue]) -> RuntimePlan:
        """Construct an opaque RuntimePlan without validating graph bindings."""
        return cls(value)

    def to_dict(self) -> dict[str, JsonValue]:
        """Return a defensive mutable copy suitable for native JSON encoding."""
        return _OpaqueDocument.to_dict(self)
