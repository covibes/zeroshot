const assert = require('node:assert');
const { isolatedAgent, isolatedTailManager } = require('./helpers/isolated-provider-lifecycle');
const { piUsage } = require('./helpers/pi-protocol');

const {
  buildCompletionResult,
  followClaudeTaskLogsIsolated,
} = require('../src/agent/agent-task-executor');
const {
  decorateError,
  extractProviderFailure,
  redactTerminalFailureForControlPlane,
  workerFailure,
} = require('../src/agent/provider-terminal-failure');

function assistantMessage(overrides = {}) {
  return {
    role: 'assistant',
    content: [],
    usage: piUsage(),
    stopReason: 'stop',
    ...overrides,
  };
}

describe('Pi provider retry lifecycle', function () {
  it('classifies Pi authentication failures only after settlement', function () {
    const message = assistantMessage({
      stopReason: 'error',
      errorMessage: 'No API key found for the selected model. Use /login to log in.',
    });
    const output = [
      { type: 'message_end', message },
      { type: 'turn_end', message, toolResults: [] },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    const failure = extractProviderFailure(output, 'pi');
    assert.strictEqual(failure.provider, 'pi');
    assert.strictEqual(failure.event, 'agent_settled');
    assert.strictEqual(failure.category, 'authentication');
    assert.strictEqual(failure.classification.retryable, false);
    assert.deepStrictEqual(workerFailure(decorateError(new Error(failure.error), failure)), {
      code: 'refusal',
      reason: 'authentication_required',
    });
  });

  it('does not terminalize an automatic Pi retry that later succeeds', function () {
    const state = {};
    const failedMessage = assistantMessage({
      usage: piUsage(2, 1),
      stopReason: 'error',
      errorMessage: 'temporary provider failure',
    });
    const successfulMessage = assistantMessage({ usage: piUsage(3, 2) });

    const pending = redactTerminalFailureForControlPlane(
      state,
      'pi',
      JSON.stringify({ type: 'message_end', message: failedMessage })
    );
    assert.strictEqual(state.providerFailure, undefined);
    assert.match(pending, /zeroshot_pending_failure/);

    redactTerminalFailureForControlPlane(
      state,
      'pi',
      JSON.stringify({ type: 'message_end', message: successfulMessage })
    );
    const settled = redactTerminalFailureForControlPlane(
      state,
      'pi',
      JSON.stringify({ type: 'agent_settled' })
    );
    assert.strictEqual(state.providerFailure, null);
    assert.doesNotMatch(settled, /zeroshot_failure/);
  });

  it('redacts every lifecycle record that can repeat a pending provider error', function () {
    const state = {};
    const secret = 'Authorization: Bearer pi-secret';
    const message = assistantMessage({
      content: [{ type: 'text', text: secret }],
      stopReason: 'error',
      errorMessage: secret,
    });
    const events = [
      { type: 'message_end', message },
      { type: 'turn_end', message, toolResults: [] },
      { type: 'agent_end', messages: [message], willRetry: false },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: secret },
      { type: 'auto_retry_end', success: false, finalError: secret },
    ];
    const redacted = events.map((event) =>
      redactTerminalFailureForControlPlane(state, 'pi', JSON.stringify(event))
    );

    assert.doesNotMatch(redacted.join('\n'), /pi-secret|Authorization/);
    assert.strictEqual(state.providerFailure, undefined);
  });
});

describe('Pi provider completion lifecycle', function () {
  it('publishes a final Pi failure only when the agent settles', function () {
    const state = {};
    const message = assistantMessage({
      stopReason: 'error',
      errorMessage: 'authentication required: run /login',
    });
    redactTerminalFailureForControlPlane(
      state,
      'pi',
      JSON.stringify({ type: 'message_end', message })
    );
    const settled = redactTerminalFailureForControlPlane(
      state,
      'pi',
      JSON.stringify({ type: 'agent_settled' })
    );

    assert.strictEqual(state.providerFailure.provider, 'pi');
    assert.match(settled, /zeroshot_failure/);
  });

  for (const [name, output] of [
    [
      'whose stream never settled',
      JSON.stringify({ type: 'message_end', message: assistantMessage() }),
    ],
    ['with no protocol output', ''],
  ]) {
    it(`rejects a completed host Pi task ${name}`, async function () {
      const result = await buildCompletionResult({
        agent: { id: 'pi-host', config: { outputFormat: 'text' } },
        taskId: 'pi-incomplete',
        providerName: 'pi',
        state: { output, skipStructuredResultCheck: true },
        stdout: 'Status: completed',
        success: true,
        taskInfo: null,
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /Provider pi failed/);
      assert.strictEqual(result.providerFailure.event, 'agent_settled');
    });
  }

  it('preserves a failed pre-agent startup diagnostic instead of inventing settlement failure', async function () {
    const result = await buildCompletionResult({
      agent: { id: 'pi-startup', config: { outputFormat: 'text' } },
      taskId: 'pi-startup',
      providerName: 'pi',
      state: { output: '', skipStructuredResultCheck: true },
      stdout: 'Status: failed\nError: Pi authentication required: run /login',
      success: false,
      taskInfo: null,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Pi authentication required: run /login');
    assert.strictEqual(result.providerFailure, null);
  });

  it('keeps watcher-owned Pi fatal metadata outside the JSON protocol', async function () {
    const timestamp = 1_777_777_777_777;
    const raw = [
      `[${timestamp}][ZEROSHOT][PROVIDER_STDERR] No API key found for the selected model.`,
      `[${timestamp}][ZEROSHOT][FATAL] Pi authentication required: run /login`,
    ].join('\n');
    const result = await followClaudeTaskLogsIsolated(
      isolatedAgent(
        'pi',
        isolatedTailManager(raw, 'failed\nError: Pi authentication required: run /login')
      ),
      'pi-startup-auth',
      { skipStructuredResultCheck: true }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.providerFailure, null);
    assert.strictEqual(result.error, 'Pi authentication required: run /login');
  });
});

describe('isolated Pi provider completion lifecycle', function () {
  this.timeout(20_000);

  it('accepts epoch timestamps, stderr provenance, and watcher footer metadata', async function () {
    const timestamp = 1_777_777_777_777;
    const assistant = assistantMessage({
      content: [{ type: 'text', text: 'done' }],
      usage: piUsage(4, 2),
    });
    const raw = [
      `[${timestamp}]${JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'work' } })}`,
      `[${timestamp}]${JSON.stringify({ type: 'message_end', message: assistant })}`,
      `[${timestamp}]${JSON.stringify({ type: 'agent_settled' })}`,
      `[${timestamp}][ZEROSHOT][PROVIDER_STDERR] extension initialized`,
      '',
      '==================================================',
      'Finished: 2026-08-11T00:00:00.000Z',
      'Exit code: 0, Signal: null',
      '',
    ].join('\n');
    const result = await followClaudeTaskLogsIsolated(
      isolatedAgent('pi', isolatedTailManager(raw, 'completed')),
      'pi-realistic-watcher',
      { skipStructuredResultCheck: true }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.tokenUsage.inputTokens, 4);
    assert.strictEqual(result.tokenUsage.outputTokens, 2);
    assert.doesNotMatch(result.output, /extension initialized|Finished:|Exit code:/);
  });

  for (const [name, raw] of [
    [
      'whose stream never settled',
      `${JSON.stringify({ type: 'message_end', message: assistantMessage() })}\n`,
    ],
    ['with no protocol output', ''],
  ]) {
    it(`rejects a completed isolated Pi task ${name}`, async function () {
      const result = await followClaudeTaskLogsIsolated(
        isolatedAgent('pi', isolatedTailManager(raw, 'completed')),
        'pi-incomplete',
        { skipStructuredResultCheck: true }
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.providerFailure.event, 'agent_settled');
    });
  }

  it('fails closed when terminal catch-up cannot inspect the complete Pi prefix', async function () {
    const chatter = `${JSON.stringify({ type: 'queue_update', action: 'progress' })}\n`.repeat(
      60_000
    );
    const raw =
      chatter +
      `${JSON.stringify({ type: 'message_end', message: assistantMessage() })}\n` +
      `${JSON.stringify({ type: 'agent_settled' })}\n`;
    const result = await followClaudeTaskLogsIsolated(
      isolatedAgent('pi', isolatedTailManager(raw, 'completed')),
      'pi-unobserved-prefix',
      { skipStructuredResultCheck: true }
    );

    assert.ok(Buffer.byteLength(raw) > 2 * 1024 * 1024);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.providerFailure.event, 'agent_settled');
  });

  it('does not mistake timestamped provider stdout for watcher metadata', async function () {
    const timestamp = 1_777_777_777_777;
    const raw = [
      `[${timestamp}]Finished: extension accidentally wrote to stdout`,
      `[${timestamp}]${JSON.stringify({ type: 'message_end', message: assistantMessage() })}`,
      `[${timestamp}]${JSON.stringify({ type: 'agent_settled' })}`,
    ].join('\n');
    const result = await followClaudeTaskLogsIsolated(
      isolatedAgent('pi', isolatedTailManager(raw, 'completed')),
      'pi-provider-metadata-shape',
      { skipStructuredResultCheck: true }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.providerFailure.event, 'agent_settled');
  });
});
