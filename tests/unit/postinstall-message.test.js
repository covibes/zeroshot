const assert = require('assert');

const {
  LIFECYCLE_SCRIPTS,
  SETUP_INVITATION,
  runPostinstall,
  shouldPrintSetupInvitation,
} = require('../../scripts/postinstall');

function capturePostinstall(env, statuses = {}) {
  const scripts = [];
  let output = '';
  const status = runPostinstall({
    env,
    stdout: {
      write(value) {
        output += value;
      },
    },
    runScript(scriptName) {
      scripts.push(scriptName);
      return statuses[scriptName] ?? 0;
    },
  });
  return { output, scripts, status };
}

describe('postinstall setup invitation', function () {
  it('runs the existing lifecycle scripts before a global-install invitation', function () {
    const result = capturePostinstall({ npm_config_global: 'true' });
    assert.deepStrictEqual(result.scripts, LIFECYCLE_SCRIPTS);
    assert.strictEqual(result.output, SETUP_INVITATION);
    assert.strictEqual(result.status, 0);
  });

  it('recognizes npm location=global', function () {
    assert.strictEqual(shouldPrintSetupInvitation({ npm_config_location: 'global' }), true);
  });

  for (const testCase of [
    { name: 'local dependency installs', env: {} },
    { name: 'CI global installs', env: { npm_config_global: 'true', CI: '1' } },
    { name: 'CI=true global installs', env: { npm_config_location: 'global', CI: 'true' } },
  ]) {
    it(`stays quiet for ${testCase.name}`, function () {
      const result = capturePostinstall(testCase.env);
      assert.deepStrictEqual(result.scripts, LIFECYCLE_SCRIPTS);
      assert.strictEqual(result.output, '');
      assert.strictEqual(result.status, 0);
    });
  }

  it('preserves failure ordering and skips later lifecycle work', function () {
    const result = capturePostinstall({ npm_config_global: 'true' }, { [LIFECYCLE_SCRIPTS[0]]: 7 });
    assert.deepStrictEqual(result.scripts, [LIFECYCLE_SCRIPTS[0]]);
    assert.strictEqual(result.output, '');
    assert.strictEqual(result.status, 7);
  });
});
