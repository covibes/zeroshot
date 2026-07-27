const assert = require('assert');

describe('provider session capture', function () {
  it('captures Claude and Codex session IDs from provider JSONL', async function () {
    const { captureProviderSessionLine } =
      await import('../../task-lib/provider-session-capture.js');
    const captured = [];

    const claudeObserved = new Set();
    let state = captureProviderSessionLine({
      providerName: 'claude',
      line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-1' }),
      observedSessionIds: claudeObserved,
      onCapture: (sessionId) => captured.push(sessionId),
    });
    const duplicate = captureProviderSessionLine({
      providerName: 'claude',
      line: JSON.stringify({ type: 'result', session_id: 'claude-1' }),
      currentSessionId: state.currentSessionId,
      observedSessionIds: claudeObserved,
      onCapture: (sessionId) => captured.push(sessionId),
    });
    assert.deepStrictEqual(duplicate, {
      currentSessionId: 'claude-1',
      sessionIdConflict: false,
    });
    state = captureProviderSessionLine({
      providerName: 'codex',
      line: JSON.stringify({ type: 'thread.started', thread_id: 'codex-1' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });

    assert.strictEqual(state.currentSessionId, 'codex-1');
    assert.deepStrictEqual(captured, ['claude-1', 'codex-1']);
  });

  for (const [providerName, lineFor] of [
    [
      'claude',
      (sessionId) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    ],
    ['codex', (sessionId) => JSON.stringify({ type: 'thread.started', thread_id: sessionId })],
  ]) {
    it(`makes conflicting ${providerName} JSONL session IDs sticky`, async function () {
      const { captureProviderSessionLine } =
        await import('../../task-lib/provider-session-capture.js');
      const observedSessionIds = new Set();
      const captured = [];
      const conflicts = [];
      let state = { currentSessionId: null, sessionIdConflict: false };

      for (const sessionId of ['requested-a', 'forked-b', 'requested-a']) {
        state = captureProviderSessionLine({
          providerName,
          line: lineFor(sessionId),
          observedSessionIds,
          ...state,
          onCapture: (value) => captured.push(value),
          onConflict: (values) => conflicts.push(values),
        });
      }

      assert.deepStrictEqual([...observedSessionIds], ['requested-a', 'forked-b']);
      assert.deepStrictEqual(state, { currentSessionId: null, sessionIdConflict: true });
      assert.deepStrictEqual(captured, ['requested-a']);
      assert.deepStrictEqual(conflicts, [['requested-a', 'forked-b']]);
    });
  }

  it('persists a conflicting capture by clearing the last ID exactly once', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');
    const updates = [];
    const capture = createProviderSessionCapture({
      providerName: 'claude',
      taskId: 'resumed-task',
      updateTask: (taskId, update) => updates.push({ taskId, update }),
      log: () => {},
      initialSessionId: 'forked-b',
    });

    capture(JSON.stringify({ type: 'result', session_id: 'requested-a' }));
    capture(JSON.stringify({ type: 'result', session_id: 'requested-a' }));

    assert.deepStrictEqual(updates, [
      {
        taskId: 'resumed-task',
        update: { sessionId: null, sessionIdConflict: true },
      },
    ]);
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

    assert.deepStrictEqual(malformed, { currentSessionId: null, sessionIdConflict: false });
    assert.deepStrictEqual(unsupported, { currentSessionId: null, sessionIdConflict: false });
    assert.deepStrictEqual(captured, []);
  });
});
