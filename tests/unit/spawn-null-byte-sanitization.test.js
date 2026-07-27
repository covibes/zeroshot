const assert = require('assert');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

// Regression guard for GitHub issue #621: a task prompt containing a null
// byte reaches spawn() as an argv string and crashes with
// ERR_INVALID_ARG_VALUE (argv strings are null-terminated at the OS level).
describe('spawnTaskProcess null byte sanitization', function () {
  it('strips null bytes from string args before calling spawn()', function () {
    const fakeChild = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnStub = sinon.stub(childProcess, 'spawn').returns(fakeChild);
    try {
      const executorPath = require.resolve('../../src/agent/agent-task-executor');
      delete require.cache[executorPath];
      const { spawnTaskProcess } = require(executorPath);

      const dirtyPrompt = 'You are agent "worker".\nDo the task.\0trailing after null byte';
      const pending = spawnTaskProcess({
        agent: { _log: () => {} },
        ctPath: 'zeroshot',
        args: ['task', 'run', dirtyPrompt],
        cwd: '/tmp',
        spawnEnv: {},
      });

      assert.strictEqual(spawnStub.calledOnce, true);
      const spawnedArgs = spawnStub.firstCall.args[1];
      for (const arg of spawnedArgs) {
        assert.strictEqual(arg.includes('\0'), false, `arg still contains a null byte: ${arg}`);
      }
      assert.strictEqual(
        spawnedArgs[2],
        'You are agent "worker".\nDo the task.trailing after null byte'
      );

      // Resolve the pending promise so it doesn't leak an unhandled rejection.
      fakeChild.emit('close', 1);
      return assert.rejects(pending);
    } finally {
      spawnStub.restore();
      const executorPath = require.resolve('../../src/agent/agent-task-executor');
      delete require.cache[executorPath];
    }
  });

  it('does not throw ERR_INVALID_ARG_VALUE when spawn() runs for real on a null-byte prompt', async function () {
    // No stub here: exercises the real child_process.spawn to prove the
    // sanitized args are actually safe to hand to the OS, not just to our stub.
    const executorPath = require.resolve('../../src/agent/agent-task-executor');
    delete require.cache[executorPath];
    const { spawnTaskProcess } = require(executorPath);

    const dirtyPrompt = 'prompt with a null byte \0 in the middle';
    const pending = spawnTaskProcess({
      agent: { _log: () => {} },
      ctPath: process.execPath, // node itself; unrecognized output still exercises the real spawn() call
      args: ['--version', dirtyPrompt],
      cwd: '/tmp',
      spawnEnv: process.env,
    });

    try {
      await pending;
    } catch (err) {
      assert.notStrictEqual(err.code, 'ERR_INVALID_ARG_VALUE');
      assert.doesNotMatch(err.message, /null bytes/);
    }
  });
});
