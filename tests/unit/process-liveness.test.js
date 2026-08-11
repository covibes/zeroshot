const assert = require('assert');
const processLiveness = require('../../lib/process-liveness');
const { isProcessRunning } = processLiveness;

describe('process-liveness exports', function () {
  it('preserves the exact CommonJS export shape', function () {
    assert.deepStrictEqual(Reflect.ownKeys(processLiveness), ['isProcessRunning']);
  });
});

describe('process-liveness', function () {
  const originalKill = process.kill;

  afterEach(function () {
    process.kill = originalKill;
  });

  it('reports the current process as running', function () {
    assert.strictEqual(isProcessRunning(process.pid), true);
  });

  it('reports a PID that does not exist as not running', function () {
    assert.strictEqual(isProcessRunning(999999), false);
  });

  it('rejects non-PID inputs without throwing', function () {
    assert.strictEqual(isProcessRunning(null), false);
    assert.strictEqual(isProcessRunning(undefined), false);
    assert.strictEqual(isProcessRunning(0), false);
    assert.strictEqual(isProcessRunning(-5), false);
    assert.strictEqual(isProcessRunning(1.5), false);
    assert.strictEqual(isProcessRunning('123'), false);
  });

  it('treats EPERM as evidence that the process exists', function () {
    process.kill = function () {
      const error = new Error('not permitted');
      error.code = 'EPERM';
      throw error;
    };

    assert.strictEqual(isProcessRunning(123), true);
  });

  it('treats other process errors as not running', function () {
    process.kill = function () {
      const error = new Error('no such process');
      error.code = 'ESRCH';
      throw error;
    };

    assert.strictEqual(isProcessRunning(123), false);
  });
});
