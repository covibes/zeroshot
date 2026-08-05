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

describe('effective task startup status', function () {
  it('preserves only the bounded window before the provider PID is published', function () {
    let probed = false;
    const task = {
      status: 'running',
      pid: null,
      createdAt: '2026-08-05T12:00:00.000Z',
    };
    const result = resolveEffectiveTaskStatus(task, {
      now: () => Date.parse('2026-08-05T12:00:05.000Z'),
      isOwnedProcessTreeRunning() {
        probed = true;
        return false;
      },
    });

    assert.deepStrictEqual(result, {
      status: 'running',
      reason: null,
      detail: null,
      label: 'running',
    });
    assert.strictEqual(probed, false);
  });

  it('projects an abandoned startup as stale after the grace window', function () {
    const result = resolveEffectiveTaskStatus(
      {
        status: 'running',
        pid: null,
        createdAt: '2026-08-05T12:00:00.000Z',
      },
      {
        now: () => Date.parse('2026-08-05T12:00:31.000Z'),
        isOwnedProcessTreeRunning() {
          throw new Error('null startup PID must not be probed');
        },
      }
    );

    assert.deepStrictEqual(result, {
      status: 'stale',
      reason: 'startup_timeout',
      detail: 'provider startup timed out',
      label: 'stale (provider startup timed out)',
    });
  });
});
