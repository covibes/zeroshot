const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { runOmpRpcTask } = require('../../lib/agent-cli-provider/omp-rpc-driver');
const {
  MAX_PENDING_REQUESTS,
  MAX_LIFETIME_REQUEST_IDS,
  MAX_NORMALIZED_OUTPUT_BYTES,
  MAX_STDERR_TAIL_BYTES,
} = require('../../lib/agent-cli-provider/omp-rpc-bounds');

const FAKE_OMP_RPC_PATH = path.join(__dirname, '..', 'helpers', 'fake-omp-rpc.js');

function fakeCommandSpec(overrides = {}) {
  return {
    binary: process.execPath,
    args: [FAKE_OMP_RPC_PATH],
    env: {},
    cleanupMetadata: [],
    warnings: [],
    redactions: [],
    ...overrides,
  };
}

function withScenario(scenario, fn) {
  const previous = process.env.OMP_FAKE_RPC_SCENARIO;
  process.env.OMP_FAKE_RPC_SCENARIO = scenario;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.OMP_FAKE_RPC_SCENARIO;
      else process.env.OMP_FAKE_RPC_SCENARIO = previous;
    });
}

function runTask(overrides = {}) {
  const controller = new AbortController();
  const events = [];
  const sessions = [];
  const spawns = [];
  return runOmpRpcTask(
    {
      commandSpec: fakeCommandSpec(),
      prompt: 'do the thing',
      expectedVersion: '17.2.1',
      session: { kind: 'none' },
      signal: controller.signal,
      timeoutMs: 5000,
      abortGraceMs: 200,
      exitGraceMs: 200,
      ...overrides,
    },
    {
      onSpawn: (evidence) => {
        spawns.push(evidence);
        return Promise.resolve();
      },
      onEvent: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      onSession: (evidence) => {
        sessions.push(evidence);
        return Promise.resolve();
      },
    }
  ).then((result) => ({ result, events, sessions, spawns, controller }));
}

test('happy path: negotiate -> get_state -> prompt(agentInvoked:true) -> agent_end', async () => {
  await withScenario('happy', async () => {
    const { result, events, sessions, spawns } = await runTask();
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(spawns.length, 1);
    assert.ok(spawns[0].pid > 0);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].phase, 'ready');
    assert.equal(sessions[0].selectedProvider, 'anthropic');
    assert.equal(sessions[0].selectedModel, '@default');
    assert.equal(sessions[0].thinkingLevel, 'medium');
    assert.equal(result.session.phase, 'terminal');

    const textEvents = events.filter((event) => event.type === 'text');
    assert.deepEqual(
      textEvents.map((event) => event.text),
      ['hello ', 'world']
    );
    assert.equal(result.text, 'hello world');

    const toolCall = events.find((event) => event.type === 'tool_call');
    assert.ok(toolCall);
    assert.equal(toolCall.toolName, 'read');
    assert.equal(toolCall.toolId, 'tool-1');

    const toolResult = events.find((event) => event.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.content, 'contents');
    assert.equal(toolResult.isError, false);

    const resultEvent = [...events].reverse().find((event) => event.type === 'result');
    assert.ok(resultEvent);
    assert.equal(resultEvent.success, true);
    assert.equal(resultEvent.inputTokens, 10);
    assert.equal(resultEvent.outputTokens, 5);

    // Never leak raw frames/control payloads: no event should ever carry an OMP frame `type`.
    const rawFrameTypes = new Set([
      'ready',
      'available_commands_update',
      'agent_start',
      'agent_end',
      'turn_start',
      'turn_end',
      'message_start',
      'message_update',
      'message_end',
      'response',
    ]);
    for (const event of events) {
      assert.ok(!rawFrameTypes.has(event.type), `leaked raw frame type: ${event.type}`);
    }
  });
});

test('agentInvoked:false is a permanent local-only failure', async () => {
  await withScenario('local-only', async () => {
    const { result, events } = await runTask();
    assert.equal(result.stopReason, 'local-only-prompt');
    const resultEvent = events.find((event) => event.type === 'result');
    assert.equal(resultEvent.success, false);
    assert.match(resultEvent.error, /local-only-prompt/);
  });
});

test('ready frame without protocol v2 fails permanently as unsupported-protocol', async () => {
  await withScenario('no-v2', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'unsupported-protocol');
  });
});

test('ready frame advertising limits above the pinned cap fails as unsupported-limits', async () => {
  await withScenario('over-limits', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'unsupported-limits');
  });
});

test('rpc_chunk before negotiation succeeds fails as pre-negotiation-rpc-chunk', async () => {
  await withScenario('pre-negotiation-chunk', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'pre-negotiation-rpc-chunk');
  });
});

test('malformed frame after the prompt fails permanently with a decoder code', async () => {
  await withScenario('malformed-frame', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'malformed-physical-frame');
  });
});

test('extension_error frame fails permanently', async () => {
  await withScenario('extension-error', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'extension-error');
  });
});

test('early exit before any terminal frame fails as stream-ended-before-terminal', async () => {
  await withScenario('early-exit', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'stream-ended-before-terminal');
    assert.equal(result.exitCode, 0);
  });
});

test('process crash mid-turn surfaces the exit code and stderr tail', async () => {
  await withScenario('crash', async () => {
    const { result, events } = await runTask();
    assert.equal(result.exitCode, 1);
    const resultEvent = events.find((event) => event.type === 'result');
    assert.match(resultEvent.error, /fake omp crashed mid-turn/);
  });
});

test('cancellation via AbortSignal terminates the process and reports cancelled', async () => {
  await withScenario('ignore-abort', async () => {
    const controller = new AbortController();
    const runPromise = runTask({ signal: controller.signal, abortGraceMs: 100, exitGraceMs: 100 });
    setTimeout(() => controller.abort(), 50);
    const { result } = await runPromise;
    assert.equal(result.stopReason, 'cancelled');
  });
});

test('timeout elapsing terminates the process and reports timeout', async () => {
  await withScenario('ignore-abort', async () => {
    const { result } = await runTask({ timeoutMs: 100, abortGraceMs: 100, exitGraceMs: 100 });
    assert.equal(result.stopReason, 'timeout');
  });
});

const UI_METHOD_EXPECTATIONS = [
  ['confirm', { confirmed: false, cancelled: true }],
  ['select', { cancelled: true }],
  ['notify', { cancelled: false }],
];

for (const [method] of UI_METHOD_EXPECTATIONS) {
  test(`extension_ui_request method "${method}" resolves and the turn completes`, async () => {
    await withScenario(`extension-ui:${method}`, async () => {
      const { result } = await runTask();
      assert.equal(result.stopReason, 'completed');
    });
  });
}

test('extension_ui_request with an unsupported method fails permanently', async () => {
  await withScenario('extension-ui:frobnicate', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'unsupported-ui-method');
  });
});

test('host_tool_call is rejected with isError and the turn completes', async () => {
  await withScenario('host-tool', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'completed');
  });
});

test('host_uri_request is rejected with isError and the turn completes', async () => {
  await withScenario('host-uri', async () => {
    const { result } = await runTask();
    assert.equal(result.stopReason, 'completed');
  });
});

test('missing binary fails without hanging', async () => {
  const controller = new AbortController();
  await assert.rejects(
    runOmpRpcTask(
      {
        commandSpec: fakeCommandSpec({
          binary: '/nonexistent/omp-binary-does-not-exist',
          args: [],
        }),
        prompt: 'x',
        expectedVersion: '17.2.1',
        session: { kind: 'none' },
        signal: controller.signal,
        timeoutMs: 5000,
        abortGraceMs: 200,
        exitGraceMs: 200,
      },
      {
        onSpawn: async () => {},
        onEvent: async () => {},
        onSession: async () => {},
      }
    )
  );
});

test('pending-request bound: exactly MAX_PENDING_REQUESTS queued frames all dispatch', async () => {
  await withScenario('pending-flood', async () => {
    const { result } = await runTask({
      commandSpec: fakeCommandSpec({
        env: { OMP_FAKE_RPC_PENDING_COUNT: String(MAX_PENDING_REQUESTS) },
      }),
    });
    assert.equal(result.stopReason, 'completed');
  });
});

test('pending-request bound: one frame over MAX_PENDING_REQUESTS fails before dispatch', async () => {
  await withScenario('pending-flood', async () => {
    const { result } = await runTask({
      commandSpec: fakeCommandSpec({
        env: { OMP_FAKE_RPC_PENDING_COUNT: String(MAX_PENDING_REQUESTS + 1) },
      }),
    });
    assert.equal(result.stopReason, 'pending-request-exceeded');
  });
});

test('lifetime-request-id bound: exactly MAX_LIFETIME_REQUEST_IDS distinct ids all succeed', async () => {
  // The driver itself consumes 3 lifetime ids (zs-1, zs-state, zs-2) before any UI round trip.
  const uiRoundTrips = MAX_LIFETIME_REQUEST_IDS - 3;
  await withScenario('lifetime-id-flood', async () => {
    const { result } = await runTask({
      timeoutMs: 30000,
      commandSpec: fakeCommandSpec({
        env: { OMP_FAKE_RPC_LIFETIME_COUNT: String(uiRoundTrips) },
      }),
    });
    assert.equal(result.stopReason, 'completed');
  });
});

test('lifetime-request-id bound: one id over MAX_LIFETIME_REQUEST_IDS fails permanently', async () => {
  const uiRoundTrips = MAX_LIFETIME_REQUEST_IDS - 3 + 1;
  await withScenario('lifetime-id-flood', async () => {
    const { result } = await runTask({
      timeoutMs: 30000,
      commandSpec: fakeCommandSpec({
        env: { OMP_FAKE_RPC_LIFETIME_COUNT: String(uiRoundTrips) },
      }),
    });
    assert.equal(result.stopReason, 'lifetime-request-id-exceeded');
  });
});

// normalizeTurnEnd charges `{ result, error: errorMessage ?? stopReason ?? null }` on top of the
// accumulated text_delta bytes (see fake-omp-rpc.js's 'output-cap' branch, which resets the
// accumulated-text snapshot before turn_end so `result` lands on null, and sets stopReason
// 'stop' with no errorMessage). Computed the same way the driver computes it so the exact/
// over-cap byte totals below land precisely on the boundary.
const TURN_END_CHARGE_OVERHEAD = Buffer.byteLength(
  JSON.stringify({ result: null, error: 'stop' }),
  'utf8'
);

test('normalized-output bound: exactly MAX_NORMALIZED_OUTPUT_BYTES of output succeeds', async () => {
  await withScenario('output-cap', async () => {
    const { result } = await runTask({
      commandSpec: fakeCommandSpec({
        env: {
          OMP_FAKE_RPC_OUTPUT_BYTES: String(MAX_NORMALIZED_OUTPUT_BYTES - TURN_END_CHARGE_OVERHEAD),
        },
      }),
    });
    assert.equal(result.stopReason, 'completed');
  });
});

test('normalized-output bound: one byte over MAX_NORMALIZED_OUTPUT_BYTES fails permanently', async () => {
  await withScenario('output-cap', async () => {
    const { result } = await runTask({
      commandSpec: fakeCommandSpec({
        env: {
          OMP_FAKE_RPC_OUTPUT_BYTES: String(
            MAX_NORMALIZED_OUTPUT_BYTES - TURN_END_CHARGE_OVERHEAD + 1
          ),
        },
      }),
    });
    assert.equal(result.stopReason, 'output-bound-exceeded');
  });
});

test('stderr-tail bound: exactly MAX_STDERR_TAIL_BYTES of stderr survives in full', async () => {
  const kept = 'K'.repeat(MAX_STDERR_TAIL_BYTES);
  await withScenario('stderr-flood', async () => {
    const { result } = await runTask({
      commandSpec: fakeCommandSpec({
        env: {
          OMP_FAKE_RPC_STDERR_PREFIX_BYTES: '0',
          OMP_FAKE_RPC_STDERR_KEPT: kept,
        },
      }),
    });
    const resultEvent = result.events.find((event) => event.type === 'result');
    assert.ok(resultEvent.error.includes(kept), 'the full marker must survive the exact-cap tail');
  });
});

test('stderr-tail bound: bytes before the rolling MAX_STDERR_TAIL_BYTES window are dropped', async () => {
  const kept = 'K'.repeat(MAX_STDERR_TAIL_BYTES);
  await withScenario('stderr-flood', async () => {
    const { result } = await runTask({
      commandSpec: fakeCommandSpec({
        env: {
          OMP_FAKE_RPC_STDERR_PREFIX_BYTES: '100',
          OMP_FAKE_RPC_STDERR_KEPT: kept,
        },
      }),
    });
    const resultEvent = result.events.find((event) => event.type === 'result');
    assert.ok(resultEvent.error.includes(kept), 'the kept marker must survive in full');
    assert.ok(
      !resultEvent.error.includes('X'),
      'bytes older than the rolling window must be dropped'
    );
  });
});
