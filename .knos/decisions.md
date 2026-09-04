# Decisions and current work

<!-- Written by `knos export`. Commit this file. -->

A second clone reads this on its first question — it is one of the decision
records knos looks for. Nothing here is private: secrets and private paths
never reach it.


## Decisions

- **never spawn without permission** — Do not run `zeroshot run <id>` unless the user explicitly asks to run it.  _(AGENTS.md, CRITICAL RULES)_
- **no git in validator prompts** — Validators check files directly rather than shelling out to git.  _(AGENTS.md, CRITICAL RULES)_
- **agents never ask questions** — Runs are non-interactive; an agent makes the autonomous decision rather than blocking on input.  _(AGENTS.md, CRITICAL RULES)_
- **main is the only trunk** — Target normal PRs at `main`. Never recreate a long-lived `dev -> main` release-promotion flow.  _(AGENTS.md, CRITICAL RULES)_
- **PR titles are conventional commits** — Squash merge makes the title the released commit, so `fix:`/`perf:` publish patches, `feat:` minors, and `docs:`/`chore:` intentionally publish nothing.  _(AGENTS.md, CRITICAL RULES)_
- **manifests are non-authoritative** — Checked-in publication manifests are development versions; release tags, npm metadata and GitHub Releases are authoritative, and automation never commits versions to `main`.  _(AGENTS.md, CRITICAL RULES)_
- **isolation copies reuse the pinned root** — Traversal, directory creation and copies go through the shared pinned-root boundary in `src/copy-containment.ts`, revalidated immediately before every filesystem effect.  _(AGENTS.md, CRITICAL RULES)_

## Being worked on right now

_Nothing claimed._

---
<sub>knos export. Claims lapse after 30 minutes.</sub>
