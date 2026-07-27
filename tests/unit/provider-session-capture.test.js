const assert = require('assert');

describe('provider session capture', function () {
  it('captures Claude and Codex session IDs from provider JSONL', async function () {
    const { captureProviderSessionLine } =
      await import('../../task-lib/provider-session-capture.js');
    const captured = [];

    let currentSessionId = captureProviderSessionLine({
      providerName: 'claude',
      line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-1' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });
    const duplicateSessionId = captureProviderSessionLine({
      providerName: 'claude',
      line: JSON.stringify({ type: 'result', session_id: 'claude-1' }),
      currentSessionId,
      onCapture: (sessionId) => captured.push(sessionId),
    });
    assert.strictEqual(duplicateSessionId, 'claude-1');
    currentSessionId = captureProviderSessionLine({
      providerName: 'codex',
      line: JSON.stringify({ type: 'thread.started', thread_id: 'codex-1' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });

    assert.strictEqual(currentSessionId, 'codex-1');
    assert.deepStrictEqual(captured, ['claude-1', 'codex-1']);
  });

  it('ignores malformed output and providers without safe resume semantics', async function () {
    const { captureProviderSessionLine } =
      await import('../../task-lib/provider-session-capture.js');
    const captured = [];

    const malformed = captureProviderSessionLine({
      providerName: 'claude',
      line: '{not-json',
      onCapture: (sessionId) => captured.push(sessionId),
    });
    const unsupported = captureProviderSessionLine({
      providerName: 'gemini',
      line: JSON.stringify({ type: 'init', session_id: 'gemini-1' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });

    assert.strictEqual(malformed, null);
    assert.strictEqual(unsupported, null);
    assert.deepStrictEqual(captured, []);
  });
});
