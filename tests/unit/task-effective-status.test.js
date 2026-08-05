const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let resolveEffectiveTaskStatus;

before(async function () {
  const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'task-lib', 'effective-status.js')
  ).href;
  ({ resolveEffectiveTaskStatus } = await import(moduleUrl));
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

    assert.deepStrictEqual(result, { status: 'completed', reason: null, label: 'completed' });
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
    assert.deepStrictEqual(result, { status: 'running', reason: null, label: 'running' });
  });

  it('projects a dead running task as stale', function () {
    const result = resolveEffectiveTaskStatus(
      { status: 'running', pid: 123 },
      { isOwnedProcessTreeRunning: () => false }
    );

    assert.deepStrictEqual(result, {
      status: 'stale',
      reason: 'process_died',
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
      label: 'stale (invalid process ownership)',
    });
  });
});
