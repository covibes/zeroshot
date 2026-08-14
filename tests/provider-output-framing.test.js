const assert = require('node:assert');

const {
  broadcastAgentLine,
  broadcastIsolatedLine,
  createIsolatedLogState,
  createLogFollowState,
} = require('../src/agent/agent-task-executor');

const TIMESTAMP = 1_800_000_000_123;
const MARKER = `[${TIMESTAMP}][ZEROSHOT][LOG_FORMAT] channel-framed-v2`;
const COLLIDING_STDOUT =
  `[${TIMESTAMP}][ZEROSHOT][PROVIDER_STDOUT] ` +
  '[ZEROSHOT][PROVIDER_STDERR] genuine provider stdout';

it('unwraps host stdout framing while keeping the format marker out of the control plane', () => {
  const messages = [];
  const agent = {
    id: 'host-framing',
    role: 'implementation',
    iteration: 1,
    _publish: (message) => messages.push(message),
  };
  const state = createLogFollowState('host-framing-task');

  broadcastAgentLine({ agent, providerName: 'pi', state, line: MARKER });
  broadcastAgentLine({ agent, providerName: 'pi', state, line: COLLIDING_STDOUT });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(
    messages[0].content.data.line,
    '[ZEROSHOT][PROVIDER_STDERR] genuine provider stdout'
  );
});

it('unwraps isolated stdout framing without filtering reserved provider text', () => {
  const published = [];
  const agent = {
    id: 'isolated-framing',
    iteration: 1,
    cluster: { id: 'cluster-1' },
    messageBus: { publish: (message) => published.push(message) },
  };
  const state = createIsolatedLogState();

  broadcastIsolatedLine({
    agent,
    providerName: 'pi',
    taskId: 'isolated-framing-task',
    state,
    line: MARKER,
  });
  broadcastIsolatedLine({
    agent,
    providerName: 'pi',
    taskId: 'isolated-framing-task',
    state,
    line: COLLIDING_STDOUT,
  });

  assert.strictEqual(published.length, 1);
  assert.strictEqual(
    published[0].content.data.line,
    '[ZEROSHOT][PROVIDER_STDERR] genuine provider stdout'
  );
});
