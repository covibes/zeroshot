const RUNTIME_TYPESCRIPT_OUTPUTS = Object.freeze([
  'src/guidance-topics.js',
  'src/providers/anthropic/index.js',
  'src/providers/capabilities.js',
  'src/providers/google/index.js',
  'src/providers/openai/index.js',
  'src/providers/opencode/index.js',
]);

function assertRuntimeTypeScriptPackage(files) {
  for (const output of RUNTIME_TYPESCRIPT_OUTPUTS) {
    if (!files.has(output)) {
      throw new Error(`npm package must include runtime TypeScript output ${output}`);
    }
  }
}

module.exports = { assertRuntimeTypeScriptPackage };
