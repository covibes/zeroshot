"""Hermetic fake-native fixture for SDK contract tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_FAKE_NATIVE = r"""#!/usr/bin/env python3
import json
import os
import sys
import time

args = sys.argv[1:]
log_path = os.environ.get("FAKE_ZEROSHOT_LOG")

def option(name):
    try:
        return args[args.index(name) + 1]
    except ValueError:
        return None

def projection(run_id, status, cursor):
    return {
        "runId": run_id,
        "title": "Fake run",
        "source": {
            "repository": "owner/repo",
            "branch": "main",
            "revision": "0" * 40,
        },
        "size": "standard",
        "atCursor": cursor,
        "status": status,
    }

entry = {"args": args}
for name in ("--input", "--graph", "--runtime-config", "--uniform-runtime-config"):
    path = option(name)
    if path:
        with open(path, encoding="utf-8") as stream:
            entry[name] = json.load(stream)
if log_path:
    with open(log_path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry) + "\n")

if args == ["--version"]:
    print("zeroshot-rust 0.3.1")
elif args[:2] == ["template", "list"]:
    print(json.dumps(["single-worker", "software-change"]))
elif args[:2] == ["template", "show"]:
    print(json.dumps({
        "profile": "openengine.graph.full/v1",
        "name": args[2],
        "delivery": option("--delivery"),
    }))
elif args[:2] == ["target", "add"] or args[:2] == ["target", "setup"]:
    pass
elif args and args[0] == "run":
    task = entry.get("--input", {}).get("task")
    if task == "invalid":
        secret = os.environ.get("OPENROUTER_API_KEY", "")
        print(json.dumps({
            "schema": "zeroshot.error/v1",
            "kind": "invalid_request",
            "code": "runtime.missing_binding",
            "message": (
                "run validation failed: runtime plan has no binding "
                f"for executable node worker; secret={secret}"
            ),
            "path": None,
            "node": "worker",
            "details": {"nativeMessage": f"secret={secret}"},
        }), file=sys.stderr)
        raise SystemExit(1)
    if "--validate-only" in args:
        print(json.dumps({"valid": True}))
    else:
        print(json.dumps({"runId": "01900000-0000-7000-8000-000000000001"}))
elif args and args[0] == "list":
    runs = []
    if os.environ.get("FAKE_LIST_ONE") == "1":
        runs.append(
            projection(
                args[1] if len(args) > 1 else "run-listed",
                {"phase": "admitted"},
                "v2:0",
            )
        )
    print(json.dumps({"runs": runs}))
elif args and args[0] == "status":
    print(json.dumps(projection(args[1], {"phase": "admitted"}, "v2:0")))
elif args and args[0] == "watch":
    time.sleep(float(os.environ.get("FAKE_WATCH_DELAY", "0")))
    running = projection(
        args[1],
        {
            "phase": "running",
            "activeExecutions": [{"execution": "worker-1", "node": "worker"}],
        },
        "v2:1",
    )
    running["cursor"] = running.pop("atCursor")
    print(json.dumps(running), flush=True)
    finished = projection(
        args[1],
        {
            "phase": "finished",
            "terminalResult": {"status": "succeeded", "output": {"ok": True}},
        },
        "v2:2",
    )
    finished["cursor"] = finished.pop("atCursor")
    print(json.dumps(finished), flush=True)
elif args and args[0] == "logs":
    event = {
        "runId": args[1],
        "cursor": "v2:3",
        "record": {"level": "info", "target": "agent", "message": "done"},
    }
    if option("--execution") is not None:
        event["execution"] = option("--execution")
    print(json.dumps(event))
elif args and args[0] == "force-stop":
    print(json.dumps(projection(
        args[1],
        {
            "phase": "finished",
            "terminalResult": {"status": "failed", "reason": "force_stopped"},
        },
        "v2:4",
    )))
else:
    print(f"zeroshot-rust: unsupported fake arguments: {args}", file=sys.stderr)
    raise SystemExit(1)
"""


@pytest.fixture
def fake_native(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Install a fake sidecar and expose its invocation log to a test."""
    executable = tmp_path / "zeroshot-rust"
    executable.write_text(_FAKE_NATIVE, encoding="utf-8")
    executable.chmod(0o755)
    log = tmp_path / "native.jsonl"
    monkeypatch.setenv("ZEROSHOT_PYTHON_NATIVE_BINARY", str(executable))
    monkeypatch.setenv("FAKE_ZEROSHOT_LOG", str(log))
    return log


def read_invocations(path: Path) -> list[dict[str, object]]:
    """Decode every fake-native invocation recorded at path."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
