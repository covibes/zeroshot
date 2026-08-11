const assert = require('assert');

const criticalAgentPolicy = require('../../src/agent/critical-agent-policy');
const contextReplayPolicy = require('../../src/agent/context-replay-policy');
const providerControlPlane = require('../../src/agent/provider-control-plane');
const structuredOutputError = require('../../src/agent/structured-output-error');
const validationPlatform = require('../../src/agent/validation-platform');

describe('agent policy TypeScript runtime contracts', function () {
  it('preserves CommonJS export surfaces and function arities', function () {
    assert.deepStrictEqual(Reflect.ownKeys(criticalAgentPolicy), ['isCriticalAgent']);
    assert.deepStrictEqual(Reflect.ownKeys(providerControlPlane), [
      'parseProviderEvent',
      'providerFailureFields',
    ]);
    assert.deepStrictEqual(Reflect.ownKeys(validationPlatform), [
      'isPlatformMismatchReason',
      'findPlatformMismatchReason',
    ]);
    assert.deepStrictEqual(Reflect.ownKeys(structuredOutputError), [
      'STRUCTURED_OUTPUT_INVALID_CODE',
      'createStructuredOutputInvalidError',
      'isStructuredOutputInvalidError',
      'buildStructuredOutputClusterFailure',
    ]);
    assert.deepStrictEqual(Reflect.ownKeys(contextReplayPolicy), [
      'RAW_LOG_ONLY_REPLAY_POLICY',
      'CONTEXT_REPLAY_POLICY',
      'buildRawLogOnlyMetadata',
      'isReplayableMessage',
    ]);
    assert.deepStrictEqual(
      [
        criticalAgentPolicy.isCriticalAgent.length,
        providerControlPlane.parseProviderEvent.length,
        providerControlPlane.providerFailureFields.length,
        validationPlatform.isPlatformMismatchReason.length,
        validationPlatform.findPlatformMismatchReason.length,
        structuredOutputError.createStructuredOutputInvalidError.length,
        structuredOutputError.isStructuredOutputInvalidError.length,
        structuredOutputError.buildStructuredOutputClusterFailure.length,
        contextReplayPolicy.buildRawLogOnlyMetadata.length,
        contextReplayPolicy.isReplayableMessage.length,
      ],
      [1, 1, 1, 1, 0, 2, 1, 2, 0, 1]
    );
  });
});

describe('agent policy TypeScript behavior contracts', function () {
  it('preserves provider control-plane projection', function () {
    assert.deepStrictEqual(providerControlPlane.parseProviderEvent('{"type":"turn.failed"}'), {
      type: 'turn.failed',
    });
    assert.strictEqual(providerControlPlane.parseProviderEvent('[]'), null);
    assert.strictEqual(providerControlPlane.parseProviderEvent('invalid'), null);
    assert.deepStrictEqual(
      providerControlPlane.providerFailureFields({
        error: 'redacted',
        provider: 'codex',
        event: 'turn.failed',
        category: 'permanent',
        classification: { kind: 'permanent-pattern', retryable: false },
        diagnostic: { byteLength: 8 },
      }),
      {
        error: { message: 'redacted' },
        zeroshot_failure: {
          provider: 'codex',
          event: 'turn.failed',
          category: 'permanent',
          kind: 'permanent-pattern',
          retryable: false,
          diagnostic: { byteLength: 8 },
        },
      }
    );
  });

  it('preserves structured-output error details and terminal projection', function () {
    const error = structuredOutputError.createStructuredOutputInvalidError(
      'invalid output',
      'schema',
      { error: 'missing field' },
      { status: 'exhausted', attempts: 3, lastError: 'still invalid' }
    );
    assert.strictEqual(structuredOutputError.isStructuredOutputInvalidError(error), true);
    assert.deepStrictEqual(error.details, {
      kind: 'schema',
      validationError: 'missing field',
      recoveryAttempts: 3,
      recoveryError: 'still invalid',
    });
    assert.deepStrictEqual(
      structuredOutputError.buildStructuredOutputClusterFailure(
        { id: 'planner', role: 'planning' },
        error
      ).content.data,
      {
        reason: 'structured_output_invalid',
        agentId: 'planner',
        role: 'planning',
        code: 'STRUCTURED_OUTPUT_INVALID',
        details: error.details,
        error: 'invalid output',
      }
    );
  });
});
