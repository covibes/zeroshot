const assert = require('assert');

const {
  CONTROL_PLANE_OUTPUT_LIMITS,
  appendControlPlaneRecord,
  broadcastAgentLine,
  broadcastIsolatedLine,
  buildCompletionResult,
  createIsolatedLogState,
  createLogFollowState,
  flushAgentOutput,
  flushIsolatedOutput,
} = require('../src/agent/agent-task-executor');

function makeAgent(messages, outputFormat = 'json') {
  return {
    id: 'stress-worker',
    role: 'implementation',
    iteration: 1,
    config: { outputFormat, cwd: process.cwd() },
    _publish: (message) => messages.push(message),
    _parseResultOutput: (output) => {
      for (const line of output.trim().split('\n').reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.structured_output) return parsed.structured_output;
        } catch {
          // Continue through non-JSON diagnostic lines.
        }
      }
      throw new Error('missing structured output');
    },
  };
}

function broadcastStressRecords({ agent, state, count = 5000 }) {
  const payload = 'x'.repeat(2048);
  for (let index = 0; index < count; index++) {
    broadcastAgentLine({
      agent,
      providerName: 'codex',
      state,
      line: `[1777777777777]${JSON.stringify({ type: 'item.completed', index, payload })}`,
    });
  }
}

function assertControlPlaneIsBounded(messages, output) {
  const publishedBytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content.data.line),
    0
  );
  assert.ok(Buffer.byteLength(output) <= CONTROL_PLANE_OUTPUT_LIMITS.maxBytes);
  assert.ok(
    publishedBytes <= CONTROL_PLANE_OUTPUT_LIMITS.liveBytes + CONTROL_PLANE_OUTPUT_LIMITS.maxBytes
  );
  assert.ok(
    messages.length <=
      CONTROL_PLANE_OUTPUT_LIMITS.liveRecords + CONTROL_PLANE_OUTPUT_LIMITS.maxRecords + 1
  );
}

describe('bounded cumulative provider output', function () {
  it('retains the terminal structured result after many small records', async function () {
    const messages = [];
    const agent = makeAgent(messages);
    const state = createLogFollowState();
    broadcastStressRecords({ agent, state });
    broadcastAgentLine({
      agent,
      providerName: 'codex',
      state,
      line: `[1777777777777]${JSON.stringify({
        type: 'result',
        subtype: 'success',
        structured_output: { answer: 'terminal-success' },
      })}`,
    });
    flushAgentOutput(agent, 'codex', state);

    const result = await buildCompletionResult({
      agent,
      taskId: 'stress-success',
      providerName: 'codex',
      state,
      stdout: 'Status: completed',
      success: true,
      taskInfo: null,
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.parsedResult, { answer: 'terminal-success' });
    assert.match(result.output, /Earlier provider output omitted/);
    assert.ok(messages.some((message) => message.content.data.line.includes('terminal-success')));
    assert.ok(messages.every((message) => message.content.text === undefined));
    assertControlPlaneIsBounded(messages, result.output);
  });

  it('retains provider failure diagnostics after many small records', async function () {
    const messages = [];
    const agent = makeAgent(messages, 'text');
    const state = createLogFollowState();
    broadcastStressRecords({ agent, state });
    broadcastAgentLine({
      agent,
      providerName: 'codex',
      state,
      line: '[1777777777777]Error: provider exploded after prolonged output',
    });
    flushAgentOutput(agent, 'codex', state);
    const result = await buildCompletionResult({
      agent,
      taskId: 'stress-failure',
      providerName: 'codex',
      state,
      stdout: 'Status: failed',
      success: false,
      taskInfo: null,
    });
    assert.strictEqual(result.success, false);
    assert.match(result.output, /provider exploded after prolonged output/);
    assert.match(result.error, /provider exploded after prolonged output/);
    assertControlPlaneIsBounded(messages, result.output);
  });

  it('bounds isolated success and failure tails', function () {
    for (const terminal of ['isolated-terminal-success', 'Error: isolated provider exploded']) {
      const state = createIsolatedLogState();
      const published = [];
      const agent = {
        id: 'isolated-stress-worker',
        iteration: 1,
        cluster: { id: 'cluster-1' },
        messageBus: { publish: (message) => published.push(message) },
      };
      const payload = 'y'.repeat(2048);
      for (let index = 0; index < 5000; index++) {
        broadcastIsolatedLine({
          agent,
          providerName: 'codex',
          taskId: 'isolated-stress',
          state,
          line: JSON.stringify({ type: 'item.completed', index, payload }),
        });
      }
      broadcastIsolatedLine({
        agent,
        providerName: 'codex',
        taskId: 'isolated-stress',
        state,
        line: terminal,
      });
      flushIsolatedOutput(agent, 'codex', 'isolated-stress', state);
      assert.ok(Buffer.byteLength(state.fullOutput) <= CONTROL_PLANE_OUTPUT_LIMITS.maxBytes);
      assert.match(state.fullOutput, /Earlier provider output omitted/);
      assert.ok(state.fullOutput.includes(terminal));
      assert.ok(published.some((message) => message.content.data.line.includes(terminal)));
    }
  });
});

describe('bounded terminal output drain', function () {
  it('drains just-over-limit records exactly once', function () {
    const messages = [];
    const agent = makeAgent(messages, 'text');
    const state = createLogFollowState();
    broadcastStressRecords({ agent, state, count: 300 });
    assert.strictEqual(state.controlPlaneOutput.liveSuppressed, true);
    flushAgentOutput(agent, 'codex', state);
    flushAgentOutput(agent, 'codex', state);
    const indexes = messages
      .map((message) => {
        try {
          return JSON.parse(message.content.data.line).index;
        } catch {
          return null;
        }
      })
      .filter(Number.isInteger);
    assert.deepStrictEqual(
      indexes,
      Array.from({ length: 300 }, (_, index) => index)
    );
  });

  it('publishes a small record captured only during terminal drain', function () {
    const messages = [];
    const agent = makeAgent(messages, 'text');
    const state = createLogFollowState();
    appendControlPlaneRecord(state.controlPlaneOutput, {
      content: 'final record captured during terminal drain',
      timestamp: 1777777777777,
      type: 'text',
    });
    flushAgentOutput(agent, 'codex', state);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(
      messages[0].content.data.line,
      'final record captured during terminal drain'
    );
  });

  it('keeps 112 MiB of small-record output bounded in 128 MiB heaps', function () {
    const messages = [];
    const agent = makeAgent(messages, 'text');
    const state = createLogFollowState();
    const payload = 'm'.repeat(64 * 1024);
    const recordCount = 1792;
    for (let index = 0; index < recordCount; index++) {
      broadcastAgentLine({
        agent,
        providerName: 'codex',
        state,
        line: `[1777777777777]${index}:${payload}`,
      });
    }
    broadcastAgentLine({
      agent,
      providerName: 'codex',
      state,
      line: '[1777777777777]terminal-after-112-mib',
    });
    flushAgentOutput(agent, 'codex', state);
    assert.ok(recordCount * Buffer.byteLength(payload) >= 112 * 1024 * 1024);
    assert.match(state.output, /terminal-after-112-mib/);
    assertControlPlaneIsBounded(messages, state.output);
  });
});
