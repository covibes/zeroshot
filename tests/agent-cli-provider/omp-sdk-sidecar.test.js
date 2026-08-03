'use strict';

const assert = require('node:assert/strict');
const {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { resolveOmpSdkRuntime } = require('../../scripts/omp-sdk-runtime');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = path.join(ROOT, 'tests', 'helpers', 'fake-omp-sdk-provider.ts');
const TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'];
const SECRET = 'sdk-sidecar-secret-value-never-disclose';
const PROMPT = 'private prompt never placed in argv or diagnostics';
const MODEL = 'fake-provider/fake-model';
const JSON_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function request(overrides = {}) {
  return {
    protocolVersion: 1,
    runId: 'sidecar-test-run',
    cwd: ROOT,
    executionContext: 'host',
    prompt: PROMPT,
    modelSelector: MODEL,
    reasoningEffort: 'max',
    outputMode: 'json',
    outputSchema: JSON_SCHEMA,
    modelsConfig: { providers: {} },
    auth: { mode: 'environment', credentials: { 'fake-provider': { env: 'FAKE_OMP_SECRET' } } },
    tools: TOOLS,
    context: '',
    ...overrides,
  };
}

function usage() {
  return {
    input: 10,
    output: 4,
    cacheRead: 6,
    cacheWrite: 1,
    totalTokens: 21,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
  };
}

function successfulResult(value, overrides = {}) {
  return {
    exitCode: 0,
    output: JSON.stringify({ answer: 'must never be used as evidence' }),
    stderr: '',
    durationMs: 125,
    requests: 2,
    resolvedModel: MODEL,
    resolvedModelIsFallback: false,
    structuredOutput: { source: 'caller', mode: 'strict', status: 'valid', data: value },
    extractedToolData: { yield: [{ status: 'success', data: value }] },
    usage: usage(),
    ...overrides,
  };
}

function runScenario(requestValue, scenario, envOverrides = {}, credentialDocument) {
  const directory = mkdtempSync(path.join(tmpdir(), 'zeroshot-fake-omp-'));
  const requestPath = path.join(directory, 'request.json');
  const scenarioPath = path.join(directory, 'scenario.json');
  const observationPath = path.join(directory, 'observation.json');
  const credentialPath = path.join(directory, 'credentials.json');
  writeFileSync(requestPath, JSON.stringify(requestValue), { mode: 0o600 });
  writeFileSync(
    scenarioPath,
    JSON.stringify({ expectedPrompt: PROMPT, expectedSecret: SECRET, ...scenario }),
    { mode: 0o600 }
  );
  const auth = requestValue?.auth;
  const provider = String(requestValue?.modelSelector ?? MODEL).split('/')[0];
  const values = {};
  if (auth?.mode === 'environment') {
    const envName = auth.credentials?.[provider]?.env;
    if (typeof envName === 'string') values[envName] = SECRET;
  } else if (auth?.mode === 'broker') {
    values.OMP_AUTH_BROKER_URL = 'https://broker.invalid';
    values.OMP_AUTH_BROKER_TOKEN = SECRET;
  }
  writeFileSync(
    credentialPath,
    JSON.stringify(credentialDocument ?? { protocolVersion: 1, values }),
    { mode: 0o600 }
  );
  const runtime = resolveOmpSdkRuntime();
  const args = [FAKE, requestPath, scenarioPath, observationPath];
  const environment = { ...process.env, ...envOverrides };
  delete environment.FAKE_OMP_SECRET;
  delete environment.OMP_AUTH_BROKER_URL;
  delete environment.OMP_AUTH_BROKER_TOKEN;
  const credentialFd = openSync(credentialPath, 'r');
  let spawned;
  try {
    spawned = spawnSync(runtime.bunExecutable, args, {
      cwd: ROOT,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', credentialFd],
      timeout: 30_000,
    });
  } finally {
    closeSync(credentialFd);
  }
  const stdout = spawned.stdout.trim();
  const lines = stdout.length === 0 ? [] : stdout.split('\n');
  const frame = lines.length === 1 ? JSON.parse(lines[0]) : undefined;
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));
  const invocation = { executable: runtime.bunExecutable, args };
  rmSync(directory, { force: true, recursive: true });
  return { frame, invocation, lines, observation, spawned };
}

function assertSafeInvocation(run) {
  assert.equal(run.lines.length, 1);
  assert.equal(run.spawned.stderr, '');
  assert.equal(JSON.stringify(run.invocation).includes(PROMPT), false);
  assert.equal(JSON.stringify(run.invocation).includes(SECRET), false);
  assert.equal(run.spawned.stdout.includes(PROMPT), false);
  assert.equal(run.spawned.stdout.includes(SECRET), false);
}

function assertOneCleanInvocation(run) {
  assert.equal(run.observation.invocationCount, 1);
  assert.equal(run.observation.authClosed, true);
  assert.equal(run.observation.credentialMatched, true);
  assert.equal(run.observation.credentialEnvironmentCleared, true);
  assert.equal(run.observation.environmentPrivate, true);
  assert.equal(run.observation.modelsFilePrivate, true);
  assert.equal(run.observation.optionsStrict, true);
  assert.equal(run.observation.privateStateRemoved, true);
  assert.equal(run.observation.promptMatched, true);
  assertSafeInvocation(run);
}

test('emits one strict JSON result from one terminal extracted yield', () => {
  const value = { answer: 'validated' };
  const run = runScenario(request(), { result: successfulResult(value) });
  assert.equal(run.spawned.status, 0);
  assert.equal(run.frame.type, 'result');
  assert.deepEqual(run.frame.value, value);
  assert.deepEqual(run.frame.backend, { id: 'omp-sdk', version: '17.2.1' });
  assert.deepEqual(run.frame.runtime, { name: 'bun', version: '1.3.14' });
  assert.deepEqual(run.frame.requested, {
    modelSelector: MODEL,
    reasoningEffort: 'max',
    outputMode: 'json',
  });
  assert.deepEqual(run.frame.resolved, { modelSelector: MODEL });
  assert.deepEqual(run.frame.strictOutput, {
    source: 'caller',
    mode: 'strict',
    status: 'valid',
    yield: { successful: true, incremental: false, count: 1 },
  });
  assert.equal(run.frame.fallback, false);
  assert.deepEqual(run.frame.execution, { exitCode: 0, aborted: false });
  assert.deepEqual(run.frame.usage, {
    source: 'omp-aggregate',
    completeness: 'unknown',
    inputTokens: 10,
    outputTokens: 4,
    cacheReadInputTokens: 6,
    cacheCreationInputTokens: 1,
    totalTokens: 21,
    requests: 2,
    durationMs: 125,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
  });
  assertOneCleanInvocation(run);
});

test('uses the strict host text envelope and unwraps only its result', () => {
  const envelope = { result: 'plain text result' };
  const run = runScenario(request({ outputMode: 'text', outputSchema: undefined }), {
    result: successfulResult(envelope),
  });
  assert.equal(run.spawned.status, 0);
  assert.equal(run.frame.type, 'result');
  assert.equal(run.frame.value, 'plain text result');
  assert.equal(run.frame.requested.outputMode, 'text');
  assertOneCleanInvocation(run);
});

test('rejects an exhausted same-session invalid yield without another invocation', () => {
  const value = { answer: 42 };
  const run = runScenario(request(), {
    result: successfulResult(value, {
      exitCode: 1,
      structuredOutput: { source: 'caller', mode: 'strict', status: 'invalid', data: value },
      extractedToolData: { yield: [{ status: 'success', data: value, schemaOverridden: true }] },
      error: 'schema_violation',
    }),
  });
  assert.equal(run.spawned.status, 1);
  assert.equal(run.frame.type, 'error');
  assert.equal(run.frame.error.code, 'schema-violation');
  assert.equal(run.observation.invocationCount, 1);
  assertSafeInvocation(run);
});

test('rejects missing yield even when raw output and structured fallback are valid', () => {
  const value = { answer: 'raw fallback must not count' };
  const run = runScenario(request(), {
    result: successfulResult(value, {
      output: JSON.stringify(value),
      extractedToolData: {},
    }),
  });
  assert.equal(run.frame.type, 'error');
  assert.equal(run.frame.error.code, 'schema-violation');
  assert.equal(run.observation.invocationCount, 1);
  assertSafeInvocation(run);
});

test('rejects duplicate terminal yields and yield/structured mismatches', () => {
  const value = { answer: 'one' };
  const duplicate = runScenario(request(), {
    result: successfulResult(value, {
      extractedToolData: {
        yield: [
          { status: 'success', data: value },
          { status: 'success', data: value, type: 'final' },
        ],
      },
    }),
  });
  assert.equal(duplicate.frame.error.code, 'schema-violation');
  assert.equal(duplicate.observation.invocationCount, 1);
  const mismatch = runScenario(request(), {
    result: successfulResult(value, {
      extractedToolData: { yield: [{ status: 'success', data: { answer: 'other' } }] },
    }),
  });
  assert.equal(mismatch.frame.error.code, 'schema-violation');
  assert.equal(mismatch.observation.invocationCount, 1);
});
test('rejects incremental, overridden, last-turn, aborted, and extra yield items', () => {
  const value = { answer: 'strict terminal' };
  const invalidYields = [
    [{ status: 'success', data: value, type: ['answer'] }],
    [{ status: 'success', data: value, schemaOverridden: true }],
    [{ status: 'success', data: value, useLastTurn: true }],
    [{ status: 'aborted', data: value }],
    [
      { status: 'success', data: value, type: ['answer'] },
      { status: 'success', data: value },
    ],
  ];
  for (const yieldItems of invalidYields) {
    const run = runScenario(request(), {
      result: successfulResult(value, { extractedToolData: { yield: yieldItems } }),
    });
    assert.equal(run.frame.type, 'error');
    assert.equal(run.frame.error.code, 'schema-violation');
    assert.equal(run.observation.invocationCount, 1);
  }
});

test('rejects exact resolved-model mismatch and OMP executor fallback', () => {
  const value = { answer: 'validated' };
  const mismatch = runScenario(request(), {
    result: successfulResult(value, { resolvedModel: 'fake-provider/other-model' }),
  });
  assert.equal(mismatch.frame.error.code, 'model-resolution');
  assert.equal(mismatch.observation.invocationCount, 1);
  const fallback = runScenario(request(), {
    result: successfulResult(value, { resolvedModelIsFallback: true }),
  });
  assert.equal(fallback.frame.error.code, 'model-fallback');
  assert.equal(fallback.observation.invocationCount, 1);
});

test('forwards cancellation through the sole runSubprocess AbortSignal and cleans up', () => {
  const run = runScenario(request(), {
    abortAfterMs: 1,
    result: successfulResult({ answer: 'not accepted after abort' }),
  });
  assert.equal(run.spawned.status, 1);
  assert.equal(run.frame.type, 'error');
  assert.equal(run.frame.error.code, 'cancelled');
  assertOneCleanInvocation(run);
});

test('classifies and redacts provider failures without prompt, secret, or free text', () => {
  const run = runScenario(request(), {
    result: successfulResult({ answer: 'unused' }),
    throwError: { status: 429, message: `rate limit ${SECRET} ${PROMPT}` },
  });
  assert.equal(run.spawned.status, 1);
  assert.deepEqual(run.frame.error, {
    code: 'provider-rate-limit',
    category: 'rate-limit',
    retryable: true,
    redacted: true,
  });
  assert.equal(run.observation.invocationCount, 1);
  assertSafeInvocation(run);
});

test('rejects missing aggregate usage rather than synthesizing zero evidence', () => {
  const run = runScenario(request(), {
    result: successfulResult({ answer: 'validated' }, { usage: undefined }),
  });
  assert.equal(run.frame.type, 'error');
  assert.equal(run.frame.error.code, 'sdk-error');
  assert.equal(run.observation.invocationCount, 1);
});
test('loads the private custom models file and rejects registry configuration errors', () => {
  const customRequest = request({
    modelsConfig: {
      providers: {
        'fake-provider': {
          baseUrl: 'http://127.0.0.1:4319/v1',
          api: 'openai-completions',
          models: [
            {
              id: 'fake-model',
              name: 'Fake model',
              reasoning: true,
              input: ['text'],
              supportsTools: true,
              contextWindow: 32768,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  });
  const success = runScenario(customRequest, {
    result: successfulResult({ answer: 'custom route active' }),
  });
  assert.equal(success.frame.type, 'result');
  assertOneCleanInvocation(success);

  const configError = runScenario(customRequest, {
    registryError: true,
    result: successfulResult({ answer: 'must not run' }),
  });
  assert.equal(configError.frame.type, 'error');
  assert.equal(configError.frame.error.code, 'invalid-request');
  assert.equal(configError.observation.invocationCount, 0);
  assert.equal(configError.observation.authClosed, true);
});

test('reads bounded credentials only from fd 3 and scrubs ambient OMP selectors', () => {
  const clean = runScenario(
    request(),
    { result: successfulResult({ answer: 'isolated' }) },
    {
      FAKE_OMP_SECRET: 'ambient-secret-must-not-win',
      OMP_PROFILE: 'ambient-profile',
      PI_CONFIG_FILES: '/tmp/ambient-config.yml',
      PI_CODING_AGENT_DIR: '/tmp/ambient-agent',
    }
  );
  assertOneCleanInvocation(clean);
  assert.equal(clean.spawned.stdout.includes('ambient-secret-must-not-win'), false);

  const missing = runScenario(
    request(),
    { result: successfulResult({ answer: 'must not run' }) },
    {},
    { protocolVersion: 1, values: {} }
  );
  assert.equal(missing.frame.error.code, 'provider-auth');
  assert.equal(missing.observation.invocationCount, 0);

  const extra = runScenario(
    request(),
    { result: successfulResult({ answer: 'must not run' }) },
    {},
    { protocolVersion: 1, values: { FAKE_OMP_SECRET: SECRET, EXTRA_SECRET: SECRET } }
  );
  assert.equal(extra.frame.error.code, 'provider-auth');
  assert.equal(extra.observation.invocationCount, 0);

  const oversized = runScenario(
    request(),
    { result: successfulResult({ answer: 'must not run' }) },
    {},
    { protocolVersion: 1, values: { FAKE_OMP_SECRET: 'x'.repeat(16 * 1024 + 1) } }
  );
  assert.equal(oversized.frame.error.code, 'invalid-request');
  assert.equal(oversized.observation.invocationCount, 0);
});

test('applies broker, keyless, and explicit host-only OMP-home auth policies', () => {
  const value = { answer: 'authenticated' };
  const result = successfulResult(value);
  const broker = runScenario(
    request({ auth: { mode: 'broker' } }),
    { result },
    {
      OMP_AUTH_BROKER_URL: 'https://broker.invalid',
      OMP_AUTH_BROKER_TOKEN: SECRET,
    }
  );
  assert.equal(broker.frame.type, 'result');
  assert.equal(broker.observation.invocationCount, 1);
  assert.equal(broker.observation.authClosed, true);
  assert.equal(broker.observation.brokerDiscoveryUsed, true);
  assert.equal(broker.observation.authDatabaseUsed, false);
  assert.equal(broker.observation.genericDiscoveryUsed, false);
  assert.equal(broker.observation.credentialEnvironmentCleared, true);
  assert.equal(broker.observation.environmentPrivate, true);
  assert.equal(broker.observation.privateStateRemoved, true);
  assertSafeInvocation(broker);

  const emptyBroker = runScenario(
    request({ auth: { mode: 'broker' } }),
    { result },
    {},
    {
      protocolVersion: 1,
      values: { OMP_AUTH_BROKER_URL: '', OMP_AUTH_BROKER_TOKEN: '' },
    }
  );
  assert.equal(emptyBroker.frame.error.code, 'invalid-request');
  assert.equal(emptyBroker.observation.invocationCount, 0);
  assert.equal(emptyBroker.observation.brokerDiscoveryUsed, false);
  assert.equal(emptyBroker.observation.genericDiscoveryUsed, false);
  assertSafeInvocation(emptyBroker);

  const keyless = runScenario(
    request({
      auth: { mode: 'none' },
      modelsConfig: { providers: { 'fake-provider': { auth: 'none' } } },
    }),
    { result }
  );
  assert.equal(keyless.frame.type, 'result');
  assert.equal(keyless.observation.invocationCount, 1);
  assert.equal(keyless.observation.authDatabaseUsed, true);
  assert.equal(keyless.observation.brokerDiscoveryUsed, false);
  assert.equal(keyless.observation.genericDiscoveryUsed, false);
  assert.equal(keyless.observation.authClosed, true);
  assertSafeInvocation(keyless);

  const explicitHome = mkdtempSync(path.join(tmpdir(), 'zeroshot-explicit-omp-home-'));
  const sourceDatabase = path.join(explicitHome, 'agent.db');
  const sourceDatabaseBytes = Buffer.from('explicit-home-auth-database');
  writeFileSync(sourceDatabase, sourceDatabaseBytes, { mode: 0o600 });
  writeFileSync(path.join(explicitHome, '.keep'), 'preserve', { mode: 0o600 });
  try {
    const local = runScenario(request({ auth: { mode: 'omp-home', path: explicitHome } }), {
      result,
    });
    assert.equal(local.frame.type, 'result');
    assert.equal(local.observation.invocationCount, 1);
    assert.equal(local.observation.authClosed, true);
    assert.equal(local.observation.authDatabaseUsed, true);
    assert.equal(local.observation.brokerDiscoveryUsed, false);
    assert.equal(local.observation.genericDiscoveryUsed, false);
    assert.equal(local.observation.privateStateRemoved, true);
    assertSafeInvocation(local);
    assert.doesNotThrow(() => readFileSync(path.join(explicitHome, '.keep')));
    assert.deepEqual(readFileSync(sourceDatabase), sourceDatabaseBytes);
  } finally {
    rmSync(explicitHome, { force: true, recursive: true });
  }
});
