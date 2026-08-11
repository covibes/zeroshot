/**
 * Test: PATH check utility
 *
 * Verifies detection of whether the npm global bin dir is on PATH.
 */

const path = require('path');
const assert = require('assert');
const pathCheck = require('../lib/path-check');
const { getGlobalBinDir, isDirOnPath, getPathExportLine, checkBinDirOnPath } = pathCheck;

describe('path-check exports', function () {
  it('preserves the exact CommonJS export shape', function () {
    assert.deepStrictEqual(Reflect.ownKeys(pathCheck), [
      'getGlobalBinDir',
      'isDirOnPath',
      'getPathExportLine',
      'checkBinDirOnPath',
      'printPathWarning',
    ]);
  });
});

describe('path-check', function () {
  describe('isDirOnPath', function () {
    it('detects an exact match', function () {
      assert.strictEqual(isDirOnPath('/foo/bar', '/foo/bar:/usr/bin'), true);
    });

    it('normalizes trailing slashes in PATH entries', function () {
      assert.strictEqual(isDirOnPath('/foo/bar', '/foo/bar/:/usr/bin'), true);
    });

    it('returns false when dir is not present', function () {
      assert.strictEqual(isDirOnPath('/foo/bar', '/usr/bin:/usr/local/bin'), false);
    });

    it('returns false for an empty PATH', function () {
      assert.strictEqual(isDirOnPath('/foo/bar', ''), false);
    });
  });

  describe('getGlobalBinDir', function () {
    const originalPlatform = process.platform;

    afterEach(function () {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('appends bin on posix platforms', function () {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      assert.strictEqual(getGlobalBinDir('/usr/local'), path.join('/usr/local', 'bin'));
    });

    it('returns the prefix unchanged on win32', function () {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      assert.strictEqual(getGlobalBinDir('C:\\nvm\\node'), 'C:\\nvm\\node');
    });
  });

  describe('getPathExportLine', function () {
    it('formats an export line', function () {
      assert.strictEqual(getPathExportLine('/foo/bar'), 'export PATH="/foo/bar:$PATH"');
    });
  });

  describe('checkBinDirOnPath', function () {
    const originalPlatform = process.platform;

    afterEach(function () {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('short-circuits to onPath:true on win32', function () {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const result = checkBinDirOnPath({ installPrefix: 'C:\\nvm\\node' });
      assert.deepStrictEqual(result, { onPath: true, binDir: null });
    });

    it('returns onPath:true when the bin dir is in PATH', function () {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const binDir = path.join('/opt/node', 'bin');
      const result = checkBinDirOnPath({
        installPrefix: '/opt/node',
        pathEnv: `${binDir}:/usr/bin`,
      });
      assert.strictEqual(result.onPath, true);
      assert.strictEqual(result.binDir, binDir);
    });

    it('returns onPath:false when the bin dir is missing from PATH', function () {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const result = checkBinDirOnPath({
        installPrefix: '/opt/node',
        pathEnv: '/usr/bin:/usr/local/bin',
      });
      assert.strictEqual(result.onPath, false);
      assert.strictEqual(result.binDir, path.join('/opt/node', 'bin'));
    });
  });
});
