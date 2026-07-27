const assert = require('assert');

describe('single-task session resume', function () {
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
});
