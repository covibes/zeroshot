#!/usr/bin/env node
/**
 * Fake provider CLI for deterministic end-to-end tests.
 *
 * Stands in for the real `claude` binary via ZEROSHOT_CLAUDE_COMMAND (see
 * lib/settings.js:getClaudeCommand and src/agent-cli-provider/adapters/claude.ts:buildCommand).
 * Everything above this process (CLI parsing, orchestrator, message bus, ledger,
 * trigger/logic engine, agent spawning, stream-json parsing, hooks, worktree
 * isolation) runs for real; only the model's cognition is faked.
 *
 * Argv contract (buildCommand): [...prefixArgs, '--print', '--input-format', 'text',
 * ...outputArgs, ...schemaArgs, ...modelArgs, ...autoApproveArgs, ...sessionArgs, context]
 * The prompt/context is always the LAST argv element.
 *
 * Scenario selection:
 *   FAKE_AGENT_SCENARIO=<path>              Used for every agent by default.
 *   FAKE_AGENT_SCENARIO_<AGENT_ID_UPPER>     Overrides the default for one agent id.
 *
 * Per-agent override convention (not in the original issue spec, needed for multi-agent
 * scenarios): ZEROSHOT_CLAUDE_COMMAND is a single process-wide env var, so every agent in
 * a cluster invokes the exact same fake-agent command. The only per-invocation signal
 * available is the prompt text itself (the last argv element), which embeds the agent's
 * configured `prompt` string verbatim (see src/agent/agent-context-sections.js
 * buildHeaderContext). Fixture configs that need distinct per-agent scenarios must include
 * the literal marker `FAKE_AGENT_ID=<id>` somewhere in that agent's `prompt` field; this
 * script extracts it from the context and uses it to look up
 * FAKE_AGENT_SCENARIO_<ID_UPPER>, falling back to FAKE_AGENT_SCENARIO.
 *
 * Scenario JSON shape:
 *   {
 *     "files": [{ "path": "relative/path.txt", "content": "..." }],
 *     "edits": [{ "path": "relative/path.txt", "find": "...", "replace": "..." }],
 *     "messages": ["assistant message 1", "assistant message 2"],
 *     "exitCode": 0,
 *     "delayMs": 0
 *   }
 * files/edits are applied relative to process.cwd() (proves worktree cwd injection).
 */

const fs = require('fs');
const path = require('path');

function extractAgentId(context) {
  const match = /FAKE_AGENT_ID=([A-Za-z0-9_-]+)/.exec(context);
  return match ? match[1] : null;
}

function resolveScenarioPath(context) {
  const agentId = extractAgentId(context);
  if (agentId) {
    const perAgentKey = `FAKE_AGENT_SCENARIO_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    if (process.env[perAgentKey]) {
      return process.env[perAgentKey];
    }
  }
  return process.env.FAKE_AGENT_SCENARIO;
}

function loadScenario(context) {
  const scenarioPath = resolveScenarioPath(context);
  if (!scenarioPath) {
    throw new Error('fake-agent: FAKE_AGENT_SCENARIO (or a per-agent override) must be set');
  }
  const raw = fs.readFileSync(scenarioPath, 'utf8');
  return JSON.parse(raw);
}

function applyFiles(scenario) {
  for (const file of scenario.files || []) {
    const target = path.resolve(process.cwd(), file.path);
    process.stderr.write(`fake-agent: writing ${target}\n`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content ?? '');
  }
}

function applyEdits(scenario) {
  for (const edit of scenario.edits || []) {
    const target = path.resolve(process.cwd(), edit.path);
    const current = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, current.split(edit.find).join(edit.replace));
  }
}

function parseArgv(argv) {
  const outputFormatIndex = argv.indexOf('--output-format');
  const modelIndex = argv.indexOf('--model');
  return {
    outputFormat: outputFormatIndex >= 0 ? argv[outputFormatIndex + 1] : null,
    model: modelIndex >= 0 ? argv[modelIndex + 1] : null,
    context: argv[argv.length - 1] || '',
  };
}

function emitEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitMessages(messages) {
  for (const text of messages) {
    emitEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
  }
}

function emitResult(scenario, messages) {
  const exitCode = scenario.exitCode ?? 0;
  const lastMessage = messages[messages.length - 1] ?? '';
  emitEvent({
    type: 'result',
    subtype: exitCode === 0 ? 'success' : 'error',
    is_error: exitCode !== 0,
    result: lastMessage,
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function isVersionProbe(argv) {
  // src/preflight.js:getClaudeVersion runs `<command> --version` (and only that)
  // to detect CLI presence, with no scenario/task context. Must not touch
  // FAKE_AGENT_SCENARIO or write files for this bare capability probe.
  return argv.includes('--version') && !argv.includes('--print');
}

function isHelpProbe(argv) {
  return argv.includes('--help') && !argv.includes('--print');
}

function main() {
  const argv = process.argv.slice(2);
  if (isVersionProbe(argv)) {
    process.stdout.write('1.0.0 (fake-agent)\n');
    process.exit(0);
  }
  if (isHelpProbe(argv)) {
    process.stdout.write(
      [
        'Usage: claude [options]',
        '  --output-format <format>',
        '  --json-schema <schema>',
        '  --dangerously-skip-permissions',
        '  --include-partial-messages',
        '  --verbose',
        '  --model <model>',
        '  --effort <effort>',
        '  --settings <path>',
        '  --mcp-config <path>',
        '  stream-json',
      ].join('\n')
    );
    process.exit(0);
  }

  const { outputFormat, model, context } = parseArgv(argv);
  const scenario = loadScenario(context);
  process.stderr.write(
    `fake-agent: output-format=${outputFormat} model=${model} cwd=${process.cwd()}\n`
  );

  const exitCode = scenario.exitCode ?? 0;
  const messages = scenario.messages || [];

  if (exitCode === 0) {
    applyFiles(scenario);
    applyEdits(scenario);
  }

  const run = () => {
    emitMessages(messages);
    emitResult(scenario, messages);
    process.exit(exitCode);
  };

  if (scenario.delayMs) {
    setTimeout(run, scenario.delayMs);
  } else {
    run();
  }
}

main();
