const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_LIFETIME_REQUEST_IDS,
  MAX_NORMALIZED_OUTPUT_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_STDERR_TAIL_BYTES,
  fakeCommandSpec,
  runTask,
  withScenario,
} = require('../helpers/omp-rpc-driver-harness');

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
