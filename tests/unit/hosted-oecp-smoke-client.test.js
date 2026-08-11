'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RpcClient } = require('../../scripts/hosted-oecp-smoke-client');
const {
  readCapabilityFile,
  resolveTransportCapability,
} = require('../../scripts/hosted-oecp-smoke-capability');
const {
  safeApplyFailure,
  SMOKE_CLUSTER,
  smokeCredentialBundle,
} = require('../../scripts/hosted-oecp-image-smoke');

const CAPABILITY = 'A'.repeat(32);

class ManualRpcTimers {
  constructor() {
    this.nextId = 1;
    this.callbacks = new Map();
    this.delays = [];
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.delays.push(delay);
    return id;
  }

  clearTimeout(id) {
    this.callbacks.delete(id);
  }

  fireAll() {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback();
    }
  }
}

class SmokeRpcSocket extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.sendError = null;
  }

  write(frame, callback) {
    this.frames.push(frame);
    callback(this.sendError);
  }

  respond(id, result) {
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
    this.emit('data', Buffer.from(frame));
  }
}

function createSmokeRpcFixture(options = {}) {
  const socket = new SmokeRpcSocket();
  const timers = new ManualRpcTimers();
  const client = new RpcClient(socket, { capability: CAPABILITY, timers, ...options });
  return { client, socket, timers };
}

function registerRequestLifecycleTests() {
  it('authenticates only the first request and clears each response timer', async function () {
    const { client, socket, timers } = createSmokeRpcFixture();
    const first = client.request(1, 'initialize', { protocolVersion: 'openengine.cluster/v1' });

    assert.deepStrictEqual(JSON.parse(socket.frames[0]), {
      _zeroshotOecpTransport: { capability: CAPABILITY },
      request: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 'openengine.cluster/v1' },
      },
    });
    assert(socket.frames[0].endsWith('\n'));
    const response = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { accepted: true },
    })}\n`;
    socket.emit('data', Buffer.from(response.slice(0, 9)));
    assert.strictEqual(timers.callbacks.size, 1);
    socket.emit('data', Buffer.from(response.slice(9)));
    assert.deepStrictEqual(await first, { accepted: true });
    assert.strictEqual(timers.callbacks.size, 0);

    const second = client.request(2, 'get', {});
    assert.deepStrictEqual(JSON.parse(socket.frames[1]), {
      jsonrpc: '2.0',
      id: 2,
      method: 'get',
      params: {},
    });
    assert(!socket.frames[1].includes(CAPABILITY));
    socket.respond(2, { status: 'empty' });
    await second;
    assert.strictEqual(timers.callbacks.size, 0);
  });

  it('applies a finite per-request timeout without leaving a pending request', async function () {
    const { client, socket, timers } = createSmokeRpcFixture({ requestTimeoutMs: 73 });
    const pending = client.request(1, 'get', {}, 41);

    assert.deepStrictEqual(timers.delays, [41]);
    timers.fireAll();
    await assert.rejects(pending, /OECP request timed out/);
    assert.strictEqual(client.pending.size, 0);
    assert.strictEqual(timers.callbacks.size, 0);
    socket.respond(1, { late: true });
    assert.throws(() => client.request(2, 'get', {}, Infinity), /positive finite number/);
  });
}

function registerSocketTerminationTests() {
  for (const terminalEvent of ['error', 'close']) {
    it(`rejects every request exactly once on socket ${terminalEvent}`, async function () {
      const { client, socket, timers } = createSmokeRpcFixture();
      let rejectionCount = 0;
      const countRejection = (request) =>
        request.catch((error) => {
          rejectionCount += 1;
          assert(!error.message.includes(CAPABILITY));
          throw error;
        });
      const requests = [
        countRejection(client.request(1, 'get', {})),
        countRejection(client.request(2, 'plan', {})),
      ];

      if (terminalEvent === 'error') socket.emit('error', new Error(`unsafe ${CAPABILITY}`));
      else socket.emit('close');
      const results = await Promise.allSettled(requests);
      assert(results.every((result) => result.status === 'rejected'));
      assert.strictEqual(client.pending.size, 0);
      assert.strictEqual(timers.callbacks.size, 0);

      timers.fireAll();
      if (terminalEvent === 'error') socket.emit('close');
      else socket.emit('error', new Error(`unsafe ${CAPABILITY}`));
      assert.strictEqual(rejectionCount, 2);
      await assert.rejects(client.request(3, 'get', {}));
      assert.strictEqual(timers.callbacks.size, 0);
    });
  }

  it('clears a request when the socket send callback rejects it', async function () {
    const { client, socket, timers } = createSmokeRpcFixture();
    socket.sendError = new Error(`unsafe ${CAPABILITY}`);

    await assert.rejects(client.request(1, 'get', {}), (error) => {
      assert.strictEqual(error.message, 'OECP request send failed');
      assert(!error.message.includes(CAPABILITY));
      return true;
    });
    assert.strictEqual(client.pending.size, 0);
    assert.strictEqual(timers.callbacks.size, 0);
  });
}

function registerCapabilityFileTests() {
  it('reads a bounded protected file once and permits explicit injection', function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-oecp-capability-'));
    const capabilityFile = path.join(directory, 'capability');
    const fileCapability = 'B'.repeat(48);
    try {
      fs.writeFileSync(capabilityFile, `${fileCapability}\r\n`, { mode: 0o400 });
      fs.chmodSync(capabilityFile, 0o400);
      assert.strictEqual(readCapabilityFile(capabilityFile), fileCapability);
      assert.strictEqual(
        resolveTransportCapability({}, { ZEROSHOT_OECP_CAPABILITY_FILE: capabilityFile }),
        fileCapability
      );
      assert.strictEqual(
        resolveTransportCapability({ capability: CAPABILITY, capabilityFile: '/missing' }),
        CAPABILITY
      );

      fs.chmodSync(capabilityFile, 0o600);
      assert.throws(() => readCapabilityFile(capabilityFile), /protected bounded regular file/);
      const invalid = `invalid secret ${CAPABILITY}`;
      assert.throws(
        () => resolveTransportCapability({ capability: invalid }),
        (error) => !error.message.includes(invalid)
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

function registerSafeDiagnosticTests() {
  it('projects only the closed worker-start code from an apply failure', function () {
    const sensitiveFragments = [
      'HOSTED_SMOKE_PROMPT_CANARY',
      'HOSTED_SMOKE_GIT_TOKEN_CANARY',
      'HOSTED_SMOKE_PROVIDER_TOKEN_CANARY',
      '/private/host/worktree',
      '{"type":"turn.failed","error":{"message":"raw provider output"}}',
    ];
    const rawContext = sensitiveFragments.join(' ');
    const projected = safeApplyFailure({
      error: {
        data: { code: 'WORKER_START', diagnostic: rawContext },
        message: rawContext,
      },
      message: rawContext,
    });

    assert.strictEqual(projected.message, 'Hosted apply request failed (WORKER_START)');
    assert.strictEqual(projected.stack, projected.message);
    for (const fragment of sensitiveFragments) assert(!projected.stack.includes(fragment));

    const unknown = safeApplyFailure({ error: { data: { code: rawContext } } });
    assert.strictEqual(unknown.message, 'Hosted apply request failed');
    assert.strictEqual(unknown.stack, unknown.message);
  });
}

function registerCredentialProvisioningTests() {
  it('builds the current provider-neutral credential install bundle', function () {
    assert.deepStrictEqual(smokeCredentialBundle(), {
      githubToken: 'HOSTED_SMOKE_GIT_TOKEN_CANARY',
      repository: 'the-open-engine/zeroshot-smoke',
      baseRevision: 'a'.repeat(40),
      delivery: {
        version: 'zeroshot.delivery/v1',
        mode: 'pr',
        repository: 'the-open-engine/zeroshot-smoke',
        targetBranch: 'main',
        baseRevision: 'a'.repeat(40),
      },
      runtime: {
        provider: 'codex',
        executable: 'codex',
        environment: {
          OPENAI_API_KEY: 'HOSTED_SMOKE_PROVIDER_TOKEN_CANARY',
          OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
        },
        files: { 'cluster.json': SMOKE_CLUSTER },
        settings: { defaultProvider: 'codex' },
      },
    });
  });
}

function registerSmokeRpcClientTests() {
  describe('request lifecycle', registerRequestLifecycleTests);
  describe('socket termination', registerSocketTerminationTests);
  describe('capability loading', registerCapabilityFileTests);
  describe('safe diagnostics', registerSafeDiagnosticTests);
  describe('credential provisioning', registerCredentialProvisioningTests);
}

describe('hosted OECP smoke RPC client', registerSmokeRpcClientTests);
