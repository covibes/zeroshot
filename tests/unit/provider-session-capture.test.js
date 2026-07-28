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

    capture.captureLine(JSON.stringify({ type: 'result', session_id: 'requested-a' }));
    capture.captureLine(JSON.stringify({ type: 'result', session_id: 'requested-a' }));

    assert.deepStrictEqual(updates, [
      {
        taskId: 'resumed-task',
        update: { sessionId: null, sessionIdConflict: true },
      },
    ]);
  });

  it('fails closed when SQLite persistence throws after a second identity', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');
    const logs = [];
    let writes = 0;
    const capture = createProviderSessionCapture({
      providerName: 'claude',
      taskId: 'sqlite-failure-task',
      requestedSessionId: 'requested-a',
      updateTask: () => {
        writes += 1;
        if (writes === 2) {
          const error = new Error('database is locked');
          error.code = 'SQLITE_BUSY';
          throw error;
        }
      },
      log: (message) => logs.push(message),
    });

    capture.captureLine(JSON.stringify({ type: 'system', session_id: 'requested-a' }));
    capture.captureLine(JSON.stringify({ type: 'result', session_id: 'forked-b' }));
    capture.captureLine(JSON.stringify({ type: 'result', session_id: 'requested-a' }));

    assert.strictEqual(writes, 2, 'an in-memory conflict must remain sticky after the failed write');
    assert.match(capture.getCompletionError(), /could not be persisted: database is locked/);
    assert.ok(logs.some((message) => message.includes('Failed to persist provider session')));
  });

  it('requires an explicit requested identity to be observed exactly', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');
    const lineFor = (sessionId) =>
      JSON.stringify({ type: 'thread.started', thread_id: sessionId });

    for (const [name, observed, expected] of [
      ['confirmed', ['requested-a'], null],
      ['ignored', [], /did not confirm/],
      ['forked', ['forked-b'], /different session identity/],
      ['ambiguous', ['requested-a', 'forked-b'], /conflicting session identities/],
    ]) {
      const capture = createProviderSessionCapture({
        providerName: 'codex',
        taskId: `${name}-resume`,
        requestedSessionId: 'requested-a',
        updateTask: () => {},
        log: () => {},
      });
      observed.forEach((sessionId) => capture.captureLine(lineFor(sessionId)));
      const error = capture.getCompletionError();
      if (expected === null) {
        assert.strictEqual(error, null);
      } else {
        assert.match(error, expected);
      }
    }
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
