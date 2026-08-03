'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { spawnSync: spawnLocalSync } = require('child_process');
const IsolationManager = require('../../src/isolation-manager');
const { assertNoOmpHomeMounts, resolveOmpDockerPolicy } = require('../../lib/docker-config');

const repoRoot = path.join(__dirname, '..', '..');

function fakeChild(onStdinWrite = () => {}, onStdinFlush = () => {}) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      onStdinWrite(Buffer.from(chunk));
      setImmediate(() => {
        onStdinFlush();
        callback();
      });
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.unref = () => {};
  return child;
}

function assertPythonSourceCompiles(source) {
  const result = spawnLocalSync(
    '/usr/bin/python3',
    ['-c', 'import sys; compile(sys.argv[1], "container-supervisor", "exec")', source],
    { encoding: 'utf8' }
  );
  assert.strictEqual(result.status, 0, result.stderr);
}

function privateRequest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-sdk-'));
  fs.chmodSync(root, 0o700);
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(requestPath, '{"request":"private"}\n', { mode: 0o600 });
  return { root, requestPath, owned: true };
}

function preparedSdkCommand(credentialNames, privateArtifacts) {
  return {
    invoke: {
      lane: 'spawn',
      parser: 'omp-sdk-ndjson',
      ptyEligible: false,
      strictTerminal: true,
    },
    environmentPolicy: { inherit: 'minimal', values: { LANG: 'C.UTF-8' } },
    credentialNames,
    privateArtifacts,
    executionIdentity: {
      backend: 'omp-sdk',
      backendVersion: '17.2.1',
      runtime: { name: 'bun', version: '1.3.14' },
      transport: 'sdk',
    },
    containmentRequirement: { mode: 'container', required: true },
    commandSpec: {
      binary: '/opt/zeroshot/node_modules/bun/bin/bun.exe',
      args: ['/opt/zeroshot/scripts/omp-sdk-sidecar.ts', privateArtifacts.requestPath],
    },
  };
}

describe('OMP SDK Docker isolation contract', function () {
  it('packages the pinned multi-architecture shrinkwrapped runtime without global OMP', function () {
    const dockerfile = fs.readFileSync(
      path.join(repoRoot, 'docker', 'zeroshot-cluster', 'Dockerfile'),
      'utf8'
    );
    assert.match(dockerfile, /ARG TARGETARCH/);
    assert.match(dockerfile, /amd64\) tool_arch=amd64; aws_arch=x86_64/);
    assert.match(dockerfile, /arm64\) tool_arch=arm64; aws_arch=aarch64/);
    assert.match(dockerfile, /BUN_RUNTIME_VERSION=1\.3\.14/);
    assert.match(dockerfile, /OMP_SDK_VERSION=17\.2\.1/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.match(dockerfile, /cmp package-lock\.json npm-shrinkwrap\.json/);
    assert.match(dockerfile, /node_modules\/bun\/bin\/bun\.exe/);
    assert.match(dockerfile, /resolveOmpSdkRuntime\(\{packageRoot:'\/opt\/zeroshot'\}\)/);
    assert.match(dockerfile, /ompNativePlatformPackage/);
    assert.match(dockerfile, /shrinkwrap:'\/opt\/zeroshot\/npm-shrinkwrap\.json'/);
    assert.match(dockerfile, /scripts\/omp-sdk-sidecar\.ts/);
    assert.match(dockerfile, /test ! -e \/usr\/local\/bin\/omp/);
    assert.doesNotMatch(dockerfile, /npm install -g[^\n]*pi-coding-agent/);
    assert.doesNotMatch(dockerfile, /COPY[^\n]*\.omp/);
  });

  it('selects the bundled base image for SDK and the pinned CLI variant only for RPC', function () {
    const sdkPlan = IsolationManager.imagePlanForProvider('omp', {
      baseImage: 'zeroshot-cluster-base:test',
      providerSettings: { omp: { auth: { mode: 'none' } } },
    });
    assert.strictEqual(sdkPlan.image, 'zeroshot-cluster-base:test');
    assert.deepStrictEqual(sdkPlan.buildArgs, []);
    assert.strictEqual(sdkPlan.platform, null);
    assert.strictEqual(sdkPlan.ompDockerPolicy.transport, 'sdk');

    const rpcPlan = IsolationManager.imagePlanForProvider('omp', {
      baseImage: 'zeroshot-cluster-base:test',
      providerSettings: { omp: { transport: 'rpc' } },
    });
    assert.notStrictEqual(rpcPlan.image, sdkPlan.image);
    assert.match(rpcPlan.image, /^zeroshot-cluster-base-omp-[a-f0-9]{12}$/);
    assert.strictEqual(rpcPlan.platform, 'linux/amd64');
    assert.strictEqual(rpcPlan.ompDockerPolicy.transport, 'rpc');
    assert.strictEqual(
      rpcPlan.buildArgs.filter((arg) => arg.startsWith('PROVIDER_INSTALL=')).length,
      1
    );
    assert(!sdkPlan.buildArgs.some((arg) => arg.includes('omp')));
  });

  it('excludes dependency, secret, and OMP state from the image context', function () {
    const entries = fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8').split(/\r?\n/);
    for (const excluded of ['node_modules', '.env', '.omp', '**/.omp', '.claude']) {
      assert(entries.includes(excluded), `missing ${excluded}`);
    }
  });

  it('derives names only for environment, broker, and keyless SDK auth', function () {
    assert.deepStrictEqual(
      resolveOmpDockerPolicy('omp', {
        transport: 'sdk',
        auth: {
          mode: 'environment',
          credentials: { 'amazon-bedrock': { env: 'AWS_BEARER_TOKEN_BEDROCK' } },
        },
      }).credentialNames,
      ['AWS_BEARER_TOKEN_BEDROCK']
    );
    assert.deepStrictEqual(
      resolveOmpDockerPolicy('omp', { transport: 'sdk', auth: { mode: 'broker' } }).credentialNames,
      ['OMP_AUTH_BROKER_TOKEN', 'OMP_AUTH_BROKER_URL']
    );
    assert.deepStrictEqual(
      resolveOmpDockerPolicy('omp', { transport: 'sdk', auth: { mode: 'none' } }).credentialNames,
      []
    );
  });

  it('applies host OMP mount rejection only to SDK containers', function () {
    assert.throws(
      () =>
        resolveOmpDockerPolicy('omp', {
          transport: 'sdk',
          auth: { mode: 'omp-home', path: '/home/user/.omp' },
        }),
      /local host-only/
    );
    assert.deepStrictEqual(resolveOmpDockerPolicy('omp', { transport: 'rpc' }), {
      sdk: false,
      transport: 'rpc',
      authMode: null,
      credentialNames: [],
    });
    assert.throws(() => assertNoOmpHomeMounts(['omp'], '/home/node'), /cannot mount/);
    assert.throws(
      () =>
        assertNoOmpHomeMounts(
          [{ host: '/home/user/.omp', container: '/home/node/.omp', readonly: true }],
          '/home/node'
        ),
      /cannot mount/
    );
  });

  it('keeps SDK hardening separate from the current-main RPC Docker path', function () {
    const manager = new IsolationManager();
    const sdkPolicy = resolveOmpDockerPolicy('omp', {
      transport: 'sdk',
      auth: {
        mode: 'environment',
        credentials: { 'amazon-bedrock': { env: 'AWS_BEARER_TOKEN_BEDROCK' } },
      },
    });
    const rpcPolicy = resolveOmpDockerPolicy('omp', { transport: 'rpc' });
    const sdkArgs = manager._buildBaseDockerArgs({
      containerName: 'sdk',
      workDir: '/workspace-host',
      containerHome: '/home/node',
      clusterConfigDir: null,
      sdkMode: sdkPolicy.sdk,
      credentialNames: sdkPolicy.credentialNames,
    });
    const rpcArgs = manager._buildBaseDockerArgs({
      containerName: 'rpc',
      workDir: '/workspace-host',
      containerHome: '/home/node',
      clusterConfigDir: null,
      sdkMode: rpcPolicy.sdk,
      credentialNames: rpcPolicy.credentialNames,
    });
    for (const boundary of ['--init', '--read-only', '--pids-limit', 'no-new-privileges=true']) {
      assert(sdkArgs.includes(boundary), `missing SDK boundary ${boundary}`);
      assert(!rpcArgs.includes(boundary), `RPC unexpectedly received SDK boundary ${boundary}`);
    }
    for (const capability of ['KILL', 'SETGID', 'SETUID']) {
      assert(sdkArgs.includes(capability), `missing supervisor capability ${capability}`);
      assert(
        !rpcArgs.includes(capability),
        `RPC unexpectedly received SDK capability ${capability}`
      );
    }
    assert(!sdkArgs.some((arg) => arg.includes('docker.sock')));
    assert(!sdkArgs.some((arg) => arg.includes('.claude')));
    assert(rpcArgs.some((arg) => arg.includes('docker.sock')));
    assert(rpcArgs.includes('--group-add'));
    assert(sdkArgs.includes('io.zeroshot.execution.transport=sdk'));
    assert(sdkArgs.includes('io.zeroshot.credentials.names=AWS_BEARER_TOKEN_BEDROCK'));
    assert(!sdkArgs.some((arg) => arg.includes('AWS_BEARER_TOKEN_BEDROCK=')));
    assert(!rpcArgs.some((arg) => arg.startsWith('io.zeroshot.')));
  });

  it('materializes the request and streams declared values without Docker metadata leakage', async function () {
    const spawned = [];
    const copied = [];
    const handoffOrder = [];
    let sidecarFd3Flushed = false;
    const sidecarFd3Chunks = [];
    const manager = new IsolationManager({
      spawn(binary, args, options) {
        handoffOrder.push('sidecar-launch');
        const child = fakeChild(
          (chunk) => {
            handoffOrder.push('sidecar-fd-3');
            sidecarFd3Chunks.push(chunk);
          },
          () => {
            sidecarFd3Flushed = true;
          }
        );
        spawned.push({ binary, args, options, child });
        return child;
      },
      spawnSync(binary, args, options) {
        copied.push({ binary, args, input: Buffer.from(options.input || '') });
        if (options.input) handoffOrder.push('request-materialized');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const containerId = '0123456789ab';
    manager.containers.set('cluster', containerId);
    const artifacts = privateRequest();
    const oldSecret = process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'super-private-test-value';

    try {
      const proc = manager.spawnPreparedInContainer(
        containerId,
        preparedSdkCommand(['AWS_BEARER_TOKEN_BEDROCK'], artifacts)
      );
      assert(proc.credentialHandoff instanceof Promise);
      assert.strictEqual(sidecarFd3Flushed, false);
      await proc.credentialHandoff;
      assert.strictEqual(sidecarFd3Flushed, true);

      const requestCopies = copied.filter(({ input }) => input.length > 0);
      assert.strictEqual(requestCopies.length, 1);
      assert.strictEqual(requestCopies[0].input.toString('utf8'), '{"request":"private"}\n');
      assert.deepStrictEqual(handoffOrder, [
        'request-materialized',
        'sidecar-launch',
        'sidecar-fd-3',
      ]);
      const dockerMetadata = JSON.stringify({
        spawned: spawned.map(({ binary, args, options }) => ({ binary, args, options })),
        materialized: copied.map(({ binary, args }) => ({ binary, args })),
      });
      assert(!dockerMetadata.includes('super-private-test-value'));
      assert(!dockerMetadata.includes('AWS_BEARER_TOKEN_BEDROCK='));
      const supervisorArgs = spawned[0].args;
      const supervisorSource = supervisorArgs[supervisorArgs.indexOf('-c') + 1];
      assert(supervisorArgs.includes('--user'));
      assert(supervisorArgs.includes('0:0'));
      assert.match(supervisorSource, /PR_SET_CHILD_SUBREAPER/);
      assert.match(supervisorSource, /start_new_session=True/);
      assert.match(supervisorSource, /owned_descendants\(\)/);
      assert.match(supervisorSource, /os\.waitpid\(-1, os\.WNOHANG\)/);
      assert.match(supervisorSource, /stop_descendants\(\)\n {4}write_state\("clean/);
      assert.doesNotMatch(JSON.stringify({ spawned, copied }), /container-process\.pid/);
      assert.deepStrictEqual(JSON.parse(Buffer.concat(sidecarFd3Chunks).toString('utf8')), {
        protocolVersion: 1,
        values: { AWS_BEARER_TOKEN_BEDROCK: 'super-private-test-value' },
      });

      proc.emit('close', 0);
      assert.deepStrictEqual(await proc.cleanupAttestation, {
        mode: 'container',
        terminalBuffered: true,
        descendantsReaped: true,
        clean: true,
      });
    } finally {
      fs.rmSync(artifacts.root, { recursive: true, force: true });
      if (oldSecret === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      else process.env.AWS_BEARER_TOKEN_BEDROCK = oldSecret;
    }
  });

  it('keeps setsid and double-fork descendants under a continuously observed subreaper', async function () {
    const spawned = [];
    const manager = new IsolationManager({
      spawn(binary, args, options) {
        const child = fakeChild();
        spawned.push({ binary, args, options, child });
        return child;
      },
      spawnSync() {
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const artifacts = privateRequest();
    manager.containers.set('cluster', 'contained');
    try {
      const proc = manager.spawnPreparedInContainer('contained', preparedSdkCommand([], artifacts));
      await proc.credentialHandoff;
      const args = spawned[0].args;
      const source = args[args.indexOf('-c') + 1];
      assert.match(source, /prctl\(PR_SET_CHILD_SUBREAPER, 1/);
      assert.match(source, /start_new_session=True/);
      assert.match(source, /identity\[1\] in owners/);
      assert.match(source, /tracked\.update\(descendants\)/);
      assert.match(source, /os\.pidfd_open\(pid, 0\)/);
      assert.match(source, /signal\.pidfd_send_signal\(pidfd, signum\)/);
      assert.doesNotMatch(source, /os\.kill\(/);
      assertPythonSourceCompiles(source);
      assert.match(
        source,
        /while child\.poll\(\) is None:\n {8}descendants = owned_descendants\(\)/
      );
      assert.match(source, /signal_identities\(descendants, signal\.SIGKILL\)/);
      assert(
        source.indexOf('stop_descendants()') <
          source.indexOf('write_state("clean', source.indexOf('stop_descendants()'))
      );
      proc.emit('close', 0);
      await proc.cleanupAttestation;
    } finally {
      fs.rmSync(artifacts.root, { recursive: true, force: true });
    }
  });

  it('cancels through a parent-owned root control identity without a workload PID file', async function () {
    const spawned = [];
    const controller = new AbortController();
    const manager = new IsolationManager({
      spawn(binary, args, options) {
        const child = fakeChild();
        spawned.push({ binary, args, options, child });
        if (spawned.length === 2) setImmediate(() => child.emit('close', 0));
        return child;
      },
      spawnSync() {
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const artifacts = privateRequest();
    manager.containers.set('cluster', 'contained');
    try {
      const proc = manager.spawnPreparedInContainer(
        'contained',
        preparedSdkCommand([], artifacts),
        { signal: controller.signal }
      );
      await proc.credentialHandoff;
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(spawned.length, 2);
      const mainArgs = spawned[0].args;
      const abortArgs = spawned[1].args;
      const mainControlPath = mainArgs[mainArgs.indexOf('-c') + 2];
      const abortControlPath = abortArgs[abortArgs.indexOf('-c') + 2];
      assert.match(mainControlPath, /^\/tmp\/\.zeroshot-sdk-control\/[a-f0-9]{48}$/);
      assert.strictEqual(abortControlPath, mainControlPath);
      assert(abortArgs.includes('--user'));
      assert(abortArgs.includes('0:0'));
      assert(!abortArgs.includes(artifacts.root));
      assert.doesNotMatch(JSON.stringify(spawned), /container-process\.pid/);
      assertPythonSourceCompiles(abortArgs[abortArgs.indexOf('-c') + 1]);
      const abortSource = abortArgs[abortArgs.indexOf('-c') + 1];
      assert.match(abortSource, /os\.O_EXCL \| os\.O_NOFOLLOW/);
      assert.doesNotMatch(abortSource, /os\.kill\(/);
      proc.emit('close', 143);
      assert.strictEqual((await proc.cleanupAttestation).clean, true);
    } finally {
      fs.rmSync(artifacts.root, { recursive: true, force: true });
    }
  });
  it('fails cancellation attestation immediately when the parent control helper cannot run', async function () {
    const spawned = [];
    const controller = new AbortController();
    const manager = new IsolationManager({
      spawn() {
        const child = fakeChild();
        spawned.push(child);
        if (spawned.length === 2) setImmediate(() => child.emit('close', 1));
        return child;
      },
      spawnSync() {
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const artifacts = privateRequest();
    manager.containers.set('cluster', 'contained');
    try {
      const proc = manager.spawnPreparedInContainer(
        'contained',
        preparedSdkCommand([], artifacts),
        { signal: controller.signal }
      );
      await proc.credentialHandoff;
      controller.abort();
      await assert.rejects(
        Promise.race([
          proc.cleanupAttestation,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('cancellation rejection timed out')), 250)
          ),
        ]),
        /cancellation cleanup could not be established/
      );
    } finally {
      fs.rmSync(artifacts.root, { recursive: true, force: true });
    }
  });

  it('rejects cleanup attestation when empty descendant ownership is unverifiable', async function () {
    const manager = new IsolationManager({
      spawn() {
        return fakeChild();
      },
      spawnSync(_binary, args) {
        const source = args[args.indexOf('-c') + 1];
        if (
          args.includes('/usr/bin/python3') &&
          typeof source === 'string' &&
          source.includes('empty descendant ownership was not attested')
        ) {
          assertPythonSourceCompiles(source);
          return { status: 1, stdout: '', stderr: 'ownership inspection unavailable' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const artifacts = privateRequest();
    manager.containers.set('cluster', 'contained');
    try {
      const proc = manager.spawnPreparedInContainer('contained', preparedSdkCommand([], artifacts));
      await proc.credentialHandoff;
      proc.emit('close', 0);
      await assert.rejects(proc.cleanupAttestation, /descendant ownership cleanup/);
    } finally {
      fs.rmSync(artifacts.root, { recursive: true, force: true });
    }
  });

  it('rejects undeclared containers, host containment, and missing credentials before spawn', function () {
    let spawnCount = 0;
    let copyCount = 0;
    const manager = new IsolationManager({
      spawn() {
        spawnCount += 1;
        return fakeChild();
      },
      spawnSync() {
        copyCount += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const artifacts = privateRequest();
    const oldEmptySecret = process.env.EMPTY_SDK_TEST_CREDENTIAL;
    process.env.EMPTY_SDK_TEST_CREDENTIAL = '';
    try {
      const command = preparedSdkCommand(['MISSING_SDK_TEST_CREDENTIAL'], artifacts);
      assert.throws(() => manager.spawnPreparedInContainer('unknown', command), /not active/);
      manager.containers.set('cluster', 'known');
      assert.throws(
        () => manager.spawnPreparedInContainer('known', command),
        /credential is unavailable/
      );
      assert.throws(
        () =>
          manager.spawnPreparedInContainer(
            'known',
            preparedSdkCommand(['EMPTY_SDK_TEST_CREDENTIAL'], artifacts)
          ),
        /credential is unavailable/
      );
      const hostCommand = {
        ...preparedSdkCommand([], artifacts),
        containmentRequirement: { mode: 'host-process-tree', required: true },
      };
      assert.throws(
        () => manager.spawnPreparedInContainer('known', hostCommand),
        /does not satisfy/
      );
      assert.strictEqual(spawnCount, 0);
      assert.strictEqual(copyCount, 0);
    } finally {
      fs.rmSync(artifacts.root, { recursive: true, force: true });
      if (oldEmptySecret === undefined) delete process.env.EMPTY_SDK_TEST_CREDENTIAL;
      else process.env.EMPTY_SDK_TEST_CREDENTIAL = oldEmptySecret;
    }
  });
});
