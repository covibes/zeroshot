const assert = require('assert');

describe('provider session capture', function () {
  it('captures Claude, Codex, and OMP session IDs from provider JSONL', async function () {
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

    state = captureProviderSessionLine({
      providerName: 'omp',
      line: JSON.stringify({ type: 'session', id: 'omp-1' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });

    assert.strictEqual(state.currentSessionId, 'omp-1');
    assert.deepStrictEqual(captured, ['claude-1', 'codex-1', 'omp-1']);
  });

  for (const [providerName, lineFor] of [
    [
      'claude',
      (sessionId) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    ],
    ['codex', (sessionId) => JSON.stringify({ type: 'thread.started', thread_id: sessionId })],
    ['omp', (sessionId) => JSON.stringify({ type: 'session', id: sessionId })],
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

  it('keeps fresh Claude and Codex conflict completion behavior permissive', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');

    for (const [providerName, lineFor] of [
      [
        'claude',
        (sessionId) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
      ],
      ['codex', (sessionId) => JSON.stringify({ type: 'thread.started', thread_id: sessionId })],
    ]) {
      const capture = createProviderSessionCapture({
        providerName,
        taskId: `${providerName}-fresh-conflict`,
        updateTask: () => {},
        log: () => {},
      });
      capture.captureLine(lineFor('session-a'));
      capture.captureLine(lineFor('session-b'));

      assert.strictEqual(capture.getCompletionError(), null, providerName);
      assert.deepStrictEqual(capture.getCompletionUpdate(0), {
        resumeIdentityVerified: true,
      });
    }
  });

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
        update: {
          sessionId: null,
          sessionIdConflict: true,
          resumeIdentityVerified: false,
        },
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

    assert.strictEqual(
      writes,
      2,
      'an in-memory conflict must remain sticky after the failed write'
    );
    assert.match(capture.getCompletionError(), /could not be persisted: database is locked/);
    assert.ok(logs.some((message) => message.includes('Failed to persist provider session')));
  });

  it('keeps both watcher recovery paths fail closed when conflict and terminal writes fail', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');
    const { buildTaskRecord } = await import('../../task-lib/runner.js');
    const { buildResumeTaskOptions } = await import('../../task-lib/commands/resume.js');
    const { buildCompletionResult } = require('../../src/agent/agent-task-executor');

    for (const watcherName of ['watcher.js', 'attachable-watcher.js']) {
      let locked = true;
      let storedTask = buildTaskRecord({
        id: `${watcherName}-locked-resume`,
        prompt: 'continue',
        cwd: '/tmp/project',
        options: { resume: 'requested-a' },
        logFile: `/tmp/${watcherName}.log`,
        providerName: 'claude',
        modelSpec: {},
      });
      const updateTask = (_taskId, update) => {
        const unsafeWrite = update.sessionIdConflict === true || Object.hasOwn(update, 'status');
        if (locked && unsafeWrite) {
          const error = new Error('database is locked');
          error.code = 'SQLITE_BUSY';
          throw error;
        }
        storedTask = { ...storedTask, ...update };
      };
      const capture = createProviderSessionCapture({
        providerName: 'claude',
        taskId: storedTask.id,
        requestedSessionId: storedTask.requestedResumeSessionId,
        updateTask,
        log: () => {},
      });

      capture.captureLine(JSON.stringify({ type: 'system', session_id: 'requested-a' }));
      capture.captureLine(JSON.stringify({ type: 'result', session_id: 'forked-b' }));
      assert.strictEqual(storedTask.sessionId, 'requested-a');
      assert.strictEqual(storedTask.resumeIdentityVerified, false);
      assert.throws(
        () =>
          updateTask(storedTask.id, {
            status: 'failed',
            ...capture.getCompletionUpdate(1),
          }),
        /database is locked/
      );

      locked = false;
      storedTask = { ...storedTask, status: 'stale' };
      const agent = {
        id: 'worker',
        iteration: 2,
        config: { cwd: '/tmp/project', outputFormat: 'text' },
        currentContextSequence: '2',
        currentGuidanceSequence: null,
        currentPromptIdentity: null,
        isolation: null,
        worktree: null,
      };
      const recovered = await buildCompletionResult({
        agent,
        taskId: storedTask.id,
        providerName: 'claude',
        state: { output: 'valid recovered output', logFilePath: null },
        stdout: 'Status: stale',
        success: true,
        taskInfo: storedTask,
      });

      assert.strictEqual(recovered.success, false);
      assert.match(recovered.error, /not durably verified/);
      assert.throws(() => buildResumeTaskOptions(storedTask), /did not durably verify/);
    }
  });

  it('keeps fresh OMP stale recovery fail closed when terminal verification is not persisted', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');
    const { buildTaskRecord } = await import('../../task-lib/runner.js');
    const { buildCompletionResult } = require('../../src/agent/agent-task-executor');

    let locked = true;
    let storedTask = buildTaskRecord({
      id: 'omp-locked-fresh',
      prompt: 'start',
      cwd: '/tmp/project',
      options: {},
      logFile: '/tmp/omp-locked-fresh.log',
      providerName: 'omp',
      modelSpec: {},
    });
    assert.strictEqual(storedTask.resumeIdentityVerified, false);

    const updateTask = (_taskId, update) => {
      if (locked && Object.hasOwn(update, 'status')) {
        const error = new Error('database is locked');
        error.code = 'SQLITE_BUSY';
        throw error;
      }
      storedTask = { ...storedTask, ...update };
    };
    const capture = createProviderSessionCapture({
      providerName: 'omp',
      taskId: storedTask.id,
      updateTask,
      log: () => {},
    });

    capture.captureLine(JSON.stringify({ type: 'session', id: 'omp-fresh-1' }));
    assert.strictEqual(storedTask.sessionId, 'omp-fresh-1');
    assert.strictEqual(storedTask.resumeIdentityVerified, false);
    assert.throws(
      () =>
        updateTask(storedTask.id, {
          status: 'completed',
          ...capture.getCompletionUpdate(0),
        }),
      /database is locked/
    );

    locked = false;
    storedTask = { ...storedTask, status: 'stale' };
    const recovered = await buildCompletionResult({
      agent: {
        id: 'worker',
        iteration: 1,
        config: { cwd: '/tmp/project', outputFormat: 'text' },
        currentContextSequence: '2',
        currentGuidanceSequence: null,
        currentPromptIdentity: null,
        isolation: null,
        worktree: null,
      },
      taskId: storedTask.id,
      providerName: 'omp',
      state: { output: 'unsafe stale output', logFilePath: null },
      stdout: 'Status: stale',
      success: true,
      taskInfo: storedTask,
    });

    assert.strictEqual(recovered.success, false);
    assert.match(recovered.error, /not durably verified/);
  });

  it('requires an explicit requested identity to be observed exactly', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');

    for (const [providerName, lineFor] of [
      ['codex', (sessionId) => JSON.stringify({ type: 'thread.started', thread_id: sessionId })],
      ['omp', (sessionId) => JSON.stringify({ type: 'session', id: sessionId })],
    ]) {
      for (const [name, observed, expected] of [
        ['confirmed', ['requested-a'], null],
        ['ignored', [], /did not confirm/],
        ['forked', ['forked-b'], /different session identity/],
        [
          'ambiguous',
          ['requested-a', 'forked-b'],
          /conflicting(?: or malformed)? session identities/,
        ],
      ]) {
        const capture = createProviderSessionCapture({
          providerName,
          taskId: `${providerName}-${name}-resume`,
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
    }
  });

  it('preserves permissive malformed handling outside OMP and rejects malformed OMP headers', async function () {
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
    const ompMissingId = captureProviderSessionLine({
      providerName: 'omp',
      line: JSON.stringify({ type: 'session' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });
    const ompEmptyId = captureProviderSessionLine({
      providerName: 'omp',
      line: JSON.stringify({ type: 'session', id: '' }),
      onCapture: (sessionId) => captured.push(sessionId),
    });

    assert.deepStrictEqual(malformed, { currentSessionId: null, sessionIdConflict: false });
    assert.deepStrictEqual(unsupported, { currentSessionId: null, sessionIdConflict: false });
    assert.deepStrictEqual(ompMissingId, { currentSessionId: null, sessionIdConflict: true });
    assert.deepStrictEqual(ompEmptyId, { currentSessionId: null, sessionIdConflict: true });
    assert.deepStrictEqual(captured, []);
  });

  it('makes malformed OMP output sticky even when a valid header follows', async function () {
    const { captureProviderSessionLine } =
      await import('../../task-lib/provider-session-capture.js');
    const observedSessionIds = new Set();
    let state = captureProviderSessionLine({
      providerName: 'omp',
      line: '{broken',
      observedSessionIds,
    });
    state = captureProviderSessionLine({
      providerName: 'omp',
      line: JSON.stringify({ type: 'session', id: 'omp-later-valid' }),
      observedSessionIds,
      ...state,
    });

    assert.deepStrictEqual(state, { currentSessionId: null, sessionIdConflict: true });
  });

  it('requires every fresh OMP completion to durably capture one exact identity', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');

    const missing = createProviderSessionCapture({
      providerName: 'omp',
      taskId: 'omp-fresh-missing',
      updateTask: () => {},
      log: () => {},
    });
    assert.match(missing.getCompletionError(), /required session identity/);

    const persisted = [];
    const valid = createProviderSessionCapture({
      providerName: 'omp',
      taskId: 'omp-fresh-valid',
      updateTask: (_taskId, update) => persisted.push(update),
      log: () => {},
    });
    valid.captureLine(JSON.stringify({ type: 'session', id: 'omp-exact' }));
    valid.captureLine(JSON.stringify({ type: 'session', id: 'omp-exact' }));
    assert.strictEqual(valid.getCompletionError(), null);
    assert.deepStrictEqual(persisted, [{ sessionId: 'omp-exact' }]);

    const persistenceFailed = createProviderSessionCapture({
      providerName: 'omp',
      taskId: 'omp-fresh-persistence-failed',
      updateTask: () => {
        throw new Error('database is locked');
      },
      log: () => {},
    });
    persistenceFailed.captureLine(JSON.stringify({ type: 'session', id: 'omp-uncommitted' }));
    assert.match(
      persistenceFailed.getCompletionError(),
      /could not be persisted: database is locked/
    );
  });

  it('rejects OMP prefix resolution and surrounding-whitespace identities', async function () {
    const { createProviderSessionCapture } =
      await import('../../task-lib/provider-session-capture.js');

    const prefix = createProviderSessionCapture({
      providerName: 'omp',
      taskId: 'omp-prefix-mismatch',
      requestedSessionId: 'omp-prefix',
      updateTask: () => {},
      log: () => {},
    });
    prefix.captureLine(JSON.stringify({ type: 'session', id: 'omp-prefix-full' }));
    assert.match(prefix.getCompletionError(), /different session identity/);

    const whitespace = createProviderSessionCapture({
      providerName: 'omp',
      taskId: 'omp-whitespace-id',
      requestedSessionId: 'omp-exact',
      updateTask: () => {},
      log: () => {},
    });
    whitespace.captureLine(JSON.stringify({ type: 'session', id: ' omp-exact ' }));
    assert.match(whitespace.getCompletionError(), /conflicting or malformed/);
  });
});
