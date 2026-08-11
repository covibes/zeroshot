const assert = require('assert');

const {
  LEGACY_LIB_OUTPUT,
  LEGACY_LIB_PROJECT,
  LIFECYCLE_SCRIPTS,
  SETUP_INVITATION,
  ensureLegacyLibBuild,
  runPostinstall,
  shouldPrintSetupInvitation,
} = require('../../scripts/postinstall');

function capturePostinstall(env, statuses = {}, buildStatus = 0) {
  const scripts = [];
  let buildCount = 0;
  let output = '';
  const status = runPostinstall({
    env,
    stdout: {
      write(value) {
        output += value;
      },
    },
    ensureBuild() {
      buildCount += 1;
      return buildStatus;
    },
    runScript(scriptName) {
      scripts.push(scriptName);
      return statuses[scriptName] ?? 0;
    },
  });
  return { buildCount, output, scripts, status };
}

describe('postinstall legacy TypeScript build', function () {
  it('skips the compiler when the generated runtime already exists', function () {
    let compilerResolved = false;
    const status = ensureLegacyLibBuild({
      outputExists(outputPath) {
        assert.strictEqual(outputPath, LEGACY_LIB_OUTPUT);
        return true;
      },
      resolveCompiler() {
        compilerResolved = true;
        return '/unused/tsc';
      },
    });

    assert.strictEqual(status, 0);
    assert.strictEqual(compilerResolved, false);
  });

  it('builds the generated runtime when it is missing', function () {
    const compilerPath = '/workspace/node_modules/typescript/bin/tsc';
    let invocation;
    const status = ensureLegacyLibBuild({
      outputExists(outputPath) {
        assert.strictEqual(outputPath, LEGACY_LIB_OUTPUT);
        return false;
      },
      resolveCompiler() {
        return compilerPath;
      },
      runCompiler(executable, args, options) {
        invocation = { executable, args, options };
        return { status: 0 };
      },
    });

    assert.strictEqual(status, 0);
    assert.deepStrictEqual(invocation, {
      executable: process.execPath,
      args: [compilerPath, '--project', LEGACY_LIB_PROJECT],
      options: { stdio: 'inherit' },
    });
  });
});

describe('postinstall setup invitation', function () {
  it('runs the existing lifecycle scripts before a global-install invitation', function () {
    const result = capturePostinstall({ npm_config_global: 'true' });
    assert.strictEqual(result.buildCount, 1);
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

  it('stops before lifecycle scripts when the legacy build fails', function () {
    const result = capturePostinstall({ npm_config_global: 'true' }, {}, 9);
    assert.strictEqual(result.buildCount, 1);
    assert.deepStrictEqual(result.scripts, []);
    assert.strictEqual(result.output, '');
    assert.strictEqual(result.status, 9);
  });

  it('preserves failure ordering and skips later lifecycle work', function () {
    const result = capturePostinstall({ npm_config_global: 'true' }, { [LIFECYCLE_SCRIPTS[0]]: 7 });
    assert.deepStrictEqual(result.scripts, [LIFECYCLE_SCRIPTS[0]]);
    assert.strictEqual(result.output, '');
    assert.strictEqual(result.status, 7);
  });
});
