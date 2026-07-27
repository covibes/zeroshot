const assert = require('assert');
const Database = require('better-sqlite3');

describe('single-task session resume', function () {
  it('keeps a requested resume ID separate from watcher-captured identity', async function () {
    const { buildTaskRecord } = await import('../../task-lib/runner.js');
    const task = buildTaskRecord({
      id: 'task-resumed',
      prompt: 'continue',
      cwd: '/tmp/project',
      options: { resume: 'requested-thread' },
      logFile: '/tmp/task-resumed.log',
      providerName: 'codex',
      modelSpec: {},
    });

    assert.strictEqual(task.requestedResumeSessionId, 'requested-thread');
    assert.strictEqual(task.sessionId, null);
  });

  it('uses the captured explicit provider session ID', async function () {
    const { buildResumeTaskOptions } = await import('../../task-lib/commands/resume.js');
    assert.deepStrictEqual(
      buildResumeTaskOptions({
        id: 'task-1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/tmp/project',
      }),
      {
        provider: 'codex',
        resume: 'thread-1',
        cwd: '/tmp/project',
      }
    );
  });

  it('fails deterministically instead of selecting another task or agent session', async function () {
    const { buildResumeTaskOptions } = await import('../../task-lib/commands/resume.js');

    assert.throws(
      () =>
        buildResumeTaskOptions({
          id: 'task-without-session',
          provider: 'claude',
          sessionId: null,
          cwd: '/tmp/project',
        }),
      /no captured provider session ID/
    );
    assert.throws(
      () =>
        buildResumeTaskOptions({
          id: 'unsupported-task',
          provider: 'gemini',
          sessionId: 'gemini-session',
          cwd: '/tmp/project',
        }),
      /does not support safe session resume/
    );
  });

  it('migrates legacy requested IDs out of the observed session column with version proof', async function () {
    const { migrateTaskStore, TASK_STORE_SCHEMA_VERSION } = await import('../../task-lib/store.js');
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          session_id TEXT
        );
        INSERT INTO tasks (id, session_id) VALUES ('legacy-task', 'historically-requested-id');
      `);

      migrateTaskStore(database);

      const row = database
        .prepare('SELECT session_id, requested_resume_session_id FROM tasks WHERE id = ?')
        .get('legacy-task');
      assert.strictEqual(row.session_id, null);
      assert.strictEqual(row.requested_resume_session_id, 'historically-requested-id');
      assert.strictEqual(
        database.pragma('user_version', { simple: true }),
        TASK_STORE_SCHEMA_VERSION
      );

      database
        .prepare(
          `INSERT INTO tasks (id, session_id, requested_resume_session_id)
           VALUES ('captured-task', 'observed-id', 'requested-id')`
        )
        .run();
      migrateTaskStore(database);
      assert.deepStrictEqual(
        database
          .prepare('SELECT session_id, requested_resume_session_id FROM tasks WHERE id = ?')
          .get('captured-task'),
        { session_id: 'observed-id', requested_resume_session_id: 'requested-id' }
      );
    } finally {
      database.close();
    }
  });
});
