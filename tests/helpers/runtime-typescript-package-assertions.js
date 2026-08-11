const RUNTIME_TYPESCRIPT_OUTPUTS = Object.freeze([
  'cli/event-copy.js',
  'cli/message-formatter-utils.js',
  'src/guidance-topics.js',
  'src/input-helpers.js',
  'src/ledger-sequence.js',
  'src/message-buffer.js',
  'src/task-startup-error.js',
  'src/task-runner.js',
  'src/omp-blob-root.js',
  'src/omp-config-overlay.js',
  'task-lib/completion.js',
  'task-lib/config.js',
  'task-lib/name-generator.js',
  'task-lib/process-termination.js',
  'task-lib/omp-storage-root.js',
  'src/omp-execution-fingerprint.js',
  'src/omp-session-limits.js',
  'src/agent/context-replay-policy.js',
  'src/agent/critical-agent-policy.js',
  'src/agent/provider-control-plane.js',
  'src/agent/structured-output-error.js',
  'src/agent/validation-platform.js',
  'src/providers/anthropic/index.js',
  'src/providers/capabilities.js',
  'src/providers/google/index.js',
  'src/providers/openai/index.js',
  'src/providers/opencode/index.js',
  'src/template-validation/report-formatter.js',
]);

function assertRuntimeTypeScriptPackage(files) {
  for (const output of RUNTIME_TYPESCRIPT_OUTPUTS) {
    if (!files.has(output)) {
      throw new Error(`npm package must include runtime TypeScript output ${output}`);
    }
  }
}

module.exports = { assertRuntimeTypeScriptPackage };
