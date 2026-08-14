'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { getProviderRegistryEntry } = require('../../lib/agent-cli-provider');
const { assertGraphSpec } = require('../../lib/cluster/index.cjs');
const { validateConfig } = require('../../src/config-validator');
const {
  assertDeclarativeClusterConfig,
} = require('../../private/hosted-cli-candidate/declarative-cluster');
const { readHostedInputs } = require('../../private/hosted-cli-candidate/readers');
const {
  buildRunIntentExecution,
} = require('../../private/hosted-cli-candidate/run-intent-execution');
const { buildRunIntentEnvelope } = require('../../private/hosted-cli-candidate/run-intent-schema');
const {
  normalizeRuntimeConfig,
  readRuntimeConfig,
} = require('../../private/hosted-cli-candidate/runtime-config');

const EXAMPLES = path.join(__dirname, '../../private/hosted-cli-candidate/examples');
const RUNTIMES = Object.freeze({
  'runtime-azure-openai-omp.json': 'omp',
  'runtime-openai-codex.json': 'codex',
  'runtime-openrouter-claude.json': 'claude',
});

test('runtime guidance uses the user-facing harness vocabulary', () => {
  for (const [filename, expectedHarness] of Object.entries(RUNTIMES)) {
    const fullPath = path.join(EXAMPLES, filename);
    const source = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.equal(source.harness, expectedHarness);
    assert.equal(Object.hasOwn(source, 'executable'), false);

    const runtime = readRuntimeConfig(fullPath);
    assert.equal(runtime.harness, expectedHarness);
    const registry = getProviderRegistryEntry(runtime.harness);
    const providerSettings = runtime.settings.providerSettings?.[registry.id] ?? {};
    assert.equal(
      registry.settingsValidator?.(providerSettings, { executionContext: 'docker' }) ?? null,
      null
    );
  }
});

test('graph and input guidance passes production request validation', async () => {
  const graphPath = path.join(EXAMPLES, 'graph.json');
  const inputPath = path.join(EXAMPLES, 'input.json');
  const { graph, input } = await readHostedInputs(graphPath, inputPath, assertGraphSpec);
  const execution = buildRunIntentExecution({ graph, input });
  assert.equal(buildRunIntentEnvelope(execution.graph, execution.input).input, execution.input);
  assert.match(input.prompt, /Create a file/);
  assert.equal(graph.root.timeoutMs, 3_600_000);
});

test('custom cluster guidance passes production configuration validation', () => {
  const cluster = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'cluster.json'), 'utf8'));
  assert.equal(assertDeclarativeClusterConfig(cluster), cluster);
  assert.deepEqual(validateConfig(cluster), { valid: true, errors: [], warnings: [] });
});

test('runtime guidance rejects the internal executable vocabulary', () => {
  assert.throws(
    () => normalizeRuntimeConfig({ provider: 'claude', executable: 'claude' }),
    /unknown runtime config field: executable/
  );
});
