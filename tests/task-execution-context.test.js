const assert = require('node:assert/strict');

const EXECUTION_CONTEXT_ENV = 'ZEROSHOT_TASK_EXECUTION_CONTEXT';

describe('Detached task execution context', function () {
  it('defaults to detached and accepts only declared execution boundaries', async function () {
    const { resolveTaskExecutionContext } = await import('../task-lib/runner.js');

    assert.equal(resolveTaskExecutionContext({}), 'detached');
    for (const context of ['host', 'detached', 'docker', 'benchmark']) {
      assert.equal(resolveTaskExecutionContext({ [EXECUTION_CONTEXT_ENV]: context }), context);
    }
    for (const context of ['', ' container ', 'modal', 'Docker']) {
      assert.throws(
        () => resolveTaskExecutionContext({ [EXECUTION_CONTEXT_ENV]: context }),
        /ZEROSHOT_TASK_EXECUTION_CONTEXT must be one of/
      );
    }
  });

  it('propagates an explicit outer boundary into provider command preparation', async function () {
    const previous = process.env[EXECUTION_CONTEXT_ENV];
    process.env[EXECUTION_CONTEXT_ENV] = 'benchmark';
    try {
      const { prepareTaskProviderCommand } = await import('../task-lib/runner.js');
      const prepared = prepareTaskProviderCommand('inspect the workspace', {
        provider: 'codex',
      });

      assert.equal(prepared.options.executionContext, 'benchmark');
    } finally {
      if (previous === undefined) delete process.env[EXECUTION_CONTEXT_ENV];
      else process.env[EXECUTION_CONTEXT_ENV] = previous;
    }
  });

  it('rejects an invalid outer boundary before provider command preparation', async function () {
    const previous = process.env[EXECUTION_CONTEXT_ENV];
    process.env[EXECUTION_CONTEXT_ENV] = 'modal';
    try {
      const { prepareTaskProviderCommand } = await import('../task-lib/runner.js');
      assert.throws(
        () => prepareTaskProviderCommand('inspect the workspace', { provider: 'codex' }),
        /ZEROSHOT_TASK_EXECUTION_CONTEXT must be one of/
      );
    } finally {
      if (previous === undefined) delete process.env[EXECUTION_CONTEXT_ENV];
      else process.env[EXECUTION_CONTEXT_ENV] = previous;
    }
  });
});
