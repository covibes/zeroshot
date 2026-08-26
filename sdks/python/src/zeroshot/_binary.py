"""Locate the bundled native sidecar."""

from __future__ import annotations

import os
from importlib.resources import files
from pathlib import Path

from .errors import TargetError

_OVERRIDE_ENV = "ZEROSHOT_PYTHON_NATIVE_BINARY"


def resolve_binary() -> Path:
    """Resolve the private development override or platform wheel executable."""
    override = os.environ.get(_OVERRIDE_ENV)
    if override:
        binary = Path(override).expanduser().resolve()
    else:
        executable = "zeroshot-rust.exe" if os.name == "nt" else "zeroshot-rust"
        binary = Path(str(files("zeroshot").joinpath("_bin", executable)))
    if not binary.is_file():
        raise TargetError(
            "the Zeroshot Rust sidecar is missing; install a supported platform wheel"
        )
    return binary
