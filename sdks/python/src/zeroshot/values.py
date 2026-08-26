"""Shared closed JSON value typing for the Zeroshot Python SDK."""

from __future__ import annotations

from typing import TypeAlias

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
