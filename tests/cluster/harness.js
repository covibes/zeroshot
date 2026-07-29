'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeWebSocket {
  constructor({ open = true } = {}) {
    this.readyState = open ? 1 : 0;
    this.sent = [];
    this.closeCalls = 0;
    this.listeners = new Map();
    this.sendFailure = undefined;
    this.sendGate = undefined;
    this.closeFailure = undefined;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener)
    );
  }

  emit(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  send(data) {
    if (this.sendFailure) {
      const failure = this.sendFailure;
      if (failure instanceof Promise) return failure;
      throw failure;
    }
    this.sent.push(JSON.parse(data));
    return this.sendGate?.promise;
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit('close', {});
    if (this.closeFailure) throw this.closeFailure;
  }

  respond(id, result) {
    this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  }

  error(id, code, message, domainCode) {
    this.emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code, message, ...(domainCode ? { data: { code: domainCode } } : {}) },
      }),
    });
  }

  notify(method, params) {
    this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method, params }) });
  }

  request(method, occurrence = 0) {
    return this.sent.filter((frame) => frame.method === method && 'id' in frame)[occurrence];
  }

  notifications(method) {
    return this.sent.filter((frame) => frame.method === method && !('id' in frame));
  }
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function assertClean(connection) {
  assert.equal(connection.pendingSize, 0, 'pending requests leaked');
  assert.equal(connection.subscriptionCount, 0, 'subscriptions leaked');
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

function contentsBelow(directory) {
  return filesBelow(directory).map((file) => ({
    file,
    content: fs.readFileSync(file, 'utf8'),
  }));
}

function connected(Connection, ClusterClient) {
  const socket = new FakeWebSocket();
  const connection = new Connection(socket);
  return { socket, connection, client: new ClusterClient(connection) };
}

module.exports = {
  FakeWebSocket,
  assertClean,
  connected,
  contentsBelow,
  deferred,
  filesBelow,
  settle,
};
