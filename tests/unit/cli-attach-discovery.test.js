const assert = require('assert');
const { printAttachableAgentList } = require('../../cli/index.js');

async function captureConsole(callback) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

describe('CLI cluster attach discovery', function () {
  it('advertises only live attachable task sockets in a mixed active cluster', async function () {
    const agents = [
      {
        id: 'worker-codex',
        model: 'gpt-5.6-sol',
        state: 'executing',
        currentTaskId: 'task-live',
      },
      {
        id: 'worker-claude',
        model: 'claude-opus-4-6',
        state: 'executing',
        currentTaskId: 'task-nonpty',
      },
      {
        id: 'worker-stale',
        model: 'gpt-5.6-terra',
        state: 'executing',
        currentTaskId: 'task-stale',
      },
    ];
    const tasks = {
      'task-live': {
        pid: 111,
        attachable: true,
        provider: 'codex',
        socketPath: '/sockets/task-live.sock',
      },
      'task-nonpty': {
        pid: 222,
        attachable: false,
        provider: 'claude',
        socketPath: null,
      },
      'task-stale': {
        pid: 333,
        attachable: true,
        provider: 'codex',
        socketPath: '/sockets/task-stale.sock',
      },
    };
    const socketDiscovery = {
      getTaskSocketPath: (taskId) => `/sockets/${taskId}.sock`,
      isSocketAlive: (socketPath) => Promise.resolve(socketPath === '/sockets/task-live.sock'),
    };

    const output = await captureConsole(() =>
      printAttachableAgentList('mixed-cluster', agents, socketDiscovery, (taskId) =>
        Promise.resolve(tasks[taskId])
      )
    );

    assert(output.includes('zeroshot attach task-live'));
    assert(!output.includes('zeroshot attach task-nonpty'));
    assert(!output.includes('zeroshot attach task-stale'));
    assert(output.includes('Running without PTY attach support'));
    assert(output.includes('worker-claude'));
    assert(output.includes('provider: claude'));
    assert(output.includes('zeroshot logs mixed-cluster -f'));
    assert(output.includes('task task-stale socket not ready'));
  });
});
