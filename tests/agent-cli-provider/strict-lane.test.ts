import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentCliProviderHelperMetadata,
  buildProviderCommand,
  classifyProviderError,
  getProviderAdapter,
  listProviderAdapters,
  parseProviderChunk,
  runProviderExecutable,
  resolveModelSpec,
  type AgentCliProviderHelperMetadata,
  type CommandSpec,
  type ContractEnvelope,
  type ErrorClassification,
  type ModelLevel,
  type OutputEvent,
  type ProcessRunner,
  type ProviderId,
  type ReasoningEffort,
} from '../../src/agent-cli-provider/index';

const expectedMetadata: Readonly<AgentCliProviderHelperMetadata> = agentCliProviderHelperMetadata;

test('provider helper metadata documents package and build output', (): void => {
  assert.equal(expectedMetadata.packageName, '@the-open-engine/zeroshot');
  assert.equal(expectedMetadata.buildOutputDir, 'lib/agent-cli-provider');
  assert.equal(expectedMetadata.contractVersion, 1);
  assert.equal(typeof expectedMetadata.adapterVersion, 'string');
});

test('provider helper public API exposes typed provider adapters', (): void => {
  const providerIds: readonly ProviderId[] = listProviderAdapters();
  assert.deepEqual(providerIds, [
    'claude',
    'codex',
    'gateway',
    'gemini',
    'opencode',
    'pi',
    'omp',
    'kiro',
    'copilot',
  ]);

  const adapter = getProviderAdapter('openai');
  assert.equal(adapter.id, 'codex');
  assert.equal(adapter.displayName, 'Codex');
  assert.equal(typeof adapter.adapterVersion, 'string');
  assert.ok(adapter.credentialEnvKeys.length >= 0);

  const kiroAdapter = getProviderAdapter('kiro');
  assert.equal(kiroAdapter.id, 'kiro');
  assert.equal(kiroAdapter.binary, 'kiro-cli');

  const gatewayAdapter = getProviderAdapter('gateway');
  assert.equal(gatewayAdapter.id, 'gateway');
  assert.equal(gatewayAdapter.binary, process.execPath);
});

test('command specs preserve cleanup and warnings as typed metadata', (): void => {
  const spec: CommandSpec = buildProviderCommand('codex', 'Return JSON', {
    outputFormat: 'json',
    cwd: '/tmp/project',
    jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    cliFeatures: { supportsJson: true, supportsOutputSchema: true },
  });

  assert.equal(spec.binary, 'codex');
  assert.equal(spec.cwd, '/tmp/project');
  assert.ok(spec.args.includes('--output-schema'));
  assert.equal(spec.cleanupMetadata.length, 1);
  assert.equal(spec.cleanupMetadata[0]?.kind, 'temp-file');
});

test('provider executable contract exports typed runner and envelope discriminants', (): Promise<void> => {
  const runner: ProcessRunner = () =>
    Promise.resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
  return runProviderExecutable(
    JSON.stringify({
      schemaVersion: 1,
      command: 'probe',
      provider: 'codex',
    }),
    { runner }
  ).then((response) => {
    const envelope: ContractEnvelope = response.envelope;

    if (envelope.ok) {
      assert.equal(envelope.schemaVersion, 1);
      assert.equal(envelope.command, 'probe');
    } else {
      assert.equal(typeof envelope.error.code, 'string');
    }
  });
});

test('discriminated output events narrow without unsafe assertions', (): void => {
  const events: readonly OutputEvent[] = parseProviderChunk(
    'claude',
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'typed' },
      },
    })
  );

  const text = events
    .map((event): string => {
      if (event.type === 'text') return event.text;
      if (event.type === 'thinking') return event.text;
      if (event.type === 'result') return event.success ? 'success' : String(event.error);
      if (event.type === 'tool_call') return String(event.toolName);
      return String(event.content);
    })
    .join('');

  assert.equal(text, 'typed');
});

test('model levels and error classifications are explicit unions', (): void => {
  const level: ModelLevel = 'level3';
  const effort: ReasoningEffort = 'max';
  const spec = resolveModelSpec('codex', level);
  const classification: ErrorClassification = classifyProviderError('codex', {
    message: 'server_error',
  });

  assert.equal(spec.reasoningEffort, 'xhigh');
  assert.equal(effort, 'max');
  assert.equal(classification.retryable, true);
});

export { expectedMetadata };
