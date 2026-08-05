const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let resolveEffectiveTaskStatus;
let getTasksData;
let getStatusData;

before(async function () {
  const effectiveStatusUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'task-lib', 'effective-status.js')
  ).href;
  const listUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'task-lib', 'commands', 'list.js')
  ).href;
  const statusUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'task-lib', 'commands', 'status.js')
  ).href;
  ({ resolveEffectiveTaskStatus } = await import(effectiveStatusUrl));
  ({ getTasksData } = await import(listUrl));
  ({ getStatusData } = await import(statusUrl));
});

describe('effective task status', function () {
  it('preserves settled stored statuses without probing a process', function () {
    let probed = false;
    const result = resolveEffectiveTaskStatus(
      { status: 'completed' },
      {
        isOwnedProcessTreeRunning() {
          probed = true;
          return false;
        },
      }
    );

    assert.deepStrictEqual(result, {
      status: 'completed',
      reason: null,
      detail: null,
      label: 'completed',
    });
    assert.strictEqual(probed, false);
  });

  it('uses the persisted process ownership when a task is running', function () {
    let received;
    const result = resolveEffectiveTaskStatus(
      {
        status: 'running',
        pid: 123,
        processGroupId: 456,
        terminationStrategy: 'process-group',
      },
      {
        isOwnedProcessTreeRunning(pid, ownership) {
          received = { pid, ownership };
          return true;
        },
      }
    );

    assert.deepStrictEqual(received, {
      pid: 123,
      ownership: { processGroupId: 456, terminationStrategy: 'process-group' },
    });
    assert.deepStrictEqual(result, {
      status: 'running',
      reason: null,
      detail: null,
      label: 'running',
    });
  });

  it('projects a dead running task as stale', function () {
    const result = resolveEffectiveTaskStatus(
      { status: 'running', pid: 123 },
      { isOwnedProcessTreeRunning: () => false }
    );

    assert.deepStrictEqual(result, {
      status: 'stale',
      reason: 'process_died',
      detail: 'process died',
      label: 'stale (process died)',
    });
  });

  it('fails closed when process ownership is invalid', function () {
    const result = resolveEffectiveTaskStatus(
      { status: 'running', pid: 123 },
      {
        isOwnedProcessTreeRunning() {
          throw new Error('unsafe details');
        },
      }
    );

    assert.deepStrictEqual(result, {
      status: 'stale',
      reason: 'invalid_process_ownership',
      detail: 'invalid process ownership',
      label: 'stale (invalid process ownership)',
    });
  });
});

describe('task list JSON projection', function () {
  const tasks = {
    late: {
      id: 'task-late',
      status: 'completed',
      cwd: '/repo/late',
      provider: 'codex',
      model: 'gpt',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      exitCode: 0,
      error: null,
      attachable: false,
      fullPrompt: 'must stay private',
      spawnOwnershipToken: 'must stay private',
    },
    stale: {
      id: 'task-stale',
      status: 'running',
      cwd: '/repo/stale',
      provider: 'claude',
      model: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      exitCode: null,
      error: 'process exited',
      attachable: true,
      commandCleanup: { path: '/private' },
      ompSessionOwnership: { partitionPath: '/private' },
    },
    early: {
      id: 'task-early',
      status: 'completed',
      cwd: '/repo/early',
      provider: null,
      model: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T01:00:00.000Z',
      exitCode: 1,
      error: 'failed',
      attachable: false,
    },
  };

  function deps() {
    return {
      loadTasks: () => tasks,
      resolveEffectiveTaskStatus(task) {
        return task.id === 'task-stale'
          ? { status: 'stale', reason: 'process_died', label: 'stale (process died)' }
          : { status: task.status, reason: null, label: task.status };
      },
    };
  }

  it('orders, filters, and limits by effective status', function () {
    assert.deepStrictEqual(
      getTasksData({ status: 'completed', limit: 1 }, deps()).map((task) => task.id),
      ['task-early']
    );
    assert.deepStrictEqual(
      getTasksData({ status: 'stale' }, deps()).map((task) => task.id),
      ['task-stale']
    );
  });

  it('returns only the bounded public projection', function () {
    assert.deepStrictEqual(getTasksData({ status: 'stale' }, deps()), [
      {
        id: 'task-stale',
        status: 'stale',
        statusReason: 'process_died',
        cwd: '/repo/stale',
        provider: 'claude',
        model: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        exitCode: null,
        error: 'process exited',
        attachable: true,
      },
    ]);
  });
});

describe('task status JSON projection', function () {
  const task = {
    id: 'task-detail',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    cwd: '/repo',
    pid: 321,
    exitCode: null,
    sessionId: 'session-1',
    requestedResumeSessionId: 'session-0',
    commandCleanup: { kind: 'temp-directory', path: '/private' },
    logFile: '/logs/task.log',
    prompt: 'short prompt',
    fullPrompt: 'complete prompt',
    error: 'process exited',
    provider: 'claude',
    model: 'sonnet',
    attachable: true,
    socketPath: '/private/socket',
    processGroupId: 321,
    spawnOwnershipToken: 'private-token',
    ompSessionOwnership: { partitionPath: '/private/session' },
  };

  it('returns the detailed public status shown to humans', function () {
    const status = getStatusData('task-detail', {
      getTask: () => task,
      resolveEffectiveTaskStatus: () => ({
        status: 'stale',
        reason: 'process_died',
        detail: 'process died',
        label: 'stale (process died)',
      }),
    });

    assert.deepStrictEqual(status, {
      id: 'task-detail',
      status: 'stale',
      statusReason: 'process_died',
      statusDetail: 'process died',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      cwd: '/repo',
      pid: 321,
      exitCode: null,
      sessionId: 'session-1',
      requestedResumeSessionId: 'session-0',
      cleanup: 'pending',
      logFile: '/logs/task.log',
      prompt: 'complete prompt',
      error: 'process exited',
      provider: 'claude',
      model: 'sonnet',
      attachable: true,
    });
  });

  it('fails when the task does not exist', function () {
    assert.throws(
      () => getStatusData('missing', { getTask: () => null }),
      /Task not found: missing/
    );
  });
});
