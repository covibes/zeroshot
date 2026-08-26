"""Build a platform wheel containing the matching Zeroshot Rust executable."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.bdist_wheel import bdist_wheel
from setuptools.command.build_py import build_py

_BINARY_ENV = "ZEROSHOT_RUST_BINARY"
_PLATFORM_ENV = "ZEROSHOT_PYTHON_WHEEL_PLATFORM"


def _binary_source() -> Path | None:
    value = os.environ.get(_BINARY_ENV)
    return Path(value).resolve() if value else None


class BuildPythonWithNative(build_py):
    """Copy the release-provided native executable into the wheel build tree."""

    def run(self) -> None:
        package_root = Path(self.build_lib, "zeroshot")
        if package_root.exists():
            shutil.rmtree(package_root)
        super().run()
        source = _binary_source()
        if source is None:
            return
        if not source.is_file():
            raise RuntimeError(f"{_BINARY_ENV} does not identify a file: {source}")
        executable = "zeroshot-rust.exe" if os.name == "nt" else "zeroshot-rust"
        destination = package_root / "_bin" / executable
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


class PlatformWheel(bdist_wheel):
    """Produce one Python-independent wheel for the bundled native platform."""

    def finalize_options(self) -> None:
        super().finalize_options()
        self.root_is_pure = False

    def run(self) -> None:
        if _binary_source() is None:
            raise RuntimeError(f"{_BINARY_ENV} is required when building a wheel")
        super().run()

    def get_tag(self) -> tuple[str, str, str]:
        _, _, detected_platform = super().get_tag()
        platform = os.environ.get(_PLATFORM_ENV, detected_platform)
        return "py3", "none", platform


setup(
    cmdclass={"bdist_wheel": PlatformWheel, "build_py": BuildPythonWithNative},
    version=os.environ.get("ZEROSHOT_PYTHON_VERSION", "0.0.0.dev0"),
)
