const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  RESULT_SCHEMA,
  TELEMETRY_SCHEMA,
  buildBenchmarkResult,
  buildCancelledResult,
  buildTelemetry,
} = require('../src/foreground-benchmark-result');
const { isForegroundStatusSettled } = require('../src/foreground-benchmark-run');

const RUN_ID = 'benchmark-result-test';
const STOPPED_AGENTS = [{ id: 'planner', pid: null }];
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function terminal(topic, data = {}, sender = 'planner', receiver = 'system') {
  return { topic, sender, receiver, content: { data } };
}

function snapshot() {
  return {
    messageCount: 17,
    tokensByRole: {
      _total: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        totalCostUsd: 0.01,
        count: 2,
      },
      planning: { inputTokens: 10, outputTokens: 5, count: 2 },
    },
  };
}

describe('foreground benchmark result contract', function () {
  it('maps successful and explicit task-failure terminals to verifier-eligible outcomes', function () {
    const success = buildBenchmarkResult({
      runId: RUN_ID,
      terminalMessages: [terminal('CLUSTER_COMPLETE')],
      agents: STOPPED_AGENTS,
    });
    assert.deepStrictEqual(success, {
      schema: RESULT_SCHEMA,
      runId: RUN_ID,
      outcome: 'completed',
      terminalOwner: 'task',
      code: 'ok',
      kind: 'workflow_complete',
      retryable: false,
      diagnostic: { byteLength: 0, sha256: EMPTY_SHA256 },
      provider: null,
      event: null,
      category: null,
    });

    const taskFailure = buildBenchmarkResult({
      runId: RUN_ID,
      terminalMessages: [terminal('CLUSTER_FAILED', { reason: 'max_iterations' })],
      agents: STOPPED_AGENTS,
    });
    assert.strictEqual(taskFailure.outcome, 'task_failure');
    assert.strictEqual(taskFailure.terminalOwner, 'task');
    assert.strictEqual(taskFailure.code, 'max_iterations');

    const structuredFailure = buildBenchmarkResult({
      runId: RUN_ID,
      terminalMessages: [
        terminal(
          'CLUSTER_FAILED',
          { reason: 'structured_output_invalid', code: 'STRUCTURED_OUTPUT_INVALID' },
          'worker',
          'broadcast'
        ),
      ],
      agents: STOPPED_AGENTS,
    });
    assert.strictEqual(structuredFailure.outcome, 'task_failure');
    assert.strictEqual(structuredFailure.code, 'structured_output_invalid');
  });

  it('retains only a closed provider failure envelope', function () {
    const rawSecret = 'Authorization: Bearer should-never-survive';
    const result = buildBenchmarkResult({
      runId: RUN_ID,
      terminalMessages: [
        terminal(
          'CLUSTER_FAILED',
          {
            reason: 'provider_execution_failed',
            provider: 'codex',
            event: 'turn.failed',
            category: 'quota',
            code: 'crash',
            kind: 'permanent-pattern',
            retryable: false,
            diagnostic: { byteLength: 44, sha256: 'a'.repeat(64) },
            rawSecret,
          },
          'planner',
          'broadcast'
        ),
      ],
      agents: STOPPED_AGENTS,
    });
    assert.strictEqual(result.outcome, 'provider_failure');
    assert.strictEqual(result.terminalOwner, 'provider');
    assert.strictEqual(result.provider, 'codex');
    assert.strictEqual(result.event, 'turn.failed');
    assert.strictEqual(result.category, 'quota');
    assert.deepStrictEqual(result.diagnostic, { byteLength: 44, sha256: 'a'.repeat(64) });
    assert.ok(!JSON.stringify(result).includes(rawSecret));
  });
});

describe('foreground benchmark result rejection and telemetry', function () {
  it('requires terminal state and every agent process identity to settle', function () {
    const status = { state: 'stopped', isZombie: false, agents: STOPPED_AGENTS };
    assert.strictEqual(isForegroundStatusSettled(status), true);
    assert.strictEqual(
      isForegroundStatusSettled({ ...status, agents: [{ id: 'worker', pid: 123 }] }),
      false
    );
    assert.strictEqual(isForegroundStatusSettled({ ...status, isZombie: true }), false);
  });

  it('rejects a malformed provider envelope instead of inventing defaults', function () {
    assert.throws(
      () =>
        buildBenchmarkResult({
          runId: RUN_ID,
          terminalMessages: [
            terminal('CLUSTER_FAILED', {
              reason: 'provider_execution_failed',
              provider: 'unregistered-provider',
              event: 'turn.failed',
              category: 'unknown',
              code: 'crash',
              kind: 'unknown-retryable',
              retryable: true,
              diagnostic: { byteLength: 1, sha256: 'b'.repeat(64) },
            }),
          ],
          agents: STOPPED_AGENTS,
        }),
      /provider is outside the closed result contract/
    );
  });

  it('rejects missing, duplicate, and not-yet-stopped terminal state', function () {
    assert.throws(
      () => buildBenchmarkResult({ runId: RUN_ID, terminalMessages: [], agents: STOPPED_AGENTS }),
      /exactly one terminal/
    );
    assert.throws(
      () =>
        buildBenchmarkResult({
          runId: RUN_ID,
          terminalMessages: [terminal('CLUSTER_COMPLETE'), terminal('CLUSTER_FAILED')],
          agents: STOPPED_AGENTS,
        }),
      /exactly one terminal/
    );
    assert.throws(
      () =>
        buildBenchmarkResult({
          runId: RUN_ID,
          terminalMessages: [terminal('CLUSTER_COMPLETE')],
          agents: [{ id: 'planner', pid: 123 }],
        }),
      /live process identity/
    );
  });

  it('builds a closed controlled-cancellation result', function () {
    const result = buildCancelledResult({ runId: RUN_ID, agents: STOPPED_AGENTS });
    assert.strictEqual(result.outcome, 'cancelled');
    assert.strictEqual(result.terminalOwner, 'controller');
    assert.strictEqual(result.code, 'cancelled');
  });

  it('normalizes bounded telemetry and rejects invalid numeric data', function () {
    const telemetry = buildTelemetry(RUN_ID, snapshot());
    assert.strictEqual(telemetry.schema, TELEMETRY_SCHEMA);
    assert.strictEqual(telemetry.messageCount, 17);
    assert.strictEqual(telemetry.tokensByRole.planning.cacheReadInputTokens, 0);
    assert.throws(
      () => buildTelemetry(RUN_ID, { ...snapshot(), messageCount: -1 }),
      /messageCount/
    );
  });
});
