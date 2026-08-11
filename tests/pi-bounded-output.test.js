const assert = require('node:assert');
const { piUsage } = require('./helpers/pi-protocol');

const {
  broadcastAgentLine,
  buildCompletionResult,
  createLogFollowState,
  flushAgentOutput,
} = require('../src/agent/agent-task-executor');

function piAgent(messages = []) {
  return {
    id: 'pi-bounded-worker',
    role: 'implementation',
    iteration: 1,
    config: { outputFormat: 'text', cwd: process.cwd() },
    _publish: (message) => messages.push(message),
  };
}

function broadcastPi(agent, state, event) {
  broadcastAgentLine({
    agent,
    providerName: 'pi',
    state,
    line: typeof event === 'string' ? event : JSON.stringify(event),
  });
}

function overflowPiTail(agent, state) {
  for (let index = 0; index < 1100; index++) {
    broadcastPi(agent, state, { type: 'queue_update', action: 'progress', index });
  }
}

function completePi(agent, state, taskId) {
  flushAgentOutput(agent, 'pi', state);
  return buildCompletionResult({
    agent,
    taskId,
    providerName: 'pi',
    state,
    stdout: 'Status: completed',
    success: true,
    taskInfo: null,
  });
}

function successfulAssistant(usage = piUsage()) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    usage,
    stopReason: 'stop',
  };
}

describe('bounded Pi provider output', function () {
  it('retains all Pi usage sources outside the bounded display tail', async function () {
    const agent = piAgent();
    const state = createLogFollowState();
    const failed = successfulAssistant(
      piUsage(10, 2, 0, 0, { cost: { input: 0.04, output: 0.06, total: 0.1 } })
    );
    failed.content = [];
    failed.stopReason = 'error';
    failed.errorMessage = 'temporary failure';
    const supportingEvents = [
      { type: 'message_end', message: failed },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          usage: piUsage(2, 1, 0, 0, { cost: { input: 0.01, output: 0.02, total: 0.03 } }),
        },
      },
      {
        type: 'compaction_end',
        result: {
          usage: piUsage(4, 1, 0, 0, { cost: { input: 0.02, output: 0.03, total: 0.05 } }),
        },
      },
      {
        type: 'entry_appended',
        entry: {
          type: 'branch_summary',
          usage: piUsage(1, 1, 0, 0, { cost: { input: 0.01, output: 0.01, total: 0.02 } }),
        },
      },
    ];
    for (const event of supportingEvents) broadcastPi(agent, state, event);
    overflowPiTail(agent, state);
    broadcastPi(agent, state, {
      type: 'message_end',
      message: successfulAssistant(
        piUsage(3, 1, 0, 0, { cost: { input: 0.1, output: 0.1, total: 0.2 } })
      ),
    });
    broadcastPi(agent, state, { type: 'agent_settled' });

    const result = await completePi(agent, state, 'pi-bounded-usage');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.tokenUsage.inputTokens, 20);
    assert.strictEqual(result.tokenUsage.outputTokens, 6);
    assert.strictEqual(result.tokenUsage.modelUsage.totalTokens, 26);
    assert.strictEqual(typeof result.tokenUsage.totalCostUsd, 'number');
    assert.ok(Math.abs(result.tokenUsage.totalCostUsd - 0.4) < Number.EPSILON);
    assert.match(result.output, /Earlier provider output omitted/);
  });

  it('retains successful terminal truth when the assistant record leaves the tail', async function () {
    const agent = piAgent();
    const state = createLogFollowState();
    broadcastPi(agent, state, {
      type: 'message_end',
      message: successfulAssistant(piUsage(7, 3)),
    });
    overflowPiTail(agent, state);
    broadcastPi(agent, state, { type: 'agent_settled' });

    const result = await completePi(agent, state, 'pi-bounded-terminal');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.tokenUsage.inputTokens, 7);
    assert.match(result.output, /Earlier provider output omitted/);
    assert.doesNotMatch(result.output, /"type":"message_end"/);
  });

  for (const [name, invalid] of [
    ['malformed', 'NOT JSON'],
    ['missing-type', '{}'],
    ['footer-shaped', 'Finished: extension accidentally wrote to stdout'],
    ['system-init-shaped', 'junk {"type":"system","subtype":"init"}'],
  ]) {
    it(`retains protocol failure for evicted ${name} output`, async function () {
      const agent = piAgent();
      const state = createLogFollowState();
      broadcastPi(agent, state, invalid);
      overflowPiTail(agent, state);
      broadcastPi(agent, state, { type: 'message_end', message: successfulAssistant() });
      broadcastPi(agent, state, { type: 'agent_settled' });

      const result = await completePi(agent, state, 'pi-bounded-invalid');

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.providerFailure.event, 'agent_settled');
    });
  }

  it('fails closed when an oversized Pi record is represented only by a receipt', async function () {
    const agent = piAgent();
    const state = createLogFollowState();
    broadcastPi(
      agent,
      state,
      '[ZEROSHOT] Provider output record retained in task log but omitted from the control plane'
    );
    broadcastPi(agent, state, { type: 'message_end', message: successfulAssistant() });
    broadcastPi(agent, state, { type: 'agent_settled' });

    const result = await completePi(agent, state, 'pi-oversized-record');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.providerFailure.event, 'agent_settled');
  });
});
