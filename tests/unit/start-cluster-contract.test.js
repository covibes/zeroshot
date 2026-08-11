const assert = require('node:assert');

describe('start cluster CommonJS contract', function () {
  it('preserves the exact export surface and function arities', function () {
    const api = require('../../lib/start-cluster');
    assert.deepStrictEqual(Reflect.ownKeys(api), [
      'buildTextInput',
      'buildIssueInput',
      'buildFileInput',
      'detectRunInput',
      'isStdinInput',
      'readStdinText',
      'encodeStdinEnv',
      'decodeStdinEnv',
      'resolveProviderOverride',
      'resolveConfigPath',
      'prepareClusterConfig',
      'loadClusterConfig',
      'buildStartOptions',
      'buildTrustedStartOptions',
      'resolveEffectiveRunPlan',
      'startClusterFromText',
      'startClusterFromIssue',
      'startClusterFromFile',
      'detectGitRepoRoot',
    ]);
    assert.deepStrictEqual(
      Object.values(api).map((value) => value.length),
      [1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 2, 1, 1, 0, 1, 1, 1, 0]
    );
  });
});
