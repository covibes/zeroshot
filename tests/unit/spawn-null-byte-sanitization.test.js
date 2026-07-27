const assert = require('assert');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

// Regression guard for #621: null byte in prompt crashes spawn() with ERR_INVALID_ARG_VALUE.
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
    // No stub: exercises the real spawn() to prove the sanitized args are safe.
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

describe('IsolationManager.spawnInContainer null byte sanitization', function () {
  it('strips null bytes from string args before calling spawn()', function () {
    const spawnStub = sinon.stub(childProcess, 'spawn').returns(new EventEmitter());
    try {
      const managerPath = require.resolve('../../src/isolation-manager');
      delete require.cache[managerPath];
      const IsolationManager = require(managerPath);
      const manager = new IsolationManager();
      manager.containers.set('cluster-1', 'container-abc');

      const dirtyPrompt = 'You are agent "worker".\0trailing after null byte';
      manager.spawnInContainer('cluster-1', ['zeroshot', 'task', 'run', dirtyPrompt]);

      assert.strictEqual(spawnStub.calledOnce, true);
      const [bin, spawnedArgs] = spawnStub.firstCall.args;
      assert.strictEqual(bin, 'docker');
      for (const arg of spawnedArgs) {
        assert.strictEqual(arg.includes('\0'), false, `arg still contains a null byte: ${arg}`);
      }
      assert.strictEqual(spawnedArgs.at(-1), 'You are agent "worker".trailing after null byte');
    } finally {
      spawnStub.restore();
      const managerPath = require.resolve('../../src/isolation-manager');
      delete require.cache[managerPath];
    }
  });
});
