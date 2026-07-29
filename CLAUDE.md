UPDATE THIS FILE when making architectural changes, adding patterns, or changing conventions.

# Zeroshot: Multi-Agent Coordination Engine

Message-passing primitives for multi-agent workflows. **Install:** `npm i -g @the-open-engine/zeroshot` or `npm link` (dev).

## 🔴 CRITICAL RULES

| Rule                               | Why                          | Forbidden                                    | Required                                         |
| ---------------------------------- | ---------------------------- | -------------------------------------------- | ------------------------------------------------ |
| **GENERAL PURPOSE ONLY**           | Zeroshot runs on ANY repo    | Hardcoded paths, scripts, languages, domains | Discover from target repo's CLAUDE.md/README     |
| **Never spawn without permission** | Consumes API credits         | "I'll run zeroshot on 123"                   | User says "run zeroshot"                         |
| **Never use git in validators**    | Git state unreliable         | `git diff`, `git status` in prompts          | Validate files directly                          |
| **Never ask questions**            | Agents run non-interactively | `AskUserQuestion`, waiting for confirmation  | Make autonomous decisions                        |
| **Never edit CLAUDE.md**           | Context file for Claude Code | Editing this file                            | Read-only unless explicitly asked to update docs |

### 🔴 GENERAL PURPOSE REQUIREMENT (CRITICAL)

**Zeroshot is a GENERAL-PURPOSE multi-agent orchestrator. It MUST work on ANY repository, ANY programming language, ANY domain.**

**FORBIDDEN in templates/prompts:**

- Hardcoded script names (`check-all.sh`, `validate.sh`)
- Hardcoded test commands (`npm test`, `pytest`, `cargo test`)
- Hardcoded file paths (`server/`, `src/`, `tests/`)
- Hardcoded context file names (`CLAUDE.md` - other providers use different files)
- Language-specific assumptions (TypeScript, Python, Rust)
- Domain-specific assumptions (web, CLI, mobile)
- Provider-specific assumptions (Claude, Codex, Gemini)
- Covibes-specific patterns

**REQUIRED:**

- Discover validation commands from target repo's context files (README, Makefile, package.json, pyproject.toml, Cargo.toml, etc.)
- Discover test runners from target repo's build system
- Use generic examples in prompts (e.g., "the repo's validation script" NOT "./scripts/check-all.sh")
- Use generic terms for context files ("repo context files" NOT "CLAUDE.md")
- Work correctly on: Python projects, Rust crates, Go modules, Ruby gems, Java/Kotlin, C/C++, etc.
- Work correctly with: Claude, Codex, Gemini, OpenAI, and any future providers

**Worker git operations:** Allowed with isolation (`--worktree`, `--docker`, `--pr`, `--ship`). Forbidden without isolation (auto-injected restriction).

**Read-only safe:** `zeroshot list`, `zeroshot status`, `zeroshot logs`

**Destructive (needs permission):** `zeroshot kill`, `zeroshot clear`, `zeroshot purge`

**Detached runs:** Always forward `zeroshot run` options via `ZEROSHOT_RUN_OPTIONS` (see `buildDaemonEnv` + `buildStartOptions`) so PR/worktree config survives daemon mode.

## 🔴 BEHAVIORAL STANDARDS

```
WHEN USER POSTS LOGS → THERE IS A BUG. INVESTIGATE.
WHEN TESTS FAIL → Test is source of truth unless PROVEN otherwise.
TEST BEHAVIOR, NOT IMPLEMENTATION. TESTS FIND BUGS, NOT PASS.
READ THE STACK TRACE. FIX ROOT CAUSE, NOT SYMPTOM.
FAIL FAST. Silent failures are worst. Errors > Warnings.
VERIFY ASSUMPTIONS. Don't assume - check.
BUILD WHAT WAS ASKED. Not what you think should be built.
DON'T OVERENGINEER. No abstractions before they're needed.
DON'T REINVENT. Read existing code before writing new.
DON'T SWALLOW ERRORS. Try/catch that ignores = hidden bugs.
IS THIS HOW A SENIOR STAFF ARCHITECT WOULD DO IT? ACT LIKE ONE.
```

## Where to Look

| Concept                  | File                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Conductor classification | `cluster-templates/conductor-bootstrap.json`, `src/orchestrator.js`, `src/template-resolver.js` |
| Base templates           | `cluster-templates/base-templates/`                                                             |
| Message bus              | `src/message-bus.js`                                                                            |
| Ledger (SQLite)          | `src/ledger.js`                                                                                 |
| Trigger evaluation       | `src/logic-engine.js`                                                                           |
| Agent wrapper            | `src/agent-wrapper.js`                                                                          |
| Docker mounts/env        | `lib/docker-config.js`                                                                          |
| Container lifecycle      | `src/isolation-manager.js`                                                                      |
| Issue providers          | `src/issue-providers/`                                                                          |
| Git remote detection     | `lib/git-remote-utils.js`                                                                       |
| Input helpers            | `src/input-helpers.js`                                                                          |
| Settings                 | `lib/settings.js`                                                                               |

## CLI Quick Reference

```bash
# Flag cascade: --ship → --pr → --worktree
zeroshot run 123                  # Local, no isolation
zeroshot run 123 --worktree       # Git worktree isolation
zeroshot run 123 --pr             # Worktree + create PR
zeroshot run 123 --pr --pr-base main # PR base: main, worktree base: origin/main (incl. -d)
zeroshot run 123 --ship           # Worktree + PR + auto-merge
zeroshot run 123 --docker         # Docker container isolation
zeroshot run 123 -d               # Background (daemon) mode

# Management
zeroshot list                     # All clusters (--json)
zeroshot status <id>              # Cluster details
zeroshot logs <id> [-f]           # Stream logs
zeroshot resume <id> [prompt]     # Resume failed cluster
zeroshot stop <id>                # Graceful stop
zeroshot kill <id>                # Force kill

# Utilities
zeroshot export <id>              # Export conversation
zeroshot agents list              # Available agents
zeroshot settings                 # View/modify settings
```

The TUI is not included in this release. Use `zeroshot list`, `zeroshot status <id>`,
and `zeroshot logs <id> -f` or `zeroshot logs <id> -w` for monitoring.

**UX modes:**

- Foreground (`zeroshot run`): Streams logs, Ctrl+C **stops** cluster
- Daemon (`-d`): Background, Ctrl+C detaches
- Attach (`zeroshot attach`): Connect to daemon, Ctrl+C **detaches** only

**Settings:** `maxModel` (opus/sonnet/haiku cost ceiling), `defaultConfig`, `logLevel`

**Git Auto-Detection:** Bare numbers (e.g., `123`) automatically detect provider from git remote URL. No configuration needed when working in a git repository.

Priority order for bare numbers:

1. Force flags (`--github`, `--gitlab`, `--devops`) - Explicit CLI override
2. Git remote detection - Automatic from `git remote get-url origin`
3. Settings (`defaultIssueSource`) - Global user preference
4. Legacy fallback - GitHub (only when no git context and no settings)

## Architecture

**Pub/sub message bus + SQLite ledger.** Agents subscribe to topics, execute on trigger match, publish results.

```
Agent A → publish() → SQLite Ledger → LogicEngine → trigger match → Agent B executes
```

### Core Primitives

| Primitive    | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| Topic        | Named message channel (`ISSUE_OPENED`, `VALIDATION_RESULT`) |
| Trigger      | Condition to wake agent (`{ topic, action, logic }`)        |
| Logic Script | JS predicate for complex conditions                         |
| Hook         | Post-task action (publish message, execute command)         |

### Agent Configuration (Minimal)

```json
{
  "id": "worker",
  "role": "implementation",
  "model": "sonnet",
  "triggers": [{ "topic": "ISSUE_OPENED", "action": "execute_task" }],
  "prompt": "Implement the requested feature...",
  "hooks": {
    "onComplete": {
      "action": "publish_message",
      "config": { "topic": "IMPLEMENTATION_READY" }
    }
  }
}
```

### Logic Script API

```javascript
// Ledger (auto-scoped to cluster)
ledger.query({ topic, sender, since, limit });
ledger.findLast({ topic });
ledger.count({ topic });

// Cluster
cluster.getAgents();
cluster.getAgentsByRole('validator');

// Helpers
helpers.allResponded(agents, topic, since);
helpers.hasConsensus(topic, since);
```

## Conductor: 2D Classification

Classifies tasks on **Complexity × TaskType**, routes to parameterized templates.

| Complexity | Description            | Validators |
| ---------- | ---------------------- | ---------- |
| TRIVIAL    | 1 file, mechanical     | 0          |
| SIMPLE     | 1 concern              | 1          |
| STANDARD   | Multi-file             | 3          |
| CRITICAL   | Auth/payments/security | 5          |

| TaskType | Action                |
| -------- | --------------------- |
| INQUIRY  | Read-only exploration |
| TASK     | Implement new feature |
| DEBUG    | Fix broken code       |

**Base templates:** `single-worker`, `worker-validator`, `debug-workflow`, `full-workflow`

## Isolation Modes

| Mode     | Flag         | Use When                                           |
| -------- | ------------ | -------------------------------------------------- |
| Worktree | `--worktree` | Quick isolated work, PR workflows                  |
| Docker   | `--docker`   | Full isolation, risky experiments, parallel agents |

**Worktree:** Lightweight git branch isolation (<1s setup).

**Docker:** Fresh git clone in container, credentials mounted, auto-cleanup.

## Docker Mount Configuration

Configurable credential mounts for `--docker` mode. See `lib/docker-config.js`.

| Setting                | Type                    | Default              | Description                                           |
| ---------------------- | ----------------------- | -------------------- | ----------------------------------------------------- |
| `dockerMounts`         | `Array<string\|object>` | `['gh','git','ssh']` | Presets or `{host, container, readonly}`              |
| `dockerEnvPassthrough` | `string[]`              | `[]`                 | Extra env vars (supports `VAR`, `VAR_*`, `VAR=value`) |
| `dockerContainerHome`  | `string`                | `/root`              | Container home for `$HOME` expansion                  |

**Mount presets:** `gh`, `git`, `ssh`, `aws`, `azure`, `kube`, `terraform`, `gcloud`

**Env var syntax:**

- `VAR` → pass if set in host env
- `VAR_*` → pass all matching (e.g., `TF_VAR_*`)
- `VAR=value` → always set to value
- `VAR=` → always set to empty string

**Config priority:** CLI flags > `ZEROSHOT_DOCKER_MOUNTS` env > settings > defaults

```bash
# Persistent config
zeroshot settings set dockerMounts '["gh","git","ssh","aws"]'

# Per-run override
zeroshot run 123 --docker --mount ~/.custom:/root/.custom:ro

# Disable all mounts
zeroshot run 123 --docker --no-mounts
```

## Adversarial Tester (STANDARD+ only)

**Core principle:** Tests passing ≠ implementation works. The ONLY verification is: **USE IT YOURSELF.**

1. Read issue → understand requirements
2. Look at code → figure out how to invoke
3. Run it → did it work?
4. Try to break it → edge cases
5. Verify each requirement → evidence (command + output)

## Persistence

| File                        | Content               |
| --------------------------- | --------------------- |
| `~/.zeroshot/clusters.json` | Cluster metadata      |
| `~/.zeroshot/<id>.db`       | SQLite message ledger |

Clusters survive crashes. Resume: `zeroshot resume <id>`

## Known Limitations

**Bash subprocess output not streamed:** Claude CLI returns `tool_result` after subprocess completes. Long scripts show no output until done.

## Fixed Bugs (Reference)

### Template Agent CWD Injection (2026-01-03)

**Bug:** `--ship` mode created worktree but template agents (planning, implementation, validator) ran in main directory instead, polluting it with uncommitted changes.

**Root cause:** `_opAddAgents()` didn't inject cluster's worktree cwd into dynamically spawned template agents. Initial agents got cwd via `startCluster()`, but template agents loaded later via conductor classification missed it.

**Fix:** Added cwd injection to `_opAddAgents()` and resume path in `orchestrator.js`. Test: `tests/worktree-cwd-injection.test.js`

## 🔴 ENFORCEMENT PHILOSOPHY

**ENFORCE > DOCUMENT. If enforceable, don't document.**

| Preference | Method                              |
| ---------- | ----------------------------------- |
| Best       | Type system (compile-time)          |
| Good       | ESLint rule (build-time)            |
| Okay       | Pre-commit hook, runtime guard      |
| Worst      | Documentation (hopes someone reads) |

**The error message IS the documentation.** Write error messages with what + fix:

```
FORBIDDEN: Direct spawn without isolation - use --worktree or --docker flag
```

**Document ONLY when:** Cannot be enforced (architecture decisions, design patterns).

**When Claude discovers an enforceable pattern:** ASK before adding rule.

## 🔴 ANTI-PATTERNS (Zeroshot-Specific)

### 1. Running Zeroshot Without Permission

```bash
# ❌ FORBIDDEN - Consumes API credits without user consent
agent: "I'll run zeroshot on issue #123"
zeroshot run 123

# ✅ CORRECT - Wait for explicit permission
agent: "Would you like me to run zeroshot on issue #123?"
# Wait for user to say "yes" or "run zeroshot"
```

**WHY THIS MATTERS:** Multi-agent runs can consume significant API credits. User must explicitly consent.

### 2. Git Commands in Validator Prompts

```bash
# ❌ FORBIDDEN - Git state unreliable, changes during validation
validator_prompt: "Run git diff to verify changes..."
validator_prompt: "Check git status to ensure clean state..."

# ✅ CORRECT - Validate files directly
validator_prompt: "Read src/index.js and verify function exists..."
validator_prompt: "Run the CLI command and verify output matches spec..."
```

**WHY THIS FAILS:** Multiple agents modify git state concurrently. Validator reads stale state.

### 3. Asking Questions in Autonomous Workflows

```javascript
// ❌ FORBIDDEN - Agents run non-interactively
await AskUserQuestion('Should I use approach A or B?');
// Agent waits forever, cluster stuck

// ✅ CORRECT - Make autonomous decision with reasoning
// Decision: Using approach A because requirement specifies X
```

**WHY THIS FAILS:** Zeroshot agents don't have interactive input. Make decisions autonomously.

### 4. Worker Git Operations Without Isolation

```bash
# ❌ FORBIDDEN - Pollutes main working directory
zeroshot run 123  # Worker commits directly to main branch

# ✅ CORRECT - Use isolation flags
zeroshot run 123 --worktree  # Isolated git worktree
zeroshot run 123 --pr        # Worktree + create PR
zeroshot run 123 --ship      # Worktree + PR + auto-merge
zeroshot run 123 --docker    # Full container isolation
```

**WHY THIS MATTERS:** Prevents contamination of main working directory, enables parallel work.

### 5. Using Git Stash (Hides Work)

```bash
# ❌ FORBIDDEN - Stashed work invisible to other agents
git stash
git stash save "WIP changes"
git stash pop

# ✅ CORRECT - WIP commits (visible, recoverable)
git add -A && git commit -m "WIP: feature implementation"
git switch other-branch
# Later: git reset --soft HEAD~1  # Unstage if needed
```

**WHY WIP COMMITS BETTER:** Visible to other agents, never lost, can be amended, squashable before merge.

### 6. Hardcoding Configuration in Templates

```javascript
// ❌ FORBIDDEN - Hardcoded values in cluster templates
const maxValidators = 3; // What if task needs 5?

// ✅ CORRECT - Parameterized from conductor classification
const maxValidators = cluster.config.complexity === 'CRITICAL' ? 5 : 3;
```

**WHY THIS MATTERS:** Conductor dynamically adjusts based on task complexity.

### 7. Targeting a Branch Other Than `main`

**`main` is the only trunk.** `dev` was deleted in `e94b6c2` ("chore(release): cut over to the main trunk", #810). Feature branches PR into `main`.

```bash
# ✅ CORRECT
git switch -c fix/my-feature
gh pr create --base main --head fix/my-feature

# ❌ WRONG - dev no longer exists; this fails at branch resolution
gh pr create --base dev --head fix/my-feature
```

**HISTORICAL (2026-01-16):** Under the previous dev → main workflow, an agent hit merge conflicts between dev and main and, instead of merging main into dev, branched from main and merged fixes directly to main — bypassing dev and leaving it without the fixes. The trunk cutover made that failure mode structurally impossible.

**NOTE:** No `enforce-main-pr-source` CI job exists. Earlier revisions of this file claimed one; `.github/workflows/` has never contained it. Branch protection and the merge queue are the actual gates.

## 🔴 BEHAVIORAL RULES

### Git Workflow (Contributing to Zeroshot)

**Merge queue enforces CI on rebased code before merge.**

```
feature-branch (local)
↓
pre-push hook → lint + typecheck (~5s)
↓
push to origin/feature-branch
↓
gh pr create --base main
↓
CI runs tests on PR branch
↓
gh pr merge --auto --squash → enters merge queue
↓
Queue rebases PR on latest main + runs CI again
↓
Merge to main (only if CI passes on rebased code)
```

**Pre-push hook blocks:** Direct pushes to `main`. Must use PR workflow.

**Branch intent:**

- `main`: the only trunk — active development and releases
- Feature branch → PR to `main`

**Commands:**

```bash
# Feature work
git switch -c feat/my-feature
# ... make changes ...
git push -u origin feat/my-feature
gh pr create --base main
gh pr merge --auto --squash

# Release: semantic-release publishes from main on merge
# → CI passes → merge → semantic-release publishes
```

**Setup merge queue (admin):** `./scripts/setup-merge-queue.sh`

### Git Safety (Multi-Agent Context)

**CRITICAL: Use WIP commits instead of stashing:**

```bash
git add -A && git commit -m "WIP: save work"  # Instead of git stash
git switch <branch>                            # Instead of git checkout <branch>
git restore <file>                             # Instead of git checkout -- <file>
git restore --staged <file>                    # Unstage without discarding
```

**Rationale:** Stashing hides work from other agents. WIP commits are visible, traceable, and never lost.

### Test-First Workflow (For Zeroshot Core)

**ALWAYS write tests BEFORE or WITH code changes:**

```bash
# 1. Create feature file
touch src/new-feature.js

# 2. Create test file FIRST
touch tests/new-feature.test.js

# 3. Write failing tests (TDD)
# 4. Implement feature until tests pass
# 5. Commit both together
```

**Not mechanically enforced.** `.husky/pre-commit` only blocks `-v2`/`-new`/`-old`/`-backup` filenames and runs `rustfmt --check` on staged `.rs`. Writing the test with the code is a convention, not a gate.

### Validation Workflow

**When to run manual validation:**

| Scenario                        | Run Validation? | Why                            |
| ------------------------------- | --------------- | ------------------------------ |
| Trivial changes (<50 lines)     | ❌ NO           | Pre-commit hook catches issues |
| Reading/exploring code          | ❌ NO           | No code changes                |
| Documentation changes           | ❌ NO           | No runtime errors possible     |
| Significant changes (>50 lines) | ✅ YES          | Fast feedback before commit    |
| Refactoring across files        | ✅ YES          | Catch breaking changes early   |
| User explicitly requests        | ✅ YES          | "run tests", "check lint"      |

**Trust pre-commit hooks for quick checks. Run full suite for major changes.**

```bash
npm run lint              # ESLint
npm run test              # Jest tests
npm run typecheck         # TypeScript (if applicable)
```

## 🔴 CI FAILURE DIAGNOSIS

**When multiple CI jobs fail, DO NOT assume single root cause.**

**WRONG:** Pick one job → assume it fixes all → Rerun → Still fails
**RIGHT:** Diagnose each job independently → Fix one → Rerun → Repeat

**Procedure:**

1. **Get exact status:**

   ```bash
   gh api repos/the-open-engine/zeroshot/actions/runs/{RUN_ID}/jobs \
     --jq '.jobs[] | "\(.name): \(.status) (\(.conclusion // "pending"))"'
   ```

2. **For EACH failing job, read ACTUAL error:**

   ```bash
   # ✅ CORRECT - Uses API, works for completed jobs
   gh api repos/the-open-engine/zeroshot/actions/jobs/{JOB_ID}/logs 2>&1 | grep -E "FAIL|Error"

   # ❌ WRONG - Waits for ENTIRE run to complete
   gh run view {RUN_ID} --log
   ```

3. **Fix ONE error → Commit → Push → Rerun → Repeat**

**Common multi-failure scenarios:**

| Failing                      | Likely Causes                                      |
| ---------------------------- | -------------------------------------------------- |
| lint + test                  | Lint error may block tests (different root causes) |
| test-unit + test-integration | Independent issues, fix separately                 |
| build + test                 | Build issue OR test setup, diagnose both           |

## CLAUDE.md Writing Rules

**Scope:** Narrowest possible. Module-specific → nested CLAUDE.md. Cross-cutting → root.

**Content Priority:**

1. 🔴 CRITICAL gotchas (project-specific, non-obvious, caused real bugs)
2. "Where to Look" routing tables
3. Anti-patterns with WHY (learned from real failures)
4. Commands/env vars/troubleshooting tables

**DELETE:**

- Tutorial content (LLMs know JavaScript/Node.js/CLI patterns)
- Directory trees (use ls/find)
- Interface definitions (read actual code)
- Anything duplicated from parent CLAUDE.md

**Format:**

- Tables over prose
- `ALWAYS`/`NEVER`/`CRITICAL` for rules (caps + context)
- Code examples: ❌ wrong + ✅ correct + WHY

## Mechanical Enforcement

| Antipattern               | Enforcement                              |
| ------------------------- | ---------------------------------------- |
| Dangerous fallbacks       | ESLint ERROR                             |
| Manual git tags           | Pre-push hook                            |
| Direct push to main       | Pre-push hook (blocks with instructions) |
| Git in validator prompts  | Config validator                         |
| Multiple impl files (-v2) | Pre-commit hook                          |
| Spawn without permission  | Runtime check (CLI)                      |
| Git stash usage           | Pre-commit hook (planned)                |
| Merge without CI rebase   | GitHub merge queue                       |

## 🔴 NODE.JS PATTERNS (Zeroshot-Specific)

### Async/Promises

| Pattern                          | Why                                               |
| -------------------------------- | ------------------------------------------------- |
| ALWAYS await async functions     | Missing await = silent failure, unhandled Promise |
| NEVER swallow Promise rejections | Unhandled rejection = process crash in Node 15+   |
| Handle Promise.all failures      | One rejection = entire Promise.all rejects        |

```javascript
// ❌ WRONG - Missing await
async function process() {
  doAsyncThing(); // Returns immediately, error lost
}

// ✅ CORRECT
async function process() {
  await doAsyncThing();
}

// ❌ WRONG - Swallowed rejection
try {
  await riskyOperation();
} catch (e) {
  // Silent - bug hidden
}

// ✅ CORRECT
try {
  await riskyOperation();
} catch (e) {
  logger.error('Operation failed', { error: e });
  throw e; // Re-throw or handle explicitly
}
```

### Process/Signals (CLI-specific)

| Pattern                  | Why                                                      |
| ------------------------ | -------------------------------------------------------- |
| Clean up child processes | Orphaned processes = resource leaks, port conflicts      |
| Handle SIGTERM/SIGINT    | Users will Ctrl+C. Handle gracefully.                    |
| Exit codes matter        | 0 = success, non-zero = failure. Scripts depend on this. |

```javascript
// ✅ CORRECT - Signal handling
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

// ✅ CORRECT - Child process cleanup
const child = spawn('command');
process.on('exit', () => child.kill());
```

### Multi-Agent Constraints

| Pattern                   | Why                                                   |
| ------------------------- | ----------------------------------------------------- |
| No global mutable state   | Agents run in parallel. Globals = race conditions.    |
| Never block on user input | Agents are non-interactive. Blocking = stuck forever. |

## 🔴 JUNIOR MISTAKES (Don't Do These)

| Mistake                | Why It's Wrong                              |
| ---------------------- | ------------------------------------------- |
| Overengineering        | No abstraction layers before they're needed |
| Copy-paste coding      | If duplicating, you should be abstracting   |
| Gold plating           | No features nobody asked for                |
| Premature optimization | Measure first, optimize second              |
| Reinventing            | Read existing code before writing new       |
| Leaving edge cases     | Incomplete solutions are not solutions      |
| Assuming it works      | Test it. Verify it. Prove it.               |
| Catch-and-ignore       | Try/catch that swallows = hidden bugs       |
