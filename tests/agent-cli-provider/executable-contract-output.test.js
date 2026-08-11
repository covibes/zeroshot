const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  assertNoSecret,
  runExecutable,
  runProviderExecutable,
} = require('./executable-contract-helpers.cjs');
const { piBasicSettledEvents, piUsage } = require('../helpers/pi-protocol');

function piFixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'pi', name), 'utf8');
}

function kiroFixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kiro', name), 'utf8');
}

function copilotFixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'copilot', name), 'utf8');
}

test('parse-output returns normalized events and parser diagnostics', () => {
  const stdout = [
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    }),
    '{bad json',
  ].join('\n');

  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'codex',
    stdout,
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.deepEqual(response.envelope.result.events, [{ type: 'text', text: 'hello' }]);
  assert.equal(response.envelope.result.diagnostics[0].kind, 'parse-error');
});

test('parse-output redacts uppercase secret-key fields from provider events', () => {
  const secret = 'UPPERCASESECRET123';
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'claude',
    stdout: JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'x',
            id: '1',
            input: {
              apiKey: secret,
              credential: {
                key: secret,
                present: true,
              },
            },
          },
        ],
      },
    }),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.events[0].type, 'tool_call');
  assert.match(response.envelope.result.events[0].input.apiKey, /^\[REDACTED:/);
  assert.match(response.envelope.result.events[0].input.credential.key, /^\[REDACTED:/);
  assertNoSecret(response.envelope, secret);
});

test('parse-output redacts metadata-shaped provider event key fields', () => {
  const secret = 'METADATASHAPEDSECRET123';
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'claude',
    stdout: JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'x',
            id: '1',
            input: {
              kind: 'env',
              key: secret,
            },
          },
        ],
      },
    }),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.events[0].type, 'tool_call');
  assert.match(response.envelope.result.events[0].input.key, /^\[REDACTED:/);
  assertNoSecret(response.envelope, secret);
});

test('classify-error returns machine-readable category and redacted evidence', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'classify-error',
    provider: 'codex',
    error: {
      message: 'invalid_api_key: token sk-secret is revoked',
      status: 401,
    },
    env: {
      OPENAI_API_KEY: 'sk-secret',
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.classification.retryable, false);
  assert.equal(response.envelope.result.category, 'auth');
  assertNoSecret(response.envelope, 'sk-secret');
});

test('classify-error treats Gemini unsupported-client auth failures as permanent', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'classify-error',
    provider: 'gemini',
    error: {
      message:
        'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. reasonCode: UNSUPPORTED_CLIENT',
      status: 1,
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.classification.retryable, false);
  assert.equal(response.envelope.result.classification.kind, 'permanent-pattern');
});

test('classify-error redacts secret-looking evidence without matching env value', () => {
  const secret = 'sk-live-123456';
  const response = runExecutable({
    schemaVersion: 1,
    command: 'classify-error',
    provider: 'codex',
    error: {
      message: `invalid_api_key token ${secret} leaked`,
      status: 401,
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.category, 'auth');
  assertNoSecret(response.envelope, secret);
});

test('classify-error uses status-only auth categories before adapter retryability', () => {
  for (const status of [401, 403]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'classify-error',
      provider: 'codex',
      error: {
        message: 'Request failed',
        status,
      },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.category, 'auth');
    assert.equal(response.envelope.result.evidence.status, status);
  }
});

test('classify-error uses status-only rate-limit category before adapter retryability', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'classify-error',
    provider: 'codex',
    error: {
      message: 'Request failed',
      status: 429,
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.category, 'rate-limit');
  assert.equal(response.envelope.result.evidence.status, 429);
});

test('classify-error uses nested response status categories and evidence', () => {
  for (const { responseStatus, expectedCategory } of [
    { responseStatus: { status: 401 }, expectedCategory: 'auth' },
    { responseStatus: { statusCode: 403 }, expectedCategory: 'auth' },
    { responseStatus: { status: 429 }, expectedCategory: 'rate-limit' },
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'classify-error',
      provider: 'codex',
      error: {
        message: 'Request failed',
        response: responseStatus,
      },
    });

    const status = responseStatus.status ?? responseStatus.statusCode;
    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.category, expectedCategory);
    assert.equal(response.envelope.result.evidence.status, status);
  }
});

test('classify-error recovers HTTP status from message-only gateway errors', () => {
  for (const [message, expected] of [
    [
      'Gateway request failed with status 404: No such model',
      { kind: 'status-permanent', category: 'permanent', status: 404, retryable: false },
    ],
    [
      'Gateway request failed with status 500: Upstream exploded',
      { kind: 'status-retryable', category: 'retryable', status: 500, retryable: true },
    ],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'classify-error',
      provider: 'gateway',
      error: { message },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.evidence.status, expected.status);
    assert.equal(response.envelope.result.evidence.status, expected.status);
    assert.equal(response.envelope.result.classification.kind, expected.kind);
    assert.equal(response.envelope.result.classification.retryable, expected.retryable);
    assert.equal(response.envelope.result.category, expected.category);
  }
});

test('parse-output reports parser-error diagnostics when provider parser throws', async () => {
  const adapters = require('../../lib/agent-cli-provider/adapters');
  const originalParseProviderChunk = adapters.parseProviderChunk;

  adapters.parseProviderChunk = () => {
    throw new Error('adapter parser crashed');
  };

  try {
    const response = await runProviderExecutable({
      schemaVersion: 1,
      command: 'parse-output',
      provider: 'codex',
      stdout: JSON.stringify({ type: 'turn.completed' }),
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.events.length, 0);
    assert.equal(response.envelope.result.diagnostics[0].kind, 'parser-error');
    assert.match(response.envelope.result.diagnostics[0].message, /adapter parser crashed/);
  } finally {
    adapters.parseProviderChunk = originalParseProviderChunk;
  }
});

test('parse-output normalizes Pi JSON fixtures without duplicate snapshot text', () => {
  const textResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: piFixture('text.jsonl'),
  });

  assert.equal(textResponse.exitCode, 0);
  assert.equal(textResponse.envelope.ok, true);
  assert.deepEqual(textResponse.envelope.result.events, [
    { type: 'text', text: 'Hello from Pi' },
    {
      type: 'result',
      success: true,
      result: 'Hello from Pi',
      error: null,
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 0,
      cost: 0,
      modelUsage: piUsage(7, 3, 1),
    },
  ]);

  const toolResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: piFixture('tool.jsonl'),
  });

  assert.equal(toolResponse.exitCode, 0);
  assert.equal(toolResponse.envelope.ok, true);
  assert.deepEqual(toolResponse.envelope.result.events, [
    { type: 'tool_call', toolName: 'bash', toolId: 'tool-1', input: { command: 'pwd' } },
    { type: 'tool_result', toolId: 'tool-1', content: 'line1', isError: false },
    { type: 'tool_result', toolId: 'tool-1', content: 'line1\n/tmp/pi', isError: false },
    { type: 'text', text: 'done' },
    {
      type: 'result',
      success: true,
      result: 'done',
      error: null,
      inputTokens: 11,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cost: 0,
      modelUsage: piUsage(11, 5),
    },
  ]);
});

test('parse-output handles Pi failure and empty fixtures', () => {
  for (const [name, expectedError] of [
    ['command-failure.jsonl', 'Unknown option --bogus'],
    ['auth-failure.jsonl', 'authentication required: run /login'],
    ['rate-limit.jsonl', 'rate limit exceeded; retry later'],
    ['cancelled.jsonl', 'cancelled by user'],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'parse-output',
      provider: 'pi',
      stdout: piFixture(name),
    });

    const lastEvent = response.envelope.result.events.at(-1);
    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(lastEvent.type, 'result');
    assert.equal(lastEvent.success, false);
    assert.equal(lastEvent.error, expectedError);
  }

  const emptyResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: piFixture('empty.jsonl'),
  });

  assert.equal(emptyResponse.exitCode, 0);
  assert.equal(emptyResponse.envelope.ok, true);
  const emptyResult = emptyResponse.envelope.result.events.at(-1);
  assert.equal(emptyResult.type, 'result');
  assert.equal(emptyResult.success, false);
  assert.match(emptyResult.error, /before agent_settled/i);
});

test('parse-output waits for Pi settlement and uses the final retried turn', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'temporary failure' }],
      usage: piUsage(1, 1),
      stopReason: 'error',
      errorMessage: 'service unavailable',
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      usage: piUsage(2, 1),
      stopReason: 'stop',
    },
  ];
  const stdout = [
    { type: 'message_end', message: messages[0] },
    { type: 'turn_end', message: messages[0], toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: true },
    { type: 'auto_retry_start', attempt: 1 },
    { type: 'message_end', message: messages[1] },
    { type: 'turn_end', message: messages[1], toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout,
  });

  const results = response.envelope.result.events.filter((event) => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
  assert.equal(results[0].result, 'recovered');
  assert.equal(results[0].inputTokens, 3);
  assert.equal(results[0].outputTokens, 2);
});

test('parse-output ignores Pi user and tool-result message_end records', () => {
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    usage: piUsage(2, 1),
    stopReason: 'stop',
  };
  const stdout = piBasicSettledEvents(assistant)
    .map((event) => JSON.stringify(event))
    .join('\n');
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout,
  });

  const result = response.envelope.result.events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.success, true);
  assert.equal(result.result, 'done');
});

test('parse-output includes Pi tool, compaction, and branch-summary usage', () => {
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    usage: piUsage(2, 1, 0, 0, { cost: { total: 0.01 } }),
    stopReason: 'stop',
  };
  const stdout = [
    {
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [],
        usage: piUsage(1, 0, 0, 0, { cost: { total: 0.02 } }),
      },
    },
    {
      type: 'compaction_end',
      result: { usage: piUsage(2, 1, 0, 0, { reasoning: 1, cost: { total: 0.03 } }) },
    },
    {
      type: 'entry_appended',
      entry: {
        type: 'branch_summary',
        usage: piUsage(1, 1, 0, 0, { cost: { total: 0.04 } }),
      },
    },
    { type: 'message_end', message: assistant },
    { type: 'agent_settled' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout,
  });

  const result = response.envelope.result.events.at(-1);
  assert.equal(result.success, true);
  assert.equal(result.inputTokens, 6);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.modelUsage.totalTokens, 9);
  assert.equal(result.modelUsage.reasoning, 1);
  assert.ok(Math.abs(result.cost - 0.1) < Number.EPSILON);
});

test('parse-output treats a settled deferred Pi turn as incomplete', () => {
  const message = {
    role: 'assistant',
    content: [],
    usage: piUsage(),
    stopReason: 'deferred',
    deferred: { provider: 'openai', modelId: 'batch', api: 'responses', id: 'deferred-1' },
  };
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: [
      JSON.stringify({ type: 'message_end', message }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n'),
  });

  const result = response.envelope.result.events.at(-1);
  assert.equal(result.success, false);
  assert.match(result.error, /deferred without completing/i);
});

test('parse-output fails when Pi settles without an assistant message', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: '{"type":"session","version":3,"id":"empty"}\n{"type":"agent_settled"}',
  });

  const result = response.envelope.result.events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.success, false);
  assert.match(result.error, /without an assistant message/i);
});

test('parse-output poisons malformed Pi stdout even after a valid assistant message', () => {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'looked successful' }],
    usage: piUsage(2, 1),
    stopReason: 'stop',
  };
  const stdout = [
    JSON.stringify({ type: 'message_end', message }),
    'THIS IS NOT JSON',
    JSON.stringify({ type: 'agent_settled' }),
  ].join('\n');
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout,
  });

  const result = response.envelope.result.events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.success, false);
  assert.match(result.error, /malformed JSON/i);
  assert.equal(result.inputTokens, 2);
  assert.equal(result.outputTokens, 1);
});

test('parse-output requires authoritative Pi message_end data before settlement', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: [
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'not authoritative' }] },
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n'),
  });

  const result = response.envelope.result.events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.success, false);
  assert.match(result.error, /without an assistant message_end/i);
});

test('parse-output rejects Pi events emitted after settlement', () => {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    usage: piUsage(1, 1),
    stopReason: 'stop',
  };
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'pi',
    stdout: [
      JSON.stringify({ type: 'message_end', message }),
      JSON.stringify({ type: 'agent_settled' }),
      JSON.stringify({ type: 'queue_update', action: 'unexpected' }),
    ].join('\n'),
  });

  const results = response.envelope.result.events.filter((event) => event.type === 'result');
  assert.equal(results.length, 2);
  assert.equal(results.at(-1).success, false);
  assert.match(results.at(-1).error, /after agent_settled/i);
  assert.equal(results.at(-1).inputTokens, 1);
  assert.equal(results.at(-1).outputTokens, 1);
});

test('parse-output normalizes Kiro ACP fixtures and diagnostics', () => {
  const textResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'kiro',
    stdout: kiroFixture('text.jsonl'),
  });

  assert.equal(textResponse.exitCode, 0);
  assert.equal(textResponse.envelope.ok, true);
  assert.deepEqual(textResponse.envelope.result.events, [
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' from Kiro' },
    {
      type: 'result',
      success: true,
      result: 'Hello from Kiro',
      error: null,
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 0,
      cost: null,
      modelUsage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
      },
    },
  ]);

  const toolResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'kiro',
    stdout: kiroFixture('tool.jsonl'),
  });

  assert.equal(toolResponse.exitCode, 0);
  assert.equal(toolResponse.envelope.ok, true);
  assert.deepEqual(toolResponse.envelope.result.events, [
    { type: 'tool_call', toolName: 'bash', toolId: 'tool-1', input: { command: 'pwd' } },
    { type: 'tool_result', toolId: 'tool-1', content: 'line1', isError: false },
    { type: 'tool_result', toolId: 'tool-1', content: 'line1\n/tmp/kiro', isError: false },
    { type: 'text', text: 'done' },
    {
      type: 'result',
      success: true,
      result: 'done',
      error: null,
      inputTokens: 9,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cost: null,
      modelUsage: {
        inputTokens: 9,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  ]);
});

test('parse-output handles Kiro ACP failures and diagnostics', () => {
  for (const [name, expectedError] of [
    ['auth-failure.jsonl', 'authentication required: run kiro auth login'],
    ['cancelled.jsonl', 'cancelled by user'],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'parse-output',
      provider: 'kiro',
      stdout: kiroFixture(name),
    });

    const lastEvent = response.envelope.result.events.at(-1);
    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(lastEvent.type, 'result');
    assert.equal(lastEvent.success, false);
    assert.equal(lastEvent.error, expectedError);
  }

  const malformedResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'kiro',
    stdout: kiroFixture('malformed.jsonl'),
  });

  assert.equal(malformedResponse.exitCode, 0);
  assert.equal(malformedResponse.envelope.ok, true);
  assert.deepEqual(malformedResponse.envelope.result.events, [{ type: 'text', text: 'ok' }]);
  assert.equal(malformedResponse.envelope.result.diagnostics[0].kind, 'parse-error');

  const emptyResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'kiro',
    stdout: kiroFixture('empty.jsonl'),
  });

  assert.equal(emptyResponse.exitCode, 0);
  assert.equal(emptyResponse.envelope.ok, true);
  assert.deepEqual(emptyResponse.envelope.result.events, []);
});

test('parse-output handles spec-compliant ACP content blocks and thought chunks', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'kiro',
    stdout: kiroFixture('thought.jsonl'),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.deepEqual(response.envelope.result.events, [
    { type: 'thinking', text: 'Need a plan' },
    { type: 'thinking', text: ' first' },
    { type: 'text', text: 'Done' },
    {
      type: 'result',
      success: true,
      result: 'Done',
      error: null,
      cost: null,
      modelUsage: null,
    },
  ]);
});

test('parse-output accumulates ACP delta chunks into the terminal result', () => {
  const stdout = [
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-delta-1',
          content: { type: 'text', text: 'Hello' },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-delta-1',
          content: { type: 'text', text: ' world' },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      result: {
        stopReason: 'end_turn',
      },
    }),
  ].join('\n');

  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'kiro',
    stdout,
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.deepEqual(response.envelope.result.events, [
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' world' },
    {
      type: 'result',
      success: true,
      result: 'Hello world',
      error: null,
      cost: null,
      modelUsage: null,
    },
  ]);
});

test('classify-error maps Pi auth, rate-limit, cancellation, and command failures', () => {
  for (const [message, expectedCategory, expectedRetryable] of [
    ['authentication required: run /login', 'auth', false],
    ['No API key found for the selected model.', 'auth', false],
    ['rate limit exceeded; retry later', 'rate-limit', true],
    ['cancelled by user', 'permanent', false],
    ['Model "missing-model" not found.', 'permanent', false],
    ['Unknown option --bogus', 'permanent', false],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'classify-error',
      provider: 'pi',
      error: { message },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.category, expectedCategory);
    assert.equal(response.envelope.result.classification.retryable, expectedRetryable);
  }
});

test('classify-error maps Kiro auth, retryable, cancellation, and malformed ACP failures', () => {
  for (const [message, expectedCategory, expectedRetryable] of [
    ['authentication required: run kiro auth login', 'auth', false],
    ['rate limit exceeded; retry later', 'rate-limit', true],
    ['cancelled by user', 'permanent', false],
    ['malformed ACP response', 'schema', false],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'classify-error',
      provider: 'kiro',
      error: { message },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.category, expectedCategory);
    assert.equal(response.envelope.result.classification.retryable, expectedRetryable);
  }
});

test('parse-output normalizes Copilot text and tool JSONL fixtures', () => {
  const textResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('text.jsonl'),
  });

  assert.equal(textResponse.exitCode, 0);
  assert.equal(textResponse.envelope.ok, true);
  assert.deepEqual(textResponse.envelope.result.events, [
    { type: 'text', text: 'pong' },
    {
      type: 'result',
      success: true,
      result: 'pong',
      error: null,
      inputTokens: 0,
      outputTokens: 21,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ]);

  const toolResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('tool.jsonl'),
  });

  assert.equal(toolResponse.exitCode, 0);
  assert.equal(toolResponse.envelope.ok, true);
  assert.deepEqual(toolResponse.envelope.result.events, [
    // `phase:"commentary"` narration is surfaced as thinking, not as the answer text.
    { type: 'thinking', text: 'Creating hello.txt now.' },
    {
      type: 'tool_call',
      toolName: 'apply_patch',
      toolId: 'call_1',
      input: '*** Begin Patch\n*** Add File: hello.txt\n+hi there\n*** End Patch\n',
    },
    {
      type: 'tool_result',
      toolId: 'call_1',
      content: 'Added 1 file(s): hello.txt',
      isError: false,
    },
    { type: 'text', text: 'Done. It printed: hi there' },
    {
      type: 'result',
      success: true,
      result: 'Done. It printed: hi there',
      error: null,
      inputTokens: 0,
      outputTokens: 223,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ]);
});

test('parse-output passes object-form Copilot tool arguments through unchanged', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('tool-object-args.jsonl'),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  const events = response.envelope.result.events;
  // Real copilot tool arguments are string-form for some tools (apply_patch) and object-form for
  // others (bash); the parser must forward both without reshaping.
  assert.deepEqual(
    events.find((event) => event.type === 'tool_call'),
    {
      type: 'tool_call',
      toolName: 'bash',
      toolId: 'call_9',
      input: { command: 'cat hello.txt' },
    }
  );
  assert.deepEqual(
    events.find((event) => event.type === 'tool_result'),
    {
      type: 'tool_result',
      toolId: 'call_9',
      content: 'hi there\n',
      isError: false,
    }
  );
});

test('parse-output ignores unknown Copilot event types (fail-open)', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('unknown-event.jsonl'),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.deepEqual(response.envelope.result.events, [
    { type: 'text', text: 'partial' },
    {
      type: 'result',
      success: true,
      result: 'partial',
      error: null,
      inputTokens: 0,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ]);
});

test('parse-output normalizes Copilot reasoning as a thinking event', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('reasoning.jsonl'),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.deepEqual(response.envelope.result.events, [
    { type: 'thinking', text: 'Let me think about this.' },
    { type: 'text', text: 'answer' },
    {
      type: 'result',
      success: true,
      result: 'answer',
      error: null,
      inputTokens: 0,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ]);
});

test('parse-output reports a non-zero Copilot exitCode as a failed result', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('failure.jsonl'),
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  // Success is derived from the terminal `result` event's top-level exitCode, NOT from any message
  // text — a non-zero exit must surface as a failed result so restart/resume logic can react.
  assert.deepEqual(response.envelope.result.events.at(-1), {
    type: 'result',
    success: false,
    result: null,
    error: 'Copilot exited with code 1',
    inputTokens: 0,
    outputTokens: 9,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });

  const emptyResponse = runExecutable({
    schemaVersion: 1,
    command: 'parse-output',
    provider: 'copilot',
    stdout: copilotFixture('empty.jsonl'),
  });

  assert.equal(emptyResponse.exitCode, 0);
  assert.equal(emptyResponse.envelope.ok, true);
  assert.deepEqual(emptyResponse.envelope.result.events, []);
});

test('classify-error maps Copilot auth, rate-limit, quota, and command failures', () => {
  for (const [message, expectedCategory, expectedRetryable] of [
    ['authentication failed: set GITHUB_TOKEN or run /login', 'auth', false],
    ['rate limit exceeded; retry later', 'rate-limit', true],
    ['insufficient quota', 'rate-limit', false],
    ['Unknown option --bogus', 'permanent', false],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'classify-error',
      provider: 'copilot',
      error: { message },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.category, expectedCategory);
    assert.equal(response.envelope.result.classification.retryable, expectedRetryable);
  }
});
