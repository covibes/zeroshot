const assert = require('node:assert');

const {
  appendContentToBuffer,
  broadcastAgentLine,
  createLogFollowState,
  finishHostLogCapture,
} = require('../src/agent/agent-task-executor');

describe('host terminal log catch-up', function () {
  it('reads and parses the final UTF-8 record after terminal status', function () {
    const published = [];
    const agent = {
      id: 'tail-worker',
      role: 'implementation',
      iteration: 1,
      currentTask: {},
      lastOutputTime: null,
      messageBus: { publish: (message) => published.push(message) },
      _publish: (message) => published.push(message),
    };
    const state = createLogFollowState();
    const broadcast = (line) => broadcastAgentLine({ agent, providerName: 'codex', state, line });
    const consume = (content) => appendContentToBuffer(state, content, broadcast);
    const final = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"summary":"café 🌍","result":"ok"}' },
    });
    let polls = 0;

    finishHostLogCapture(
      agent,
      state,
      () => {
        polls += 1;
        consume(`[1700000000000]${final}`);
      },
      consume,
      broadcast
    );

    assert.strictEqual(polls, 1);
    assert.match(state.output, /café 🌍/);
    assert.strictEqual(state.lineBuffer.byteLength, 0);
    assert.strictEqual(agent.currentTask, null);
    assert.strictEqual(published.length, 1);
  });
});
