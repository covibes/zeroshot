#!/usr/bin/env python3
"""
PreToolUse hook to block AskUserQuestion in zeroshot agent mode.

This hook is loaded from a per-run Zeroshot settings overlay and only activates
when the environment variable ZEROSHOT_BLOCK_ASK_USER=1 is set.

Exit codes:
- 0 with JSON: Normal execution (allow/deny decision)
- 0 without output: No decision (pass through)
"""

import json
import os
import sys

def main():
    # Only activate in zeroshot mode (env var set by agent-wrapper)
    if os.environ.get("ZEROSHOT_BLOCK_ASK_USER") != "1":
        # Not in zeroshot mode - pass through without decision
        sys.exit(0)

    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        # Invalid input - let it through
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")

    if tool_name == "AskUserQuestion":
        # Block the tool with a clear explanation
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "AskUserQuestion is BLOCKED in zeroshot cluster mode. "
                    "You are running non-interactively with no user to respond. "
                    "Make autonomous decisions instead. "
                    "If choosing between 'fix code' vs 'relax rules', ALWAYS fix the code."
                )
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    # All other tools - no decision (let normal permissions apply)
    sys.exit(0)

if __name__ == "__main__":
    main()
