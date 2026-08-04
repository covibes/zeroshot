'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runOmpSdkProcess,
  spawnOmpSdkProcess,
} = require('../../lib/agent-cli-provider/omp-sdk-process-runner');
const { MODEL } = require('./omp-sdk-test-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BUN = path.join(ROOT, 'node_modules', 'bun', 'bin', 'bun.exe');
const CREDENTIAL = 'AWS_BEARER_TOKEN_BEDROCK';

function createFixture(t, name) {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-omp-sdk-${name}-`));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-omp-workspace-${name}-`));
  fs.chmodSync(privateRoot, 0o700);
  const requestPath = path.join(privateRoot, 'request.json');
  const sidecarPath = path.join(privateRoot, 'blocking-sidecar.cjs');
  const capturePath = path.join(cwd, 'pids.json');
  const request = {
    protocolVersion: 1,
    runId: `termination-${name}`,
    cwd,
    executionContext: 'host',
    prompt: 'wait until cancelled',
    modelSelector: MODEL,
    reasoningEffort: 'max',
    outputMode: 'json',
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    modelsConfig: { providers: {} },
    auth: {
      mode: 'environment',
      credentials: { 'amazon-bedrock': { env: CREDENTIAL } },
    },
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
    context: '',
  };
  fs.writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  fs.writeFileSync(
    sidecarPath,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      'const bytes = Buffer.alloc(65536); let offset = 0;',
      'for (;;) { const count = fs.readSync(3, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ sidecarPid: process.pid, childPid: child.pid }));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    { mode: 0o700 }
  );
  const previousCredential = process.env[CREDENTIAL];
  process.env[CREDENTIAL] = 'termination-secret';
  t.after(() => {
    if (previousCredential === undefined) delete process.env[CREDENTIAL];
    else process.env[CREDENTIAL] = previousCredential;
    fs.rmSync(privateRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return {
    capturePath,
    prepared: {
      adapter: { id: 'omp' },
      commandSpec: {
        binary: BUN,
        args: [sidecarPath, requestPath],
        env: {},
        cwd,
        cleanup: [privateRoot],
        cleanupMetadata: [
          {
            kind: 'temp-directory',
            provider: 'omp',
            path: privateRoot,
            reason: 'sdk-private-root',
          },
        ],
        warnings: [],
        redactions: [],
      },
      context: request.prompt,
      options: {},
      cliFeatures: {},
      configuration: { webSearch: { requested: false, effective: false } },
      invoke: {
        lane: 'spawn',
        parser: 'omp-sdk-ndjson',
        ptyEligible: false,
        strictTerminal: true,
      },
      environmentPolicy: { inherit: 'minimal', values: { PATH: process.env.PATH ?? '' } },
      credentialNames: [CREDENTIAL],
      privateArtifacts: { root: privateRoot, requestPath, owned: true },
      executionIdentity: {
        backend: 'omp-sdk',
        backendVersion: '17.2.1',
        runtime: { name: 'bun', version: '1.3.14' },
        transport: 'sdk',
      },
      semanticIdentity: {
        requestedModelSelector: MODEL,
        reasoningEffort: 'max',
        provider: 'amazon-bedrock',
      },
      containmentRequirement: { mode: 'host-process-tree', required: true },
    },
  };
}

async function waitForPids(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('sidecar PID evidence was not written');
}

function assertDead(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === 'ESRCH'
  );
}

function assertCancelled(result, timedOut) {
  assert.equal(result.timedOut, timedOut);
  assert.equal(result.terminal.type, 'error');
  assert.equal(result.terminal.frame.error.code, 'cancelled');
  assert.deepEqual(result.cleanupAttestation, {
    mode: 'host-process-tree',
    terminalBuffered: true,
    descendantsReaped: true,
    clean: true,
  });
}

test('timeout terminates the SDK sidecar and all descendants', async (t) => {
  const fixture = createFixture(t, 'timeout');
  const resultPromise = runOmpSdkProcess(fixture.prepared, {
    timeoutMs: 2_000,
    timeoutKillGraceMs: 25,
  });
  const pids = await waitForPids(fixture.capturePath);
  const result = await resultPromise;

  assertCancelled(result, true);
  assertDead(pids.sidecarPid);
  assertDead(pids.childPid);
});

test('AbortSignal terminates the SDK sidecar and all descendants', async (t) => {
  const fixture = createFixture(t, 'abort');
  const controller = new AbortController();
  const running = await spawnOmpSdkProcess(fixture.prepared, {
    signal: controller.signal,
    timeoutKillGraceMs: 25,
  });
  const pids = await waitForPids(fixture.capturePath);
  controller.abort();
  const result = await running.result;

  assertCancelled(result, false);
  assertDead(running.pid);
  assertDead(pids.sidecarPid);
  assertDead(pids.childPid);
});
