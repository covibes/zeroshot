const assert = require('node:assert');

describe('Git remote utils CommonJS contract', function () {
  it('preserves the exact export surface and function arities', function () {
    const api = require('../../lib/git-remote-utils');
    assert.deepStrictEqual(Reflect.ownKeys(api), [
      'normalizeGitRemoteName',
      'quoteShellArgument',
      'parseGitRemoteUrl',
      'detectGitContext',
    ]);
    assert.deepStrictEqual(
      Object.values(api).map((value) => value.length),
      [1, 1, 1, 0]
    );
  });
});
