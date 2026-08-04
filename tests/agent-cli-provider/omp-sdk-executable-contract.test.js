'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const helper = require('../../lib/agent-cli-provider');
const sdkRunner = require('../../lib/agent-cli-provider/omp-sdk-process-runner');
const {
  JSON_SCHEMA,
  MODEL,
  SECRET,
  sdkSettings,
  withSettings,
} = require('./omp-sdk-test-fixtures.cjs');

function requestBody() {
  return JSON.stringify({
    schemaVersion: 1,
    command: 'invoke',
    provider: 'omp',
    context: 'return the requested structured result',
    options: {
      cwd: process.cwd(),
      executionContext: 'host',
      outputFormat: 'json',
      jsonSchema: JSON_SCHEMA,
      strictSchema: true,
      modelSpec: { level: 'level2', model: MODEL, reasoningEffort: 'max' },
    },
  });
}

function cleanupAttestation() {
  return {
    mode: 'host-process-tree',
    terminalBuffered: true,
    descendantsReaped: true,
    clean: true,
  };
}

function commonResult(terminal, exitCode) {
  return {
    stdout: `untrusted ${SECRET}`,
    stderr: `untrusted ${SECRET}`,
    diagnosticStderr: '[REDACTED]',
    exitCode,
    signal: null,
    durationMs: 7,
    timedOut: false,
    terminal,
    progress: [],
    cleanupAttestation: cleanupAttestation(),
  };
}

function successResult(prepared) {
  const request = helper.parseOmpSdkSidecarRequest(
    JSON.parse(fs.readFileSync(prepared.privateArtifacts.requestPath, 'utf8'))
  );
  const frame = helper.parseOmpSdkProtocolFrame({
    protocolVersion: 1,
    type: 'result',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: '17.2.1' },
    runtime: { name: 'bun', version: '1.3.14' },
    requested: {
      modelSelector: request.modelSelector,
      reasoningEffort: request.reasoningEffort,
      outputMode: request.outputMode,
    },
    resolved: { modelSelector: request.modelSelector },
    strictOutput: { source: 'caller', mode: 'strict', status: 'valid', yieldCount: 1 },
    fallback: false,
    execution: { exitCode: 0, aborted: false },
    value: { answer: 'sdk fake reached' },
    usage: {
      source: 'omp-aggregate',
      completeness: 'unknown',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      totalTokens: 17,
      requests: 2,
      durationMs: 7,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
  });
  const event = helper.normalizeOmpSdkResultFrame(frame, request);
  fs.rmSync(prepared.privateArtifacts.root, { recursive: true, force: true });
  return commonResult({ type: 'result', frame, event }, 0);
}

function errorResult(prepared, code, category, retryable) {
  const request = JSON.parse(fs.readFileSync(prepared.privateArtifacts.requestPath, 'utf8'));
  const frame = helper.parseOmpSdkProtocolFrame({
    protocolVersion: 1,
    type: 'error',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: '17.2.1' },
    runtime: { name: 'bun', version: '1.3.14' },
    error: { code, category, retryable, redacted: true },
  });
  fs.rmSync(prepared.privateArtifacts.root, { recursive: true, force: true });
  return commonResult({ type: 'error', frame }, 1);
}

test('omitted OMP transport invokes the SDK lane and preserves Luna max evidence', async () => {
  await withSettings(sdkSettings(), async () => {
    const originalRun = sdkRunner.runOmpSdkProcess;
    let sdkCalls = 0;
    try {
      sdkRunner.runOmpSdkProcess = (prepared) => {
        sdkCalls += 1;
        return successResult(prepared);
      };
      const response = await helper.runProviderExecutable(requestBody(), {
        runner: () => assert.fail('omitted OMP transport used the generic or RPC runner'),
      });

      assert.equal(sdkCalls, 1);
      assert.equal(response.envelope.ok, true);
      assert.deepEqual(response.envelope.result.events[0].result, { answer: 'sdk fake reached' });
      assert.deepEqual(response.envelope.evidence.terminal.requested, {
        modelSelector: MODEL,
        reasoningEffort: 'max',
        outputMode: 'json',
      });
      assert.deepEqual(response.envelope.evidence.terminal.strictOutput, {
        source: 'caller',
        mode: 'strict',
        status: 'valid',
        yieldCount: 1,
      });
      assert.equal(JSON.stringify(response.envelope).includes(SECRET), false);
    } finally {
      sdkRunner.runOmpSdkProcess = originalRun;
    }
  });
});

test('SDK auth, model, and provider errors keep canonical classification and redact text', async () => {
  await withSettings(sdkSettings(), async () => {
    const originalRun = sdkRunner.runOmpSdkProcess;
    const cases = [
      ['provider-auth', 'auth', false, 'permanent-pattern'],
      ['model-resolution', 'model', false, 'permanent-pattern'],
      ['provider-error', 'provider', true, 'unknown-retryable'],
    ];
    try {
      for (const [code, category, retryable, kind] of cases) {
        sdkRunner.runOmpSdkProcess = (prepared) => errorResult(prepared, code, category, retryable);
        const response = await helper.runProviderExecutable(requestBody(), {
          runner: () => assert.fail('SDK error used the generic runner'),
        });

        assert.deepEqual(response.envelope.result.classification, {
          category,
          retryable,
          kind,
        });
        assert.deepEqual(response.envelope.result.evidence.terminal.error, {
          code,
          category,
          retryable,
          redacted: true,
        });
        assert.equal(JSON.stringify(response.envelope).includes('untrusted'), false);
        assert.equal(JSON.stringify(response.envelope).includes(SECRET), false);
      }
    } finally {
      sdkRunner.runOmpSdkProcess = originalRun;
    }
  });
});
