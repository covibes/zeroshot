const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  fakeCommandSpec,
  runOmpRpcTask,
  runTask,
  withScenario,
} = require('../helpers/omp-rpc-driver-harness');

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
