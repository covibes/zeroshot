const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  OMP_SDK_TEXT_OUTPUT_SCHEMA,
  createOmpSdkProtocolCollector,
  decodeOmpSdkProtocolFrame,
  normalizeOmpSdkResultFrame,
  ompSdkOutputSchemaForRequest,
  parseOmpSdkProtocolFrame,
  parseOmpSdkSidecarRequest,
} = require('../../lib/agent-cli-provider');

function jsonRequest(overrides = {}) {
  return {
    protocolVersion: 1,
    runId: 'run-1',
    cwd: '/tmp/workspace',
    executionContext: 'host',
    prompt: 'Return the result.',
    modelSelector: 'amazon-bedrock/openai.gpt-5.6-sol',
    reasoningEffort: 'max',
    outputMode: 'json',
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
      additionalProperties: false,
    },
    modelsConfig: {},
    auth: {
      mode: 'environment',
      credentials: { 'amazon-bedrock': { env: 'AWS_BEARER_TOKEN_BEDROCK' } },
    },
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
    context: '',
    ...overrides,
  };
}

function textRequest(overrides = {}) {
  const request = jsonRequest({ outputMode: 'text', ...overrides });
  delete request.outputSchema;
  return request;
}

function resultFrame(request, value = { answer: 42 }) {
  return {
    protocolVersion: 1,
    type: 'result',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: '17.2.1' },
    runtime: { name: 'bun', version: '1.3.14' },
    requested: {
      modelSelector: request.modelSelector,
      reasoningEffort: request.reasoningEffort,
      outputMode: request.outputMode,
    },
    resolved: { modelSelector: request.modelSelector },
    strictOutput: {
      source: 'caller',
      mode: 'strict',
      status: 'valid',
      yield: { successful: true, incremental: false, count: 1 },
    },
    fallback: false,
    execution: { exitCode: 0, aborted: false },
    value,
    usage: {
      source: 'omp-aggregate',
      completeness: 'unknown',
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
      totalTokens: 26,
      requests: 2,
      durationMs: 123.5,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
  };
}

function errorFrame(request) {
  return {
    protocolVersion: 1,
    type: 'error',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: '17.2.1' },
    runtime: { name: 'bun', version: '1.3.14' },
    error: {
      code: 'provider-rate-limit',
      category: 'rate-limit',
      retryable: true,
      redacted: true,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('request validator snapshots and freezes the caller schema and rejects non-exact requests', () => {
  const input = jsonRequest();
  const parsed = parseOmpSdkSidecarRequest(input);
  assert.notEqual(parsed.outputSchema, input.outputSchema);
  assert.deepEqual(parsed.outputSchema, input.outputSchema);
  assert.equal(ompSdkOutputSchemaForRequest(parsed), parsed.outputSchema);
  assert.equal(Object.isFrozen(parsed.outputSchema), true);
  assert.equal(Object.isFrozen(parsed.outputSchema.properties.answer), true);
  input.outputSchema.properties.answer.type = 'string';
  assert.equal(parsed.outputSchema.properties.answer.type, 'number');

  assert.throws(
    () => parseOmpSdkSidecarRequest({ ...input, secret: 'must-not-be-accepted' }),
    /request\.secret is not allowed/
  );
  assert.throws(
    () => parseOmpSdkSidecarRequest({ ...input, modelSelector: 'bare-model' }),
    /full provider\/model selector/
  );
  assert.throws(() => parseOmpSdkSidecarRequest({ ...input, tools: [...input.tools, 'eval'] }), {
    message: 'request provider settings failed closed validation.',
  });
  assert.throws(() => parseOmpSdkSidecarRequest({ ...input, modelsConfig: { equivalence: {} } }), {
    message: 'request provider settings failed closed validation.',
  });
});

test('request schema rejects regex execution and oversized keyword values', () => {
  for (const outputSchema of [
    { type: 'string', pattern: '^(a+)+$' },
    { type: 'object', patternProperties: { '^(a+)+$': { type: 'string' } } },
  ]) {
    assert.throws(
      () => parseOmpSdkSidecarRequest(jsonRequest({ outputSchema })),
      /regular-expression schemas are not accepted/
    );
  }
  assert.throws(
    () =>
      parseOmpSdkSidecarRequest(
        jsonRequest({ outputSchema: { type: 'string', description: 'x'.repeat(16 * 1024 + 1) } })
      ),
    /exceeds 16384 bytes/
  );
  assert.throws(
    () =>
      parseOmpSdkSidecarRequest(
        jsonRequest({ outputSchema: { enum: Array.from({ length: 4097 }, (_, index) => index) } })
      ),
    /exceeds 4096 items/
  );
});

test('execution context is explicit and omp-home remains host-only', () => {
  const missing = jsonRequest();
  delete missing.executionContext;
  assert.throws(() => parseOmpSdkSidecarRequest(missing), /executionContext is required/);
  assert.throws(
    () => parseOmpSdkSidecarRequest(jsonRequest({ executionContext: 'remote' })),
    /executionContext must be/
  );
  for (const executionContext of ['detached', 'docker', 'benchmark']) {
    assert.throws(
      () =>
        parseOmpSdkSidecarRequest(
          jsonRequest({
            executionContext,
            auth: { mode: 'omp-home', path: '/tmp/private-omp-home' },
          })
        ),
      { message: 'request provider settings failed closed validation.' }
    );
  }
  assert.equal(
    parseOmpSdkSidecarRequest(
      jsonRequest({ auth: { mode: 'omp-home', path: '/tmp/private-omp-home' } })
    ).auth.mode,
    'omp-home'
  );
  assert.throws(
    () =>
      parseOmpSdkSidecarRequest(
        jsonRequest({
          auth: { mode: 'broker' },
          modelsConfig: {
            providers: {
              'amazon-bedrock': { baseUrl: 'https://untrusted-route.invalid' },
            },
          },
        })
      ),
    /cannot override the selected provider when broker auth is used/
  );
});

test('text requests mandate the host-owned schema and validate the unwrapped wire value', () => {
  const request = parseOmpSdkSidecarRequest(textRequest());
  assert.equal(ompSdkOutputSchemaForRequest(request), OMP_SDK_TEXT_OUTPUT_SCHEMA);
  const event = normalizeOmpSdkResultFrame(resultFrame(request, 'plain text'), request);
  assert.equal(event.result, 'plain text');

  assert.throws(
    () => parseOmpSdkSidecarRequest({ ...textRequest(), outputSchema: { type: 'string' } }),
    /outputSchema is forbidden in text mode/
  );
  assert.throws(
    () => normalizeOmpSdkResultFrame(resultFrame(request, { result: 'plain text' }), request),
    /invalid text result/
  );
  assert.throws(
    () => normalizeOmpSdkResultFrame(resultFrame(request, 42), request),
    /invalid text result/
  );
});

test('valid result normalizes exact SDK evidence and aggregate usage', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  const event = normalizeOmpSdkResultFrame(resultFrame(request), request);

  assert.deepEqual(event.result, { answer: 42 });
  assert.equal(event.success, true);
  assert.equal(event.inputTokens, 19);
  assert.equal(event.outputTokens, 7);
  assert.equal(event.cacheReadInputTokens, 5);
  assert.equal(event.cacheCreationInputTokens, 3);
  assert.equal(event.cost, 0.33);
  assert.equal(event.usageSource, 'omp-aggregate');
  assert.equal(event.usageCompleteness, 'unknown');
  assert.deepEqual(event.invocation, { lane: 'spawn', pty: false, protocol: 'omp-sdk-v1' });
  assert.equal(event.ompSdk.backend.version, '17.2.1');
  assert.equal(event.ompSdk.runtime.version, '1.3.14');
  assert.equal(event.ompSdk.strictOutput.yield.count, 1);
});

test('host revalidates caller schema and exact requested/resolved identity', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  assert.throws(
    () => normalizeOmpSdkResultFrame(resultFrame(request, { answer: 'not a number' }), request),
    /host schema validation/
  );

  const requestedMismatch = resultFrame(request);
  requestedMismatch.requested.reasoningEffort = 'high';
  assert.throws(
    () => normalizeOmpSdkResultFrame(requestedMismatch, request),
    /requested does not match/
  );

  const resolvedMismatch = resultFrame(request);
  resolvedMismatch.resolved.modelSelector = 'amazon-bedrock/another-model';
  assert.throws(
    () => normalizeOmpSdkResultFrame(resolvedMismatch, request),
    /resolved model is not exact/
  );
});

test('result validator fails closed on weak terminal evidence and fallback', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  const mutations = [
    (frame) => {
      frame.backend.version = '17.2.2';
    },
    (frame) => {
      frame.runtime.version = '1.3.15';
    },
    (frame) => {
      frame.strictOutput.source = 'session';
    },
    (frame) => {
      frame.strictOutput.mode = 'permissive';
    },
    (frame) => {
      frame.strictOutput.status = 'invalid';
    },
    (frame) => {
      frame.strictOutput.yield.incremental = true;
    },
    (frame) => {
      frame.strictOutput.yield.count = 2;
    },
    (frame) => {
      frame.fallback = true;
    },
    (frame) => {
      frame.execution.exitCode = 1;
    },
    (frame) => {
      frame.execution.aborted = true;
    },
  ];
  for (const mutate of mutations) {
    const frame = clone(resultFrame(request));
    mutate(frame);
    assert.throws(() => parseOmpSdkProtocolFrame(frame));
  }
});

test('usage and cost require finite nonnegative numbers and exact fields', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const badUsage = resultFrame(request);
    badUsage.usage.inputTokens = invalid;
    assert.throws(() => parseOmpSdkProtocolFrame(badUsage), /finite nonnegative/);

    const badCost = resultFrame(request);
    badCost.usage.cost.total = invalid;
    assert.throws(() => parseOmpSdkProtocolFrame(badCost), /finite nonnegative/);
  }
  const unknownUsage = resultFrame(request);
  unknownUsage.usage.providerComplete = true;
  assert.throws(() => parseOmpSdkProtocolFrame(unknownUsage), /providerComplete is not allowed/);
});

test('error frames are typed, category-consistent, and contain no free-form secret surface', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  assert.deepEqual(parseOmpSdkProtocolFrame(errorFrame(request)).error, {
    code: 'provider-rate-limit',
    category: 'rate-limit',
    retryable: true,
    redacted: true,
  });

  const withMessage = errorFrame(request);
  withMessage.error.message = 'token=super-secret';
  assert.throws(() => parseOmpSdkProtocolFrame(withMessage), /message is not allowed/);

  const wrongCategory = errorFrame(request);
  wrongCategory.error.category = 'provider';
  assert.throws(() => parseOmpSdkProtocolFrame(wrongCategory), /must be "rate-limit"/);
});

test('incremental collector accepts fragmented JSONL and normalizes one terminal result', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  const collector = createOmpSdkProtocolCollector({ request });
  const progress = JSON.stringify({
    protocolVersion: 1,
    type: 'progress',
    runId: request.runId,
    sequence: 0,
    stage: 'running',
  });
  const terminal = JSON.stringify(resultFrame(request));
  const stream = `${progress}\n${terminal}\n`;

  assert.deepEqual(collector.write(stream.slice(0, 13)), []);
  const decoded = collector.write(stream.slice(13));
  assert.equal(decoded.length, 2);
  const collected = collector.finish(0);
  assert.equal(collected.type, 'result');
  assert.equal(collected.event.inputTokens, 19);
  assert.equal(collector.progress.length, 1);
});

test('collector deterministically rejects malformed, unknown, duplicate, and post-terminal frames', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());

  const malformed = createOmpSdkProtocolCollector({ request });
  assert.throws(() => malformed.write('{not-json}\n'), /not valid JSON/);

  const unknown = createOmpSdkProtocolCollector({ request });
  assert.throws(
    () => unknown.write(`${JSON.stringify({ protocolVersion: 1, type: 'mystery' })}\n`),
    /type is unsupported/
  );

  const duplicate = createOmpSdkProtocolCollector({ request });
  const terminal = JSON.stringify(resultFrame(request));
  assert.throws(() => duplicate.write(`${terminal}\n${terminal}\n`), /data follows terminal frame/);

  const postTerminal = createOmpSdkProtocolCollector({ request });
  postTerminal.write(`${terminal}\n`);
  assert.throws(() => postTerminal.write('garbage\n'), /data follows terminal frame/);
});

test('collector enforces frame/stdout bounds, terminal presence, and exit status', () => {
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  const oversized = createOmpSdkProtocolCollector({ request, maxFrameBytes: 32 });
  assert.throws(() => oversized.write('x'.repeat(33)), /oversized/);

  const totalOversized = createOmpSdkProtocolCollector({ request, maxStdoutBytes: 16 });
  assert.throws(() => totalOversized.write('x'.repeat(17)), /stdout is oversized/);

  const missing = createOmpSdkProtocolCollector({ request });
  assert.throws(() => missing.finish(0), /missing terminal frame/);

  const resultExitMismatch = createOmpSdkProtocolCollector({ request });
  resultExitMismatch.write(`${JSON.stringify(resultFrame(request))}\n`);
  assert.throws(() => resultExitMismatch.finish(1), /result requires exit zero/);

  const errorExitMismatch = createOmpSdkProtocolCollector({ request });
  errorExitMismatch.write(`${JSON.stringify(errorFrame(request))}\n`);
  assert.throws(() => errorExitMismatch.finish(0), /error requires nonzero exit/);
});

test('frame decoder rejects malformed UTF-8 and exact-field violations', () => {
  assert.throws(() => decodeOmpSdkProtocolFrame(Buffer.from([0xff])), /not valid UTF-8/);
  const request = parseOmpSdkSidecarRequest(jsonRequest());
  const frame = resultFrame(request);
  frame.output = 'result.output must never be accepted';
  assert.throws(() => parseOmpSdkProtocolFrame(frame), /frame\.output is not allowed/);
});
