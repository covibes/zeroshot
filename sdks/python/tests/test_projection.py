"""Strict native projection tests."""

from __future__ import annotations

import pytest

from zeroshot._projection import _log_event
from zeroshot.errors import ProtocolError


def log_event(*, timestamp: object = 1_725_000_000_123) -> dict[str, object]:
    return {
        "runId": "run-1",
        "cursor": "v2:3",
        "timestamp": timestamp,
        "record": {"level": "info", "target": "agent", "message": "done"},
    }


@pytest.mark.parametrize("timestamp", [1, 1_725_000_000_123, 9_007_199_254_740_991])
def test_log_event_preserves_exact_timestamp(timestamp: int) -> None:
    assert _log_event(log_event(timestamp=timestamp)).timestamp == timestamp


@pytest.mark.parametrize(
    "timestamp",
    [True, 1.0, "1", 0, -1, 9_007_199_254_740_992],
)
def test_log_event_rejects_invalid_timestamp(timestamp: object) -> None:
    with pytest.raises(ProtocolError, match=r"malformed log event\.timestamp"):
        _log_event(log_event(timestamp=timestamp))


def test_log_event_rejects_missing_timestamp() -> None:
    value = log_event()
    del value["timestamp"]
    with pytest.raises(ProtocolError, match=r"malformed log event\.timestamp"):
        _log_event(value)
