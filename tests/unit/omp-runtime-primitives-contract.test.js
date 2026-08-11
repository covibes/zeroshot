const assert = require('assert');

const fingerprint = require('../../src/omp-execution-fingerprint');
const sessionLimits = require('../../src/omp-session-limits');

describe('OMP session runtime TypeScript primitive contracts', function () {
  it('preserves the pinned session-limit surface', function () {
    assert.deepStrictEqual(Reflect.ownKeys(sessionLimits), [
      'OMP_SESSION_LIMITS',
      'MAX_SESSION_RECORD_BYTES',
    ]);
    assert.strictEqual(Object.isFrozen(sessionLimits.OMP_SESSION_LIMITS), true);
    assert.strictEqual(
      sessionLimits.MAX_SESSION_RECORD_BYTES,
      sessionLimits.OMP_SESSION_LIMITS.maxReferencedBlobBytes
    );
  });

  it('preserves selector parsing and execution fingerprints', function () {
    assert.deepStrictEqual(Reflect.ownKeys(fingerprint), [
      'computeOmpExecutionFingerprint',
      'requestedExecutionSelectors',
    ]);
    assert.deepStrictEqual(
      [
        fingerprint.computeOmpExecutionFingerprint.length,
        fingerprint.requestedExecutionSelectors.length,
      ],
      [1, 1]
    );
    const commandSpec = {
      args: ['--model', 'openai/gpt-5', '--thinking', 'high', '--approval-mode', 'full-auto'],
    };
    assert.deepStrictEqual(fingerprint.requestedExecutionSelectors(commandSpec), {
      modelSelector: 'openai/gpt-5',
      thinkingSelector: 'high',
      approvalMode: 'full-auto',
    });
    assert.strictEqual(
      fingerprint.computeOmpExecutionFingerprint({
        expectedVersion: '17.2.1',
        commandSpec,
        evidence: {
          selectedProvider: 'openai-codex',
          selectedModel: 'gpt-5',
          thinkingLevel: 'high',
        },
        configOverlayDigest: `sha256:${'a'.repeat(64)}`,
      }),
      'sha256:d926bd0ceda57e9648aaaa07ee0bedb1ac5da3b5522d4127e4acf6e814120b4c'
    );
  });
});
