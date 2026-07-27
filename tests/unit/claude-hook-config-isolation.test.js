const assert = require('assert');

const {
  ensureAskUserQuestionHook,
  ensureDangerousGitHook,
} = require('../../src/agent/agent-task-executor');

describe('Claude safety hook config isolation', function () {
  it('refuses to install safety hooks without an explicit per-run directory', function () {
    assert.throws(() => ensureAskUserQuestionHook(), /explicit per-run settings directory/);
    assert.throws(() => ensureDangerousGitHook(), /explicit per-run settings directory/);
  });
});
