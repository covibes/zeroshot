# Contributing to Zeroshot

Thank you for your interest in contributing to Zeroshot! This guide covers everything you need to know to develop, test, and contribute to the multi-agent orchestration engine.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)
- [Code Quality](#code-quality)
- [Making Changes](#making-changes)
- [Debugging](#debugging)
- [Pull Request Process](#pull-request-process)
- [Architecture Overview](#architecture-overview)

---

## Development Setup

### Prerequisites

- **Node.js 18+** (check: `node --version`)
- **npm** (bundled with Node)
- **Docker** (optional, for isolation mode tests)
- **AI Provider CLI** - At least one: Claude Code (`npm i -g @anthropic-ai/claude-code`), Codex, Gemini CLI, or OpenCode
- **GitHub CLI** - Required for PR creation features ([install guide](https://cli.github.com/))

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/the-open-engine/zeroshot.git
   cd zeroshot
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Link the CLI globally** (allows testing `zeroshot` commands)

   ```bash
   npm link
   ```

4. **Verify installation**
   ```bash
   zeroshot --version
   npm test
   ```

### Post-Installation

After installation, the `zeroshot` command is available globally. Any changes to the code take effect immediately (symlink).

To unlink:

```bash
npm unlink -g zeroshot
```

---

## Project Structure

```
zeroshot/
├── cli/                      # CLI entry point and commands
│   ├── index.js             # Main CLI dispatcher
│   └── commands/            # Command implementations (run, list, logs, etc.)
├── src/                      # Core orchestration engine
│   ├── orchestrator.js      # Cluster lifecycle manager
│   ├── agent-wrapper.js     # Agent lifecycle and task execution
│   ├── message-bus.js       # Pub/sub message routing
│   ├── ledger.js            # SQLite append-only log
│   ├── logic-engine.js      # JavaScript sandbox for trigger evaluation
│   ├── isolation-manager.js # Docker container lifecycle
│   ├── sub-cluster-wrapper.js # Hierarchical agent spawning
│   ├── template-resolver.js # Parameterized template engine
│   ├── agent/               # Agent subsystems (config, context, triggers, hooks)
│   ├── agents/              # Built-in agent definitions (git-pusher, etc.)
│   ├── attach/              # Attach-to-running-cluster client/server
│   └── schemas/             # JSON schemas for validation
├── cluster-templates/        # Workflow templates
│   └── base-templates/      # Parameterized base templates
├── lib/                      # Shared utilities
│   ├── stream-json-parser.js # Parse Claude CLI streaming output
│   └── mock-task-runner.js  # Test harness for agent execution
├── task-lib/                 # Single-agent task execution (zeroshot task run)
├── tests/                    # Test suite
│   ├── integration/         # End-to-end cluster tests
│   ├── helpers/             # Test utilities (MockTaskRunner, assertions)
│   └── examples/            # Example cluster configs for testing
├── docker/                   # Docker images for isolation mode
│   └── zeroshot-cluster/    # Base image with tools (Node, git, gh, Docker)
└── scripts/                  # Build and utility scripts
```

### Key Files

| File                                 | Purpose                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| `src/orchestrator.js`                | Cluster creation, agent spawning, crash recovery        |
| `src/agent-wrapper.js`               | Agent state machine, trigger evaluation, task execution |
| `src/message-bus.js`                 | Pub/sub topic routing over SQLite ledger                |
| `src/ledger.js`                      | Immutable event log with query API                      |
| `src/logic-engine.js`                | VM sandbox for trigger logic scripts                    |
| `src/template-resolver.js`           | Resolves `{base, params}` to agent configs              |
| `lib/mock-task-runner.js`            | Test harness - mock Claude CLI execution                |
| `tests/helpers/ledger-assertions.js` | Test assertions for message ledger                      |

---

## Running Tests

### All Tests

```bash
npm test
```

Runs the fast test suite (unit + top-level tests) as defined in `package.json`.
Integration tests in `tests/integration/**/*.test.js` are excluded from `npm test`; run them with `npm run test:slow`.

### Specific Test File

```bash
npx mocha tests/model-selection.test.js
```

### Test Categories

| Pattern                           | Category            | What it tests                                                          |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `tests/*.test.js`                 | Unit tests          | Individual modules (logic-engine, config-validator, template-resolver) |
| `tests/integration/*.test.js`     | Integration tests   | End-to-end orchestrator flows with mock agents                         |
| `tests/mock-task-runner*.test.js` | Agent runtime tests | Agent behavior, retries, streaming, validation                         |
| `tests/isolation-manager.test.js` | Docker tests        | Container creation (requires Docker running)                           |

### Test Harness: MockTaskRunner

Tests use `lib/mock-task-runner.js` to simulate Claude CLI execution WITHOUT making real API calls:

```javascript
const { MockTaskRunner } = require('../lib/mock-task-runner');

const runner = new MockTaskRunner();

// Define agent behaviors (what each agent returns)
runner.behaviors = {
  worker: async () => ({
    summary: 'Implemented feature X',
    approved: true,
  }),
  validator: async () => ({
    summary: 'All checks passed',
    approved: true,
  }),
};

// Use in test
const orchestrator = new Orchestrator({ taskRunner: runner });
await orchestrator.start(config, input);
```

### Debugging Failing Tests

1. **Check ledger state**

   ```javascript
   const messages = cluster.ledger.getAll(cluster.id);
   console.log('Messages:', messages);
   ```

2. **Use ledger assertions** (from `tests/helpers/ledger-assertions.js`)

   ```javascript
   const { assertMessageExists, assertTopicCount } = require('./helpers/ledger-assertions');

   assertMessageExists(ledger, clusterId, 'IMPLEMENTATION_READY');
   assertTopicCount(ledger, clusterId, 'VALIDATION_RESULT', 3);
   ```

3. **Run with verbose output**

   ```bash
   npx mocha tests/your-test.test.js --reporter spec
   ```

4. **Inspect cluster state**
   ```bash
   sqlite3 ~/.zeroshot/cluster-abc.db "SELECT * FROM messages;"
   ```

---

## Code Quality

### Linting

Zeroshot uses ESLint for code quality enforcement:

```bash
npm run lint              # Check for issues
npm run lint:fix          # Auto-fix issues
```

**Rules enforced:**

- Unused imports/variables (fails build)
- Unsafe optional chaining (`foo?.bar()` without null checks)
- Console statements (warn only)
- Complexity limits (warn above 20)

### Type Checking

TypeScript is used for type safety WITHOUT compilation (JSDoc types in `.js` files):

```bash
npm run typecheck
```

Type errors MUST be fixed before merging. See `tsconfig.json` for strictness settings.

### Dead Code Detection

```bash
npm run deadcode         # Find unused exports (ts-prune)
npm run deadcode:files   # Find unused files (unimported)
npm run deadcode:deps    # Find unused dependencies (depcheck)
npm run deadcode:all     # Run all three
```

### Pre-Commit Checklist

```bash
npm run check            # Runs typecheck + lint
npm run check:all        # Runs check + deadcode detection
npm test                 # Run all tests
```

All must pass before opening a PR.

---

## Making Changes

### Development Workflow

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Write tests first** (TDD encouraged)

   ```javascript
   describe('Your Feature', () => {
     it('should do X when Y happens', async () => {
       // Test implementation
     });
   });
   ```

3. **Implement the feature**
   - Keep functions small (< 50 lines)
   - Add JSDoc comments for public APIs
   - Use descriptive variable names

4. **Run quality checks**

   ```bash
   npm run check           # Types + lint
   npm test                # All tests
   ```

5. **Commit with conventional commit format**
   ```bash
   git commit -m "feat: add dynamic agent spawning via CLUSTER_OPERATIONS"
   git commit -m "fix: prevent validator auto-approval on first retry"
   git commit -m "docs: update CLAUDE.md with conductor classification"
   ```

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type        | When to use                                    |
| ----------- | ---------------------------------------------- |
| `feat:`     | New features (adds user-visible functionality) |
| `fix:`      | Bug fixes (fixes user-visible behavior)        |
| `docs:`     | Documentation only (README, CLAUDE.md, JSDoc)  |
| `refactor:` | Code restructuring (no behavior change)        |
| `test:`     | Adding/updating tests only                     |
| `chore:`    | Build scripts, dependencies, tooling           |
| `perf:`     | Performance improvements                       |

**Examples:**

- `feat: add --merge flag for auto-merge PRs`
- `fix: validator approval timeout not respecting maxRetries`
- `docs: clarify message bus polling mechanism in CLAUDE.md`
- `refactor: extract trigger evaluation to separate module`
- `test: add integration test for cluster resume`

### Code Style Guidelines

**Functions:**

- Keep functions < 50 lines
- Single responsibility (one thing well)
- Descriptive names: `buildContextForAgent()` not `buildCtx()`

**Comments:**

- JSDoc for public APIs
- Explain WHY, not WHAT (code shows what)
- Mark TODOs with `// TODO: [username] description`

**Error Handling:**

- Fail fast: validate inputs early
- Descriptive errors: `throw new Error('Agent config missing required field: id')`
- Catch and log at boundaries (CLI, orchestrator)

**Example:**

```javascript
/**
 * Evaluate trigger logic script in sandboxed VM
 * @param {String} script - JavaScript code to evaluate
 * @param {Object} agent - Agent context
 * @param {Object} message - Triggering message
 * @returns {Boolean} Whether agent should wake up
 * @throws {Error} If script syntax is invalid
 */
evaluate(script, agent, message) {
  if (!script) {
    throw new Error('Logic script cannot be empty');
  }

  // Implementation...
}
```

---

## Debugging

### Monitor Clusters Without TUI

The TUI is not included in this release. Use the CLI monitoring commands:

```bash
zeroshot list
zeroshot status <id>
zeroshot logs <id> -f
zeroshot logs <id> -w
```

### Debug Agent Execution

1. **Check ledger messages**

   ```bash
   sqlite3 ~/.zeroshot/cluster-abc.db
   SELECT topic, sender, content_text FROM messages ORDER BY timestamp;
   ```

2. **Follow agent logs in real-time**

   ```bash
   zeroshot logs cluster-abc -f
   ```

3. **Inspect cluster state**

   ```bash
   zeroshot status cluster-abc
   ```

4. **Enable verbose orchestrator logs**

   In tests or code:

   ```javascript
   const orchestrator = new Orchestrator({ quiet: false });
   ```

### Debug Docker Isolation

```bash
# Check if container exists
docker ps -a | grep zeroshot-cluster

# Exec into running container
docker exec -it zeroshot-cluster-<id> bash

# View container logs
docker logs zeroshot-cluster-<id>

# Rebuild base image
./build-image.sh
```

---

## Pull Request Process

### Before Opening a PR

1. **Ensure all checks pass**

   ```bash
   npm run check:all        # Types, lint, dead code
   npm test                 # All tests
   ```

2. **Update documentation**
   - Add/update JSDoc comments
   - Update CLAUDE.md if architecture changed
   - Update README.md if user-facing changes

3. **Write a clear PR description**
   - What: What does this PR change?
   - Why: Why is this change needed?
   - How: How does it work? (for complex changes)
   - Testing: How did you test this?

### PR Template

```markdown
## Summary

Brief description of changes (1-2 sentences)

## Motivation

Why is this change needed? What problem does it solve?

## Changes

- Change 1
- Change 2
- Change 3

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed
- [ ] All tests pass locally

## Breaking Changes

List any breaking changes (or "None")

## Checklist

- [ ] Tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Documentation updated
- [ ] CLAUDE.md updated (if architecture changed)
```

### Review Process

1. **CI checks must pass**
   - Type checking
   - Linting
   - All tests

2. **Code review by maintainers**
   - Architecture fit
   - Code quality
   - Test coverage

3. **Address review comments**
   - Make requested changes
   - Push additional commits
   - Re-request review

4. **Merge**
   - Maintainer will merge when approved
   - Commits are squashed (PR title becomes commit message)

---

## Architecture Overview

### Message-Driven Coordination

Zeroshot uses **pub/sub message bus** over an **immutable SQLite ledger**:

```
Agent A completes task
   ↓
Publishes message to topic (e.g., "IMPLEMENTATION_READY")
   ↓
MessageBus appends to SQLite Ledger
   ↓
LogicEngine evaluates ALL agents' triggers
   ↓
Agent B's trigger matches → spawns Claude CLI
```

**Key insight:** Agents don't call each other directly. They publish messages to topics. Other agents wake up when their triggers match.

### Agent Lifecycle

```
IDLE
  ↓
Message arrives → Evaluate triggers
  ↓
Trigger matches → Build context from ledger
  ↓
EXECUTING (spawn Claude CLI)
  ↓
Task completes → Execute hooks (publish results)
  ↓
IDLE (wait for next trigger)
```

See `src/agent/agent-lifecycle.js` for state machine implementation.

### Trigger Evaluation

Agents have **triggers** that define when they wake up:

```javascript
{
  "triggers": [
    {
      "topic": "IMPLEMENTATION_READY",
      "logic": {
        "engine": "javascript",
        "script": "return ledger.count({ topic: 'VALIDATION_RESULT' }) === 0;"
      },
      "action": "execute_task"
    }
  ]
}
```

**Logic scripts** run in sandboxed VM with these APIs:

- `ledger.query({ topic, sender, since, limit })` - Query messages
- `ledger.findLast({ topic })` - Get most recent
- `ledger.count({ topic })` - Count messages
- `cluster.getAgents()` - Get all agents
- `helpers.allResponded(agents, topic, since)` - Check consensus

See `src/logic-engine.js` for sandbox implementation.

### Context Building

Agents build context from ledger messages before executing. Use explicit selection semantics:

```json
{
  "contextStrategy": {
    "sources": [
      { "topic": "ISSUE_OPENED", "priority": "required", "strategy": "latest", "amount": 1 },
      { "topic": "STATE_SNAPSHOT", "priority": "required", "strategy": "latest", "amount": 1 },
      {
        "topic": "VALIDATION_RESULT",
        "priority": "high",
        "since": "last_task_end",
        "strategy": "latest",
        "amount": 10,
        "compactAmount": 3
      }
    ],
    "maxTokens": 100000
  }
}
```

Notes: `limit` is a deprecated alias for `amount`. If `amount` is set and `strategy` is omitted,
the default is `latest`; otherwise defaults to `all`.

See `docs/context-management.md` for the full reference and diagrams. Implementation lives in
`src/agent/agent-context-builder.js`.

### Template Resolution

Cluster configs can be **parameterized**:

```javascript
// Conductor publishes:
{
  "config": {
    "base": "full-workflow",
    "params": {
      "complexity": "STANDARD",
      "task_type": "TASK",
      "validator_count": 3
    }
  }
}

// TemplateResolver loads base-templates/full-workflow.json
// and substitutes {{complexity}}, {{validator_count}} in agent configs
```

See `src/template-resolver.js` and `cluster-templates/base-templates/`.

### Crash Recovery

All messages are persisted to SQLite (`~/.zeroshot/cluster-abc.db`). Clusters can resume from any point:

1. Load cluster metadata from `~/.zeroshot/clusters.json`
2. Replay ledger to reconstruct state
3. Find last failed agent from `AGENT_ERROR` messages
4. Resume that agent with context from ledger

See `Orchestrator.resume()` in `src/orchestrator.js`.

---

## Questions?

- **Issues**: Open a GitHub issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Pull Requests**: Submit PRs for code contributions

Thank you for contributing to Zeroshot!

---

## Additional Resources

- **[CLAUDE.md](./CLAUDE.md)** - Full architecture documentation
- **[README.md](./README.md)** - User guide and command reference
- **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** - Community guidelines
- **[SECURITY.md](./SECURITY.md)** - Security issue reporting
