'use strict';

const net = require('net');
const { StringDecoder } = require('string_decoder');
const {
  resolveTransportCapability,
  validateCapability,
} = require('./hosted-oecp-smoke-capability');

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
function record(fields) {
  return {
    fields: Object.fromEntries(fields.map(([name, type, required]) => [name, { required, type }])),
    kind: 'record',
  };
}

function enumeration(values) {
  return { kind: 'enum', values };
}

function legacyTypes() {
  const artifact = record([
    ['artifactId', { kind: 'string' }, true],
    ['sha256', { kind: 'string' }, true],
    ['byteLength', { kind: 'integer' }, true],
    ['mediaType', { kind: 'string' }, true],
    ['typeId', { kind: 'string' }, true],
    [
      'producer',
      record([
        ['node', { kind: 'string' }, true],
        ['worker', { kind: 'string' }, true],
      ]),
      true,
    ],
    [
      'lineage',
      record([
        ['generation', { kind: 'integer' }, true],
        ['runId', { kind: 'string' }, true],
        ['attempt', { kind: 'integer' }, true],
      ]),
      true,
    ],
    ['redaction', enumeration(['public', 'internal', 'confidential', 'restricted']), true],
  ]);
  return {
    input: record([
      ['source', enumeration(['issue', 'prompt', 'artifact']), true],
      ['issue', { kind: 'string' }, false],
      ['prompt', { kind: 'string' }, false],
      ['artifacts', { kind: 'array', items: artifact }, true],
      ['isolationProfile', { kind: 'string' }, true],
      ['providerProfile', { kind: 'string' }, true],
      ['repository', { kind: 'string' }, true],
      ['provider', { kind: 'string' }, true],
      ['modelLevel', enumeration(['level1', 'level2', 'level3']), true],
    ]),
    output: record([
      ['summary', { kind: 'string' }, true],
      ['status', enumeration(['succeeded', 'failed']), true],
      ['artifacts', { kind: 'array', items: artifact }, true],
      ['repository', { kind: 'string' }, false],
      ['branch', { kind: 'string' }, false],
      ['headRevision', { kind: 'string' }, false],
      ['pullRequestUrl', { kind: 'string' }, false],
    ]),
  };
}

function smokeGraph() {
  const types = legacyTypes();
  return {
    profile: 'openengine.graph.single-worker/v1',
    initialInput: types.input,
    policy: { policy: 'policy.strict@1', default: 'deny' },
    root: {
      kind: 'step',
      name: 'ship',
      worker: 'legacy.zeroshot.ship@1',
      input: types.input,
      output: types.output,
      inputBindings: [],
      writeBindings: [],
      timeoutMs: 10_000,
      attempts: 1,
    },
  };
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('OECP request timeout must be a positive finite number');
  }
  return timeoutMs;
}

class RpcClient {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.timers = options.timers ?? { setTimeout, clearTimeout };
    this.transportCapability =
      options.capability === undefined ? undefined : validateCapability(options.capability);
    this.decoder = new StringDecoder('utf8');
    this.inbound = '';
    this.terminalError = null;
    socket.on('data', (bytes) => this.onData(bytes));
    socket.on('error', () => this.terminate(new Error('OECP socket failed')));
    socket.on('close', () => this.terminate(new Error('OECP socket closed')));
  }

  onData(bytes) {
    this.inbound += this.decoder.write(bytes);
    let newline;
    while ((newline = this.inbound.indexOf('\n')) >= 0) {
      const line = this.inbound.slice(0, newline);
      this.inbound = this.inbound.slice(newline + 1);
      try {
        this.onMessage(line);
      } catch {
        this.terminate(new Error('OECP socket sent an invalid frame'));
        this.socket.destroy();
        return;
      }
    }
  }

  onMessage(line) {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending || this.pending.get(message.id) !== pending) return;
      this.pending.delete(message.id);
      this.timers.clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error('OECP request failed'), message));
      else pending.resolve(message.result);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.notifications.push(message);
    }
  }

  terminate(error) {
    if (this.terminalError) return;
    this.terminalError = error;
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendingRequests) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(error);
    }
    const pendingWaiters = this.waiters.splice(0);
    for (const waiter of pendingWaiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  settleRejected(id, pending, error) {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    this.timers.clearTimeout(pending.timer);
    pending.reject(error);
  }

  request(id, method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pending.has(id))
      return Promise.reject(new Error('OECP request id is already pending'));
    const boundedTimeoutMs = validateTimeout(timeoutMs);
    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: this.timers.setTimeout(() => {
          this.settleRejected(id, pending, new Error('OECP request timed out'));
        }, boundedTimeoutMs),
      };
      this.pending.set(id, pending);

      const request = { jsonrpc: '2.0', id, method, params };
      const capability = this.transportCapability;
      let frame;
      try {
        frame = `${JSON.stringify(
          capability === undefined
            ? request
            : {
                _zeroshotOecpTransport: { capability },
                request,
              }
        )}\n`;
        this.transportCapability = undefined;
        this.socket.write(frame, (error) => {
          if (error) {
            this.settleRejected(id, pending, new Error('OECP request send failed'));
          }
        });
      } catch {
        this.settleRejected(id, pending, new Error('OECP request send failed'));
      }
    });
  }

  nextNotification() {
    const queued = this.notifications.shift();
    if (queued) return Promise.resolve(queued);
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: this.timers.setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Timed out waiting for OECP notification'));
        }, 5000),
      };
      this.waiters.push(waiter);
    });
  }
}

async function connectClient(endpoint, options = {}) {
  const capability = resolveTransportCapability(options);
  const socket = net.createConnection(endpoint);
  const client = new RpcClient(socket, { ...options, capability });
  await new Promise((resolve, reject) => {
    function cleanup() {
      socket.off('connect', onConnect);
      socket.off('error', onError);
    }
    function onConnect() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
  return client;
}

async function nextEvent(client) {
  for (;;) {
    const notification = await client.nextNotification();
    if (notification.method === 'event') return notification.params;
    if (notification.method === 'subscription/closed') {
      throw new Error(`Hosted watch closed early: ${JSON.stringify(notification.params)}`);
    }
  }
}

module.exports = {
  RpcClient,
  connectClient,
  nextEvent,
  smokeGraph,
};
