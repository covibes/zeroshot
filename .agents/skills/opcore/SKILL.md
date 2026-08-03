---
name: opcore
description: Use for repository code intelligence and introduced-change validation in Zeroshot.
---

# Opcore

Opcore is Zeroshot's packaged, repository-local constraints gate. It supplements rather than replaces the repository's lint, type, test, CI, and review guardrails.

- Run `npm run opcore:status` before broad work. If the persistent graph is stale, run `npm run opcore:graph:build`; after source changes, refresh it with `npm run opcore:graph:update`.
- Use `opcore graph search`, `impact`, and `review-context`, plus `opcore inspect definition`, `references`, `signature`, and `implementations`, when graph-backed evidence will reduce uncertainty.
- Use `opcore validate hypothetical` or the installed pre-write hook before a proposed write when the harness does not invoke the hook automatically.
- Run `npm run opcore:check` before finalizing source edits. This gate reports only diagnostics introduced relative to the Git base; existing repository debt is not a blocking result.
- Run `npm run opcore:scan` and `npm run opcore:measure` for named repository metrics and deltas, not as opaque ratings.
- Treat unsupported stacks, unavailable tools, stale graphs, and indeterminate results honestly; never report them as clean coverage.
- Preserve all existing repository guardrails. A full-tree `opcore check all` is an audit command, not a blocking commit, CI, or agent gate.
