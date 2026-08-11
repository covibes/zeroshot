const assert = require('node:assert');

describe('detached startup CommonJS contract', function () {
  it('preserves the exact export surface and function arities', function () {
    const api = require('../../lib/detached-startup');
    assert.deepStrictEqual(Reflect.ownKeys(api), [
      'DEFAULT_WAIT_TIMEOUT_SECONDS',
      'getClustersFilePath',
      'getRegisteredResumeDaemonPid',
      'isClusterRegistered',
      'isProcessAlive',
      'markDetachedSetupFailed',
      'patchDetachedResumeCluster',
      'registerDetachedSetupCluster',
      'removeDetachedSetupCluster',
      'resolveWaitTimeoutMs',
      'revertDetachedResumeCluster',
      'waitForClusterRegistration',
      'waitForResumeOwnership',
    ]);
    assert.deepStrictEqual(
      Object.values(api)
        .filter((value) => typeof value === 'function')
        .map((value) => value.length),
      [1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    );
  });
});
