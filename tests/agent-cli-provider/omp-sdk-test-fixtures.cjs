'use strict';

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

const { resolveOmpSdkRuntime } = require('../../scripts/omp/runtime');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = path.join(ROOT, 'tests', 'helpers', 'fake-omp-sdk-provider.ts');
const TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'];
const SECRET = 'sdk-sidecar-secret-value-never-disclose';
const PROMPT = 'private prompt never placed in argv or diagnostics';
const MODEL = 'amazon-bedrock/openai.gpt-5.6-luna';
const CREDENTIAL = 'AWS_BEARER_TOKEN_BEDROCK';
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
    auth: {
      mode: 'environment',
      credentials: { 'amazon-bedrock': { env: CREDENTIAL } },
    },
    tools: TOOLS,
    context: '',
    ...overrides,
  };
}
function sdkSettings(overrides = {}) {
  const level = { model: MODEL, reasoningEffort: 'max' };
  return {
    defaultProvider: 'omp',
    providerSettings: {
      omp: {
        minLevel: 'level1',
        defaultLevel: 'level2',
        maxLevel: 'level3',
        levelOverrides: { level1: level, level2: level, level3: level },
        modelsConfig: { providers: {} },
        auth: {
          mode: 'environment',
          credentials: { 'amazon-bedrock': { env: CREDENTIAL } },
        },
        tools: TOOLS,
        nestedAgents: false,
        mcp: false,
        ...overrides,
      },
    },
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withSettings(settings, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), 'zeroshot-omp-settings-'));
  const settingsPath = path.join(directory, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const previousSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
  const previousCredential = process.env[CREDENTIAL];
  process.env.ZEROSHOT_SETTINGS_FILE = settingsPath;
  process.env[CREDENTIAL] = SECRET;
  const cleanup = () => {
    restoreEnv('ZEROSHOT_SETTINGS_FILE', previousSettingsFile);
    restoreEnv(CREDENTIAL, previousCredential);
    rmSync(directory, { recursive: true, force: true });
  };
  let result;
  try {
    result = callback();
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(cleanup);
  }
  cleanup();
  return result;
}

function removePreparedRoot(prepared) {
  if (prepared?.privateArtifacts?.root) {
    rmSync(prepared.privateArtifacts.root, { recursive: true, force: true });
  }
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

function credentialValues(requestValue) {
  const auth = requestValue?.auth;
  const provider = String(requestValue?.modelSelector ?? MODEL).split('/')[0];
  if (auth?.mode === 'environment') {
    return { [auth.credentials?.[provider]?.env]: SECRET };
  }
  if (auth?.mode === 'broker') {
    return { OMP_AUTH_BROKER_URL: 'https://broker.invalid', OMP_AUTH_BROKER_TOKEN: SECRET };
  }
  return {};
}

function runScenario(requestValue, scenario, credentialDocument) {
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
  writeFileSync(
    credentialPath,
    JSON.stringify(
      credentialDocument ?? { protocolVersion: 1, values: credentialValues(requestValue) }
    ),
    { mode: 0o600 }
  );
  const runtime = resolveOmpSdkRuntime();
  const args = [FAKE, requestPath, scenarioPath, observationPath];
  const environment = { ...process.env };
  delete environment[CREDENTIAL];
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
  const lines = spawned.stdout.trim() === '' ? [] : spawned.stdout.trim().split('\n');
  const frame = lines.length === 1 ? JSON.parse(lines[0]) : undefined;
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));
  rmSync(directory, { force: true, recursive: true });
  return { frame, lines, observation, spawned };
}

function assertSafeSingleInvocation(assert, run) {
  assert.equal(run.lines.length, 1);
  assert.equal(run.spawned.stderr, '');
  assert.equal(run.spawned.stdout.includes(PROMPT), false);
  assert.equal(run.spawned.stdout.includes(SECRET), false);
  assert.equal(run.observation.invocationCount, 1);
}

module.exports = {
  CREDENTIAL,
  JSON_SCHEMA,
  MODEL,
  PROMPT,
  SECRET,
  assertSafeSingleInvocation,
  removePreparedRoot,
  request,
  runScenario,
  sdkSettings,
  successfulResult,
  withSettings,
};
