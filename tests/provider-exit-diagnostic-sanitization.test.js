const assert = require('assert');

async function createRuntime(providerName, overrides = {}) {
  const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
  const logged = [];
  const runtime = createWatcherOutputRuntime({
    config: { outputFormat: 'text' },
    providerName,
    log: (value) => logged.push(value),
    stopProvider() {},
    ...overrides,
  });
  return { logged, runtime };
}

describe('provider exit diagnostic sanitization', function () {
  it('keeps successful exits unchanged when stderr contains a diagnostic', async function () {
    const { runtime } = await createRuntime('gemini');

    runtime.consumeStderr('', Buffer.from('IneligibleTierError: UNSUPPORTED_CLIENT\n'));
    const completion = runtime.complete({ code: 0, signal: null, stderrBuffer: '' });

    assert.strictEqual(completion.status, 'completed');
    assert.strictEqual(completion.error, null);
  });

  it('selects a later actionable failure instead of benign authentication telemetry', async function () {
    const { runtime } = await createRuntime('claude');

    runtime.consumeStderr(
      '',
      Buffer.from('Authentication initialized successfully\nrate_limit_exceeded: try again\n')
    );
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });

    assert.match(completion.error, /\(retryable; retryable-pattern\)/);
    assert.match(completion.error, /rate_limit_exceeded: try again/);
    assert.doesNotMatch(completion.error, /Authentication initialized successfully/);
  });

  it('selects an actionable stdout failure over later benign stderr telemetry', async function () {
    const { runtime } = await createRuntime('gemini');

    runtime.consumeOutput('', Buffer.from('IneligibleTierError: UNSUPPORTED_CLIENT\n'));
    runtime.consumeStderr('', Buffer.from('network telemetry enabled\n'));
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });

    assert.match(completion.error, /\(permanent; permanent-pattern\)/);
    assert.match(completion.error, /IneligibleTierError: UNSUPPORTED_CLIENT/);
    assert.doesNotMatch(completion.error, /network telemetry enabled/);
  });

  it('keeps signal and session-identity reasons ahead of provider diagnostics', async function () {
    const { runtime: signalRuntime } = await createRuntime('codex');
    signalRuntime.consumeStderr('', Buffer.from('rate_limit_exceeded\n'));
    const signalCompletion = signalRuntime.complete({
      code: null,
      signal: 'SIGTERM',
      stderrBuffer: '',
    });
    assert.strictEqual(signalCompletion.error, 'Killed by SIGTERM');

    const { runtime: sessionRuntime } = await createRuntime('codex', {
      providerSessionCapture: {
        captureLine() {},
        getCompletionError: () => 'Provider session identity could not be verified',
        getCompletionUpdate: () => ({}),
      },
    });
    sessionRuntime.consumeStderr('', Buffer.from('rate_limit_exceeded\n'));
    const sessionCompletion = sessionRuntime.complete({
      code: 1,
      signal: null,
      stderrBuffer: '',
    });
    assert.strictEqual(sessionCompletion.error, 'Provider session identity could not be verified');
  });

  it('bounds and redacts the persisted diagnostic while retaining complete raw output', async function () {
    const { logged, runtime } = await createRuntime('codex');
    const secret = 'sk-zs-bounded-provider-secret-123456';
    const diagnostic = `rate_limit_exceeded: Authorization: Bearer ${secret} ${'x'.repeat(8192)} tail`;

    runtime.consumeStderr('', Buffer.from(`${diagnostic}\n`));
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });

    assert.match(completion.error, /\(retryable; retryable-pattern\)/);
    assert.match(completion.error, /\[REDACTED\]/);
    assert.match(completion.error, /\[truncated; complete output in task log\]/);
    assert(!completion.error.includes(secret));
    assert(Buffer.byteLength(completion.error) <= 4096);
    assert(logged.join('').includes(secret));
    assert.match(logged.join(''), /tail/);

    const { runtime: clusterRuntime } = await createRuntime('codex', {
      config: { outputFormat: 'text', persistProviderDiagnostic: false },
    });
    clusterRuntime.consumeStderr('', Buffer.from(`${diagnostic}\n`));
    const clusterCompletion = clusterRuntime.complete({
      code: 1,
      signal: null,
      stderrBuffer: '',
    });
    assert.strictEqual(
      clusterCompletion.error,
      'Provider codex exited with code 1 (retryable; retryable-pattern)'
    );
  });

  it('redacts AWS, URL, bearer, and JWT credentials and removes C0/C1 ANSI controls', async function () {
    const { logged, runtime } = await createRuntime('codex');
    const secrets = [
      'aws-secret-access-value',
      'aws-session-token-value',
      'query-token-value',
      'query-api-key-value',
      'query-key-value',
      'query-signature-value',
      'query-amz-signature-value',
      'opaque-bearer-value',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue',
    ];
    const diagnostic =
      `\u001b[31m\u009b32mError: AWS_SECRET_ACCESS_KEY=${secrets[0]} ` +
      `AWS_SESSION_TOKEN=${secrets[1]} ` +
      `https://example.test/run?token=${secrets[2]}&api_key=${secrets[3]}` +
      `&key=${secrets[4]}&signature=${secrets[5]}` +
      `&X-Amz-Signature=${secrets[6]}&safe=visible ` +
      `Authorization: Bearer ${secrets[7]} jwt=${secrets[8]}\u0001\u0085`;

    runtime.consumeStderr('', Buffer.from(`${diagnostic}\n`));
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });

    for (const [index, secret] of secrets.entries()) {
      assert(!completion.error.includes(secret), `persisted diagnostic retained secret ${index}`);
    }
    assert.match(completion.error, /safe=visible/);
    assert.match(completion.error, /\[REDACTED/);
    assert(
      [...completion.error].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && !(code >= 127 && code <= 159);
      })
    );
    for (const secret of secrets) assert(logged.join('').includes(secret));
    assert.match(logged.join(''), /\u009b32m/);
  });

  it('fails closed on unterminated assignment and authorization quotes per record', async function () {
    const { sanitizeProviderDiagnostic } = await import('../task-lib/watcher-output-runtime.js');
    const cases = [
      {
        value:
          'Error: TOKEN="unterminated assignment secret with spaces\r\nordinary_status=visible',
        secret: 'unterminated assignment secret with spaces',
        ordinary: 'ordinary_status=visible',
      },
      {
        value:
          "Error: GITHUB_TOKEN='unterminated single assignment secret with spaces\nphase=ready",
        secret: 'unterminated single assignment secret with spaces',
        ordinary: 'phase=ready',
      },
      {
        value: 'Error: Authorization: Basic "unterminated basic secret with spaces\nphase=ready',
        secret: 'unterminated basic secret with spaces',
        ordinary: 'phase=ready',
      },
      {
        value:
          "Error: Proxy-Authorization: Basic 'unterminated single basic secret with spaces\r\nordinary_status=visible",
        secret: 'unterminated single basic secret with spaces',
        ordinary: 'ordinary_status=visible',
      },
    ];

    for (const { value, secret, ordinary } of cases) {
      const sanitized = sanitizeProviderDiagnostic(value);
      assert(!sanitized.includes(secret));
      assert(sanitized.includes('[REDACTED]'));
      assert(sanitized.includes(ordinary));
    }
  });

  it('bounds an overlong record after fail-closed unterminated-quote redaction', async function () {
    const { sanitizeProviderDiagnostic } = await import('../task-lib/watcher-output-runtime.js');
    const secret = `unterminated-${'s'.repeat(8192)}`;
    const sanitized = sanitizeProviderDiagnostic(
      `Error: TOKEN="${secret}\nordinary_status=visible ${'x'.repeat(8192)}`
    );

    assert(!sanitized.includes(secret));
    assert(sanitized.includes('ordinary_status=visible'));
    assert(sanitized.includes('[truncated; complete output in task log]'));
    assert(Buffer.byteLength(sanitized) <= 2048);
  });

  it('falls back safely when an unregistered provider exits non-zero', async function () {
    const { runtime } = await createRuntime('unknown-provider');

    runtime.consumeStderr('', Buffer.from('provider failed without a known classification\n'));
    const completion = runtime.complete({ code: 2, signal: null, stderrBuffer: '' });

    assert.strictEqual(completion.status, 'failed');
    assert.match(
      completion.error,
      /^Provider unknown-provider exited with code 2 \(retryable; unknown-retryable\)/
    );
  });
});
