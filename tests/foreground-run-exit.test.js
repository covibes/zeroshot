const assert = require('node:assert/strict');

const {
  buildForegroundResult,
  exitCodeForForegroundResult,
  exitCodeForResult,
} = require('../src/foreground-benchmark-run');

function terminal(topic, data = {}) {
  return {
    sequence: '1',
    topic,
    sender: 'worker',
    receiver: 'system',
    content: { data },
  };
}

function harness(message) {
  return {
    orchestrator: {
      getStatus: () => ({
        state: 'stopped',
        isZombie: false,
        agents: [{ id: 'worker', pid: null }],
      }),
    },
    cluster: {
      messageBus: {
        query: ({ topic }) => (message.topic === topic ? [message] : []),
      },
    },
    clusterId: 'real-user-run',
    cancelled: false,
  };
}

describe('foreground user-run exit status', function () {
  it('returns zero only for a completed real-user run', function () {
    const completed = buildForegroundResult(harness(terminal('CLUSTER_COMPLETE')));
    assert.strictEqual(exitCodeForForegroundResult(completed), 0);
  });

  it('uses the terminal handoff after successful delivery closes the live ledger', function () {
    const message = terminal('CLUSTER_COMPLETE');
    const status = {
      state: 'killed',
      isZombie: false,
      agents: [{ id: 'worker', pid: null }],
    };
    const result = buildForegroundResult({
      orchestrator: {
        getFinalRun: () => ({ status, terminalMessages: [message] }),
        getStatus: () => {
          throw new Error('live cluster was removed');
        },
      },
      cluster: {
        messageBus: {
          query: () => {
            throw new Error('database connection is not open');
          },
        },
      },
      clusterId: 'closed-delivery-run',
      cancelled: false,
    });

    assert.strictEqual(result.outcome, 'completed');
    assert.strictEqual(exitCodeForForegroundResult(result), 0);
  });

  it('returns nonzero when a real-user run exhausts its work budget', function () {
    const failed = buildForegroundResult(
      harness(terminal('CLUSTER_FAILED', { reason: 'max_iterations' }))
    );

    assert.strictEqual(failed.outcome, 'task_failure');
    assert.strictEqual(exitCodeForForegroundResult(failed), 23);
    assert.strictEqual(exitCodeForResult(failed), 0, 'benchmark verifier semantics stay unchanged');
  });
});
