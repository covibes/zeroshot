const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  runOmpSdkProcess,
  spawnOmpSdkProcess,
} = require('../../lib/agent-cli-provider/omp-sdk-process-runner');
const {
  parseOmpSdkSupervisorAttestation,
} = require('../../lib/agent-cli-provider/omp-sdk-runtime');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const PINNED_BUN = path.join(REPOSITORY_ROOT, 'node_modules', 'bun', 'bin', 'bun.exe');

function request(cwd, runId) {
  return {
    protocolVersion: 1,
    runId,
    cwd,
    executionContext: 'host',
    prompt: 'private prompt that must not enter process metadata',
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
  };
}
function terminalFrame(input, failure) {
  if (failure) {
    return {
      protocolVersion: 1,
      type: 'error',
      runId: input.runId,
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
  return {
    protocolVersion: 1,
    type: 'result',
    runId: input.runId,
    backend: { id: 'omp-sdk', version: '17.2.1' },
    runtime: { name: 'bun', version: '1.3.14' },
    requested: {
      modelSelector: input.modelSelector,
      reasoningEffort: input.reasoningEffort,
      outputMode: input.outputMode,
    },
    resolved: { modelSelector: input.modelSelector },
    strictOutput: {
      source: 'caller',
      mode: 'strict',
      status: 'valid',
      yield: { successful: true, incremental: false, count: 1 },
    },
    fallback: false,
    execution: { exitCode: 0, aborted: false },
    value: { answer: 42 },
    usage: {
      source: 'omp-aggregate',
      completeness: 'unknown',
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
      totalTokens: 26,
      requests: 2,
      durationMs: 10,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
  };
}

function writePauseExecutable(filePath) {
  const machine = process.arch === 'x64' ? 62 : process.arch === 'arm64' ? 183 : undefined;
  const code =
    process.arch === 'x64'
      ? Buffer.from([0xb8, 0x22, 0, 0, 0, 0x0f, 0x05, 0xeb, 0xf7])
      : process.arch === 'arm64'
        ? Buffer.from([
            0xe0, 0x03, 0x1f, 0xaa, 0xe1, 0x03, 0x1f, 0xaa, 0xe2, 0x03, 0x1f, 0xaa, 0xe3, 0x03,
            0x1f, 0xaa, 0x28, 0x09, 0x80, 0xd2, 0x01, 0x00, 0x00, 0xd4, 0xfa, 0xff, 0xff, 0x17,
          ])
        : undefined;
  if (machine === undefined || code === undefined) throw new Error('unsupported test architecture');
  const image = Buffer.alloc(120 + code.length);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(image);
  image.writeUInt16LE(2, 16);
  image.writeUInt16LE(machine, 18);
  image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(0x400078n, 24);
  image.writeBigUInt64LE(64n, 32);
  image.writeUInt16LE(64, 52);
  image.writeUInt16LE(56, 54);
  image.writeUInt16LE(1, 56);
  image.writeUInt32LE(1, 64);
  image.writeUInt32LE(5, 68);
  image.writeBigUInt64LE(0x400000n, 80);
  image.writeBigUInt64LE(0x400000n, 88);
  image.writeBigUInt64LE(BigInt(image.length), 96);
  image.writeBigUInt64LE(BigInt(image.length), 104);
  image.writeBigUInt64LE(0x1000n, 112);
  code.copy(image, 120);
  fs.writeFileSync(filePath, image, { mode: 0o700 });
}

function fixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-sdk-runner-'));
  fs.chmodSync(root, 0o700);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-workspace-'));
  const requestPath = path.join(root, 'request.json');
  const sidecarPath = path.join(root, 'sidecar.cjs');
  const capturePath = path.join(cwd, 'capture.json');
  const escapeCapturePath = path.join(cwd, 'escape-daemon.pid');
  const readyPath = path.join(cwd, 'capture-ready.json');
  const capacityPath = path.join(cwd, 'capacity-pids.json');
  const debugPath = path.join(cwd, 'sidecar-error.txt');
  const pauseExecutablePath = path.join(root, 'pause');
  const readyTempPath = `${readyPath}.tmp`;
  const input = request(cwd, `runner-${mode}`);
  writePauseExecutable(pauseExecutablePath);
  fs.writeFileSync(requestPath, JSON.stringify(input), { mode: 0o600 });
  const frame = terminalFrame(input, mode === 'failure');
  const escapeCode = [
    "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
    "const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(escapeCapturePath)}, String(daemon.pid));`,
    'daemon.unref();',
  ].join('\n');
  const capacityForkCall =
    process.arch === 'x64'
      ? 'native.syscall(57, 0, 0, 0, 0, 0, 0);'
      : 'native.syscall(220, 17, 0, 0, 0, 0, 0);';
  const capacityWaitCall =
    process.arch === 'x64'
      ? 'native.syscall(34, 0, 0, 0, 0, 0, 0);'
      : 'native.syscall(73, 0, 0, 0, 0, 0, 0);';
  const capacityForkCode = [
    "const { dlopen } = require('bun:ffi');",
    "const libc = dlopen('libc.so.6', { syscall: { args: ['i64', 'i64', 'i64', 'i64', 'i64', 'i64', 'i64'], returns: 'i64' } });",
    'const native = libc.symbols;',
    `for (let index = 0; index < 5; index += 1) ${capacityForkCall}`,
    `for (;;) ${capacityWaitCall}`,
  ].join('\n');
  const capacityBinary = mode === 'capacity-overflow' ? pauseExecutablePath : PINNED_BUN;
  const capacityArguments = mode === 'capacity-overflow' ? [] : ['-e', capacityForkCode];
  fs.writeFileSync(
    sidecarPath,
    [
      "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
      `process.on('uncaughtException', (error) => { fs.writeFileSync(${JSON.stringify(debugPath)}, String(error && error.stack || error)); process.exit(91); });`,
      'const buffer = Buffer.alloc(65537); let offset = 0; for (;;) { const n = fs.readSync(3, buffer, offset, buffer.length-offset, null); if (!n) break; offset += n; }',
      "const document = JSON.parse(buffer.subarray(0, offset).toString('utf8')); buffer.fill(0);",
      "const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); const secret = document.values.AWS_BEARER_TOKEN_BEDROCK;",
      'process.stderr.write(`diagnostic ${secret} ${input.prompt}`);',
      "const launcherStat = fs.readFileSync(`/proc/${process.ppid}/stat`, 'utf8'); const statFields = launcherStat.slice(launcherStat.lastIndexOf(')') + 2).trim().split(/\\s+/);",
      "const supervisorPid = Number(statFields[1]); const supervisorProcessGroup = Number(fs.readFileSync(`/proc/${supervisorPid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${supervisorPid}/stat`, 'utf8').lastIndexOf(')') + 2).trim().split(/\\s+/)[2]);",
      "const supervisorThreadIds = fs.readdirSync(`/proc/${supervisorPid}/task`).map(Number); const nonleaderSupervisorTid = supervisorThreadIds.find((tid) => tid !== supervisorPid); if (!nonleaderSupervisorTid) throw new Error('supervisor nonleader TID unavailable');",
      "function signalBlocked(target) { try { process.kill(target, 0); return false; } catch (error) { return error && error.code === 'EPERM'; } }",
      'const supervisorSignalBlocked = signalBlocked(supervisorPid); const nonleaderSignalBlocked = signalBlocked(nonleaderSupervisorTid); const supervisorGroupSignalBlocked = signalBlocked(-supervisorProcessGroup); const allProcessesSignalBlocked = signalBlocked(-1);',
      "const { dlopen, ptr, toArrayBuffer } = require('bun:ffi'); const controlLibc = dlopen('libc.so.6', { syscall: { args: ['i64', 'i64', 'i64', 'i64', 'i64', 'i64', 'i64'], returns: 'i64' }, __errno_location: { args: [], returns: 'ptr' } });",
      "const control = controlLibc.symbols; const controlErrno = () => new Int32Array(toArrayBuffer(control.__errno_location(), 0, 4))[0]; const prlimitNumber = process.arch === 'x64' ? 302 : 261; const limits = new BigUint64Array([1n, 1n]);",
      'control.syscall(prlimitNumber, supervisorPid, 7, ptr(limits), 0, 0, 0); const prlimitBlocked = controlErrno() === 1;',
      'control.syscall(prlimitNumber, nonleaderSupervisorTid, 7, ptr(limits), 0, 0, 0); const nonleaderPrlimitBlocked = controlErrno() === 1;',
      "const schedulerNumbers = process.arch === 'x64' ? [141, 142, 144, 203, 251, 314] : [140, 118, 119, 122, 30, 274]; const schedulerControlsBlocked = schedulerNumbers.every((number) => { control.syscall(number, 0, 0, 0, 0, 0, 0); return controlErrno() === 1; });",
      "let x32Blocked = true; let x32SchedulerControlsBlocked = true; if (process.arch === 'x64') { control.syscall(0x40000000 | prlimitNumber, supervisorPid, 7, ptr(limits), 0, 0, 0); x32Blocked = controlErrno() === 1; x32SchedulerControlsBlocked = schedulerNumbers.every((number) => { control.syscall(0x40000000 | number, 0, 0, 0, 0, 0, 0); return controlErrno() === 1; }); }",
      `const capacityPids = []; for (let index = 0; index < ${mode === 'capacity' ? 131 : mode === 'capacity-overflow' ? 12 : 0}; index += 1) { if (index === 0) fs.writeFileSync(${JSON.stringify(capacityPath)}, ''); const child = spawn(${JSON.stringify(capacityBinary)}, ${JSON.stringify(capacityArguments)}, { stdio: 'ignore' }); child.unref(); capacityPids.push(child.pid); fs.appendFileSync(${JSON.stringify(capacityPath)}, String(child.pid) + '\\n'); } controlLibc.close();`,
      "const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); daemon.unref();",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref();",
      `const escapeParent = spawn(process.execPath, ['-e', ${JSON.stringify(escapeCode)}], { detached: true, stdio: 'ignore' }); escapeParent.unref();`,
      `const churnCount = ${mode === 'churn' ? 512 : 0}; for (let index = 0; index < churnCount; index += 1) { const transient = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); transient.unref(); }`,
      'function ready() {',
      `  if (!fs.existsSync(${JSON.stringify(escapeCapturePath)})) return setTimeout(ready, 2);`,
      `  const escapeDaemonPid = Number(fs.readFileSync(${JSON.stringify(escapeCapturePath)}, 'utf8'));`,
      `  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv, envKeys: Object.keys(process.env).sort(), secretInEnv: Object.values(process.env).includes(secret), credentialKeys: Object.keys(document.values), protocolVersion: document.protocolVersion, daemonPid: daemon.pid, childPid: child.pid, escapeDaemonPid, churnCount, supervisorSignalBlocked, nonleaderSignalBlocked, supervisorGroupSignalBlocked, allProcessesSignalBlocked, prlimitBlocked, nonleaderPrlimitBlocked, schedulerControlsBlocked, x32Blocked, x32SchedulerControlsBlocked, credentialMatched: secret === 'runner-secret' }));`,
      `  fs.writeFileSync(${JSON.stringify(readyTempPath)}, JSON.stringify({ phase: 'capture-ready' }));`,
      `  fs.renameSync(${JSON.stringify(readyTempPath)}, ${JSON.stringify(readyPath)});`,
      mode === 'cancel' || mode === 'capacity' || mode === 'capacity-overflow'
        ? '  setInterval(() => {}, 1000);'
        : `  setTimeout(() => { process.stdout.write(${JSON.stringify(JSON.stringify(frame) + '\n')}); process.exit(${mode === 'failure' ? 1 : 0}); }, 80);`,
      '}',
      mode === 'cancel' ? "process.on('SIGTERM', () => {});" : '',
      'ready();',
    ].join('\n'),
    { mode: 0o700 }
  );
  return {
    root,
    cwd,
    capturePath,
    debugPath,
    readyPath,
    capacityPath,
    prepared: {
      adapter: { id: 'omp' },
      commandSpec: {
        binary: PINNED_BUN,
        args: [sidecarPath, requestPath],
        env: {},
        cwd,
        cleanup: [root],
        cleanupMetadata: [
          { kind: 'temp-directory', provider: 'omp', path: root, reason: 'sdk-private-root' },
        ],
        warnings: [],
        redactions: [],
      },
      options: {},
      cliFeatures: {},
      configuration: { webSearch: { requested: false, effective: false } },
      invoke: {
        lane: 'spawn',
        parser: 'omp-sdk-ndjson',
        ptyEligible: false,
        strictTerminal: true,
      },
      environmentPolicy: { inherit: 'minimal', values: { PATH: process.env.PATH || '' } },
      credentialNames: ['AWS_BEARER_TOKEN_BEDROCK'],
      privateArtifacts: { root, requestPath, owned: true },
      executionIdentity: {
        backend: 'omp-sdk',
        backendVersion: '17.2.1',
        runtime: { name: 'bun', version: '1.3.14' },
        transport: 'sdk',
      },
      semanticIdentity: {
        requestedModelSelector: input.modelSelector,
        reasoningEffort: 'max',
        provider: 'amazon-bedrock',
      },
      containmentRequirement: { mode: 'host-process-tree', required: true },
    },
  };
}

function assertDead(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error && error.code === 'ESRCH'
  );
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${path.basename(filePath)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForPidLines(filePath, minimum, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(filePath)) {
      const pids = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(Number);
      if (pids.length >= minimum) return pids;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${minimum} live descendants`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function waitForDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === 'ESRCH') return;
      throw error;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for PID ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function spawnWithDeferredTimeout(prepared, options) {
  const nativeSetTimeout = global.setTimeout;
  let fireTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === options.timeoutMs && fireTimeout === undefined) {
      const dormantTimer = nativeSetTimeout(() => {}, 2_147_483_647);
      fireTimeout = () => callback(...args);
      return dormantTimer;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
  try {
    const handle = await spawnOmpSdkProcess(prepared, options);
    assert.equal(typeof fireTimeout, 'function');
    return { fireTimeout, handle };
  } finally {
    global.setTimeout = nativeSetTimeout;
  }
}

async function withSecret(run) {
  const previous = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'runner-secret';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = previous;
  }
}

async function withTestIdentityCap(cap, run) {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCap = process.env.ZEROSHOT_OMP_TEST_IDENTITY_CAP;
  process.env.NODE_ENV = 'test';
  process.env.ZEROSHOT_OMP_TEST_IDENTITY_CAP = String(cap);
  try {
    return await run();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousCap === undefined) delete process.env.ZEROSHOT_OMP_TEST_IDENTITY_CAP;
    else process.env.ZEROSHOT_OMP_TEST_IDENTITY_CAP = previousCap;
  }
}

for (const mode of ['success', 'failure']) {
  test(`OMP SDK spawn owner buffers ${mode} until process-tree cleanup`, async () => {
    const run = fixture(mode);
    try {
      const result = await withSecret(() => runOmpSdkProcess(run.prepared)).catch((error) => {
        if (fs.existsSync(run.debugPath))
          throw new Error(fs.readFileSync(run.debugPath, 'utf8'), { cause: error });
        throw error;
      });
      const capture = JSON.parse(fs.readFileSync(run.capturePath, 'utf8'));
      assert.equal(result.terminal.type, mode === 'success' ? 'result' : 'error');
      assert.deepEqual(result.cleanupAttestation, {
        mode: 'host-process-tree',
        terminalBuffered: true,
        descendantsReaped: true,
        clean: true,
      });
      assert.equal(result.diagnosticStderr.includes('runner-secret'), false);
      assert.equal(result.diagnosticStderr.includes('private prompt'), false);
      assert.equal(fs.existsSync(run.root), false);
      assert.equal(capture.secretInEnv, false);
      assert.equal(capture.credentialMatched, true);
      assert.equal(capture.protocolVersion, 1);
      assert.deepEqual(capture.credentialKeys, ['AWS_BEARER_TOKEN_BEDROCK']);
      assert.equal(capture.supervisorSignalBlocked, true);
      assert.equal(capture.nonleaderSignalBlocked, true);
      assert.equal(capture.supervisorGroupSignalBlocked, true);
      assert.equal(capture.allProcessesSignalBlocked, true);
      assert.equal(capture.prlimitBlocked, true);
      assert.equal(capture.nonleaderPrlimitBlocked, true);
      assert.equal(capture.schedulerControlsBlocked, true);
      assert.equal(capture.x32SchedulerControlsBlocked, true);
      assert.equal(capture.x32Blocked, true);
      assert.equal(JSON.stringify(capture.argv).includes('runner-secret'), false);
      assert.equal(JSON.stringify(capture.argv).includes('private prompt'), false);
      assert.deepEqual(
        capture.envKeys.sort(),
        [
          'HOME',
          'PATH',
          'PI_CODING_AGENT_DIR',
          'XDG_CACHE_HOME',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME',
        ].sort()
      );
      assertDead(capture.daemonPid);
      assertDead(capture.childPid);
      assertDead(capture.escapeDaemonPid);
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
      fs.rmSync(run.cwd, { recursive: true, force: true });
    }
  });
}

test('OMP SDK subreaper retires pidfds under high child churn before clean return', async () => {
  const run = fixture('churn');
  const sentinel = require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' }
  );
  try {
    const result = await withSecret(() => runOmpSdkProcess(run.prepared));
    const capture = JSON.parse(fs.readFileSync(run.capturePath, 'utf8'));
    assert.equal(result.terminal.type, 'result');
    assert.equal(result.cleanupAttestation.clean, true);
    assert.equal(capture.churnCount, 512);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    assert.equal(fs.existsSync(run.root), false);
    assertDead(capture.daemonPid);
    assertDead(capture.childPid);
    assertDead(capture.escapeDaemonPid);
  } finally {
    try {
      sentinel.kill('SIGKILL');
      await waitForDead(sentinel.pid);
    } catch {
      // A failed containment run must not leave the unrelated sentinel alive.
    }
    fs.rmSync(run.root, { recursive: true, force: true });
    fs.rmSync(run.cwd, { recursive: true, force: true });
  }
});

async function runCapacityScenario(mode, identityCap, minimumLaunchers, fanout) {
  const run = fixture(mode);
  const sentinel = require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' }
  );
  let handle;
  let resultError;
  let capacityPids = [];
  try {
    const spawnRun = () => withSecret(() => spawnOmpSdkProcess(run.prepared));
    handle =
      identityCap === undefined
        ? await spawnRun()
        : await withTestIdentityCap(identityCap, spawnRun);
    const settled = handle.result.then(
      () => undefined,
      (error) => error
    );
    capacityPids = await Promise.race([
      waitForPidLines(run.capacityPath, minimumLaunchers),
      settled.then(() => []),
    ]);
    resultError = await settled;
    assert.equal(
      resultError?.code,
      'cleanup-error',
      fs.existsSync(run.debugPath) ? fs.readFileSync(run.debugPath, 'utf8') : undefined
    );
    assert.ok((capacityPids.length + 1) * fanout + 1 > (identityCap ?? 4096));
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    assert.equal(fs.existsSync(run.root), false);
    for (const pid of capacityPids) assertDead(pid);
  } finally {
    handle?.cancel();
    if (handle !== undefined && resultError === undefined) {
      await handle.result.catch(() => {});
    }
    try {
      sentinel.kill('SIGKILL');
      await waitForDead(sentinel.pid);
    } catch {
      // A failed capacity run must not leave the unrelated sentinel alive.
    }
    fs.rmSync(run.root, { recursive: true, force: true });
    fs.rmSync(run.cwd, { recursive: true, force: true });
  }
}

test('OMP SDK supervisor drains identity-cap overflow in batches before cleanup error', async () => {
  await runCapacityScenario('capacity-overflow', 8, 7, 1);
});

test(
  'OMP SDK supervisor drains more than 4096 simultaneous live descendants',
  {
    skip: 'host live-process ceiling is reached before the 4096-identity supervisor cap',
  },
  async () => {
    await runCapacityScenario('capacity', undefined, 127, 32);
  }
);

test('OMP SDK cancellation wins and reaps daemonized descendants', async () => {
  const run = fixture('cancel');
  try {
    const handle = await withSecret(() => spawnOmpSdkProcess(run.prepared));
    while (!fs.existsSync(run.capturePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const capture = JSON.parse(fs.readFileSync(run.capturePath, 'utf8'));
    handle.cancel();
    const result = await handle.result;
    assert.equal(result.terminal.type, 'error');
    assert.equal(result.terminal.frame.error.code, 'cancelled');
    assert.equal(capture.supervisorSignalBlocked, true);
    assert.equal(capture.nonleaderSignalBlocked, true);
    assert.equal(capture.supervisorGroupSignalBlocked, true);
    assert.equal(capture.allProcessesSignalBlocked, true);
    assert.equal(capture.prlimitBlocked, true);
    assert.equal(capture.nonleaderPrlimitBlocked, true);
    assert.equal(capture.schedulerControlsBlocked, true);
    assert.equal(capture.x32SchedulerControlsBlocked, true);
    assert.equal(capture.x32Blocked, true);
    assert.equal(result.cleanupAttestation.clean, true);
    assert.equal(fs.existsSync(run.root), false);
    assertDead(capture.daemonPid);
    assertDead(capture.childPid);
    assertDead(capture.escapeDaemonPid);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
    fs.rmSync(run.cwd, { recursive: true, force: true });
  }
});
test('OMP SDK supervisor detects zombie-capable owner death by pidfd readiness', async () => {
  const run = fixture('cancel');
  const helperPath = path.join(run.cwd, 'owner.cjs');
  const preparedPath = path.join(run.cwd, 'prepared.json');
  fs.writeFileSync(preparedPath, JSON.stringify(run.prepared), { mode: 0o600 });
  fs.writeFileSync(
    helperPath,
    [
      `process.env.AWS_BEARER_TOKEN_BEDROCK = 'runner-secret';`,
      `const { runOmpSdkProcess } = require(${JSON.stringify(path.join(REPOSITORY_ROOT, 'lib', 'agent-cli-provider', 'omp-sdk-process-runner.js'))});`,
      `const prepared = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));`,
      `void runOmpSdkProcess(prepared);`,
    ].join('\n'),
    { mode: 0o700 }
  );
  const owner = require('node:child_process').spawn(process.execPath, [helperPath, preparedPath], {
    cwd: run.cwd,
    env: process.env,
    stdio: 'ignore',
  });
  try {
    await waitForFile(run.capturePath);
    const capture = JSON.parse(fs.readFileSync(run.capturePath, 'utf8'));
    const ownerClosed = new Promise((resolve) => owner.once('close', resolve));
    owner.kill('SIGKILL');
    await Promise.all([
      waitForDead(capture.daemonPid),
      waitForDead(capture.childPid),
      waitForDead(capture.escapeDaemonPid),
    ]);
    await ownerClosed;
  } finally {
    try {
      owner.kill('SIGKILL');
    } catch {
      // The owner normally exited at the test's deliberate parent-death boundary.
    }
    fs.rmSync(run.root, { recursive: true, force: true });
    fs.rmSync(run.cwd, { recursive: true, force: true });
  }
});

test('OMP SDK timeout after capture readiness is cancellation and attests cleanup before returning', async () => {
  const run = fixture('cancel');
  try {
    const { fireTimeout, handle } = await withSecret(() =>
      spawnWithDeferredTimeout(run.prepared, {
        timeoutMs: 30,
        timeoutKillGraceMs: 10,
      })
    );
    await waitForFile(run.readyPath);
    const readiness = JSON.parse(fs.readFileSync(run.readyPath, 'utf8'));
    const capture = JSON.parse(fs.readFileSync(run.capturePath, 'utf8'));
    assert.deepEqual(readiness, { phase: 'capture-ready' });
    fireTimeout();
    const result = await handle.result;
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutMs, 30);
    assert.equal(result.terminal.type, 'error');
    assert.equal(result.terminal.frame.error.code, 'cancelled');
    assert.deepEqual(result.cleanupAttestation, {
      mode: 'host-process-tree',
      terminalBuffered: true,
      descendantsReaped: true,
      clean: true,
    });
    assert.equal(result.diagnosticStderr.includes('runner-secret'), false);
    assert.equal(result.diagnosticStderr.includes('private prompt'), false);
    assert.equal(capture.secretInEnv, false);
    assert.equal(capture.credentialMatched, true);
    assert.deepEqual(capture.credentialKeys, ['AWS_BEARER_TOKEN_BEDROCK']);
    assert.equal(capture.protocolVersion, 1);
    assert.equal(JSON.stringify(capture.argv).includes('runner-secret'), false);
    assert.equal(JSON.stringify(capture.argv).includes('private prompt'), false);
    assert.deepEqual(
      capture.envKeys.sort(),
      [
        'HOME',
        'PATH',
        'PI_CODING_AGENT_DIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ].sort()
    );
    assert.equal(capture.supervisorSignalBlocked, true);
    assert.equal(capture.nonleaderSignalBlocked, true);
    assert.equal(capture.supervisorGroupSignalBlocked, true);
    assert.equal(capture.allProcessesSignalBlocked, true);
    assert.equal(capture.prlimitBlocked, true);
    assert.equal(capture.nonleaderPrlimitBlocked, true);
    assert.equal(capture.schedulerControlsBlocked, true);
    assert.equal(capture.x32SchedulerControlsBlocked, true);
    assert.equal(capture.x32Blocked, true);
    assert.equal(fs.existsSync(run.root), false);
    assertDead(capture.daemonPid);
    assertDead(capture.childPid);
    assertDead(capture.escapeDaemonPid);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
    fs.rmSync(run.cwd, { recursive: true, force: true });
  }
});

test('OMP SDK supervisor attestation rejects malformed and uncertain cleanup evidence', () => {
  assert.throws(
    () => parseOmpSdkSupervisorAttestation(Buffer.from('{malformed\n')),
    /attestation is malformed/
  );
  assert.throws(
    () =>
      parseOmpSdkSupervisorAttestation(
        Buffer.from(
          `${JSON.stringify({
            protocolVersion: 1,
            type: 'cleanup-attestation',
            status: 'clean',
            mode: 'linux-subreaper-pidfd',
            subreaper: true,
            pidfd: true,
            terminalBuffered: true,
            ownedProcessCount: 1,
            cancelled: false,
            semantic: { exitCode: 0, signal: null },
          })}\n`
        )
      ),
    /clean attestation is invalid/
  );
  assert.throws(
    () =>
      parseOmpSdkSupervisorAttestation(
        Buffer.from(
          `${JSON.stringify({
            protocolVersion: 1,
            type: 'cleanup-attestation',
            status: 'clean',
            mode: 'linux-subreaper-pidfd',
            subreaper: true,
            pidfd: true,
            terminalBuffered: true,
            ownedProcessCount: 0,
            cancelled: false,
            semantic: { exitCode: 0, signal: null },
          })}\n${JSON.stringify({ type: 'extra' })}\n`
        )
      ),
    /exactly one attestation frame/
  );
});

test('command cleanup accepts only canonical owner-only OMP SDK roots and is idempotent', async () => {
  const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-sdk-cleanup-'));
  fs.chmodSync(root, 0o700);
  const metadata = {
    kind: 'temp-directory',
    provider: 'omp',
    path: root,
    reason: 'sdk-private-root',
  };
  const failures = [];
  const cleanup = createCommandSpecCleanup(
    { cleanup: [root], cleanupMetadata: [metadata] },
    (cleanupPath, error) => failures.push({ cleanupPath, error })
  );
  assert.equal(await cleanup.run(), true);
  assert.equal(await cleanup.run(), true);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(failures, []);

  const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-sdk-cleanup-'));
  fs.chmodSync(unsafe, 0o755);
  const unsafeCleanup = createCommandSpecCleanup(
    {
      cleanup: [unsafe],
      cleanupMetadata: [{ ...metadata, path: unsafe }],
    },
    (cleanupPath, error) => failures.push({ cleanupPath, error })
  );
  assert.equal(await unsafeCleanup.run(), false);
  assert.equal(fs.existsSync(unsafe), true);
  fs.rmSync(unsafe, { recursive: true, force: true });
});
