#!/usr/bin/env python3
"""
PreToolUse hook to block dangerous git commands in zeroshot worktree mode.

This hook is loaded from a per-run Zeroshot settings overlay and only activates
when the environment variable ZEROSHOT_WORKTREE=1 is set.

Blocks:
- git stash (all forms) - hides work from other agents
- git checkout -- <file> - discards uncommitted changes
- git checkout -f / git checkout . - discards all local changes
- git reset --hard - destroys commits AND changes
- git push --force / -f - rewrites remote history
- git clean -f/-fd - deletes untracked files
- git branch -D - force deletes unmerged branch
- git rebase -i / git add -i/-p - interactive (hangs in non-interactive mode)

Exit codes:
- 0 with JSON: Normal execution (allow/deny decision)
- 0 without output: No decision (pass through)
"""

import json
import os
import re
import sys
from typing import Optional, Tuple


# Patterns that should be BLOCKED
# Each tuple: (pattern, reason, safe_alternative)
DANGEROUS_PATTERNS = [
    # Stash - hides work from other agents
    (r"\bgit\s+stash\b",
     "git stash hides work from other agents",
     "Use 'git add -A && git commit -m \"WIP: ...\"' instead"),

    # Checkout discarding changes
    (r"\bgit\s+checkout\s+--\s+\S+",
     "git checkout -- <file> discards uncommitted changes permanently",
     "Commit your work first: 'git add -A && git commit -m \"WIP: ...\"'"),

    (r"\bgit\s+checkout\s+-f\b",
     "git checkout -f discards ALL local changes permanently",
     "Commit your work first: 'git add -A && git commit -m \"WIP: ...\"'"),

    (r"\bgit\s+checkout\s+\.\s*$",
     "git checkout . discards all changes in the directory",
     "Commit your work first: 'git add -A && git commit -m \"WIP: ...\"'"),

    # Reset --hard
    (r"\bgit\s+reset\s+--hard\b",
     "git reset --hard destroys commits AND uncommitted changes",
     "Use 'git reset --soft' to keep changes, or 'git revert' to undo commits"),

    # Force push
    (r"\bgit\s+push\s+--force\b",
     "git push --force rewrites remote history",
     "Use 'git push' (normal push) or 'git pull --rebase' to sync"),

    (r"\bgit\s+push\s+-f\b",
     "git push -f rewrites remote history",
     "Use 'git push' (normal push) or 'git pull --rebase' to sync"),

    # Clean with force
    (r"\bgit\s+clean\s+-[fd]*f",
     "git clean -f deletes untracked files permanently",
     "Use 'git clean -n' (dry run) first to see what would be deleted"),

    # Branch force delete
    (r"\bgit\s+branch\s+-D\b",
     "git branch -D force deletes unmerged branch",
     "Use 'git branch -d' (lowercase) which only deletes merged branches"),

    # Interactive commands (hang in non-interactive mode)
    (r"\bgit\s+rebase\s+-i\b",
     "git rebase -i is interactive and will hang in non-interactive mode",
     "Use 'git reset --soft HEAD~N' to undo commits while keeping changes"),

    (r"\bgit\s+add\s+-[ip]\b",
     "git add -i/-p is interactive and will hang in non-interactive mode",
     "Use 'git add <files>' or 'git add -A' instead"),
]


def check_command(command: str) -> Optional[Tuple[bool, str, str]]:
    """Check if command matches any dangerous pattern.

    Returns (matched, reason, alternative) if dangerous, None if safe.

    NOTE: We do NOT use re.IGNORECASE because git flags are case-sensitive.
    For example: 'git branch -d' (lowercase) is safe, 'git branch -D' (uppercase) is dangerous.
    """
    for pattern, reason, alternative in DANGEROUS_PATTERNS:
        if re.search(pattern, command):
            return (True, reason, alternative)
    return None


def main():
    # Only activate in zeroshot worktree mode
    if os.environ.get("ZEROSHOT_WORKTREE") != "1":
        # Not in worktree mode - pass through without decision
        sys.exit(0)

    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        # Invalid input - let it through
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")

    # Only check Bash tool
    if tool_name != "Bash":
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    command = tool_input.get("command", "")

    # Check for dangerous patterns
    result = check_command(command)
    if result:
        _, reason, alternative = result
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"[GIT-SAFE BLOCKED] {reason}\n\n"
                    f"Safe alternative: {alternative}\n\n"
                    "NO BYPASS EXISTS. Use the safe alternative above."
                )
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    # Command is safe - no decision (let normal permissions apply)
    sys.exit(0)


if __name__ == "__main__":
    main()
