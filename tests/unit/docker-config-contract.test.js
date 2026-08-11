const assert = require('node:assert');

describe('Docker configuration CommonJS contract', function () {
  it('preserves the exact export surface and function arities', function () {
    const api = require('../../lib/docker-config');
    assert.deepStrictEqual(Reflect.ownKeys(api), [
      'MOUNT_PRESETS',
      'ENV_PRESETS',
      'PROVIDER_ENV_ONLY_PRESETS',
      'resolveMounts',
      'resolveEnvs',
      'expandEnvPatterns',
      'isUsableEnvValue',
      'isUsableHttpUrl',
      'validateMountConfig',
      'validateEnvPassthrough',
      'validateProviderEnvAuth',
    ]);
    assert.deepStrictEqual(
      Object.values(api)
        .filter((value) => typeof value === 'function')
        .map((value) => value.length),
      [1, 1, 1, 1, 1, 1, 1, 2]
    );
  });
});
