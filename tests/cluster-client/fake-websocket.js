'use strict';

const { EventEmitter } = require('node:events');

const OPEN = 1;
const CLOSED = 3;

/** A minimal in-memory `WebSocketLike` (see `src/cluster/transport/websocket-like.ts`). */
class FakeWebSocket {
  constructor() {
    this.readyState = OPEN;
    this.sent = [];
    this.emitter = new EventEmitter();
    this.peer = null;
  }

  send(data) {
    if (this.readyState !== OPEN) {
      throw new Error('cannot send: fake socket is not open');
    }
    this.sent.push(data);
    const peer = this.peer;
    if (peer && peer.readyState === OPEN) {
      Promise.resolve().then(() => peer.emitter.emit('message', { data }));
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emitter.emit('close', { code, reason });
    const peer = this.peer;
    if (peer && peer.readyState !== CLOSED) peer.close(code, reason);
  }

  addEventListener(type, listener) {
    this.emitter.on(type, listener);
  }

  removeEventListener(type, listener) {
    this.emitter.off(type, listener);
  }
}

/** Two `FakeWebSocket`s wired to each other: `client` (given to a `ConnectionMultiplexer`) and `server` (driven by the test). */
function createFakeSocketPair() {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

function sentMessages(socket) {
  return socket.sent.map((raw) => JSON.parse(raw));
}

function respondSuccess(serverSocket, id, result) {
  serverSocket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function respondError(serverSocket, id, error) {
  serverSocket.send(JSON.stringify({ jsonrpc: '2.0', id, error }));
}

function notify(serverSocket, method, params) {
  serverSocket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

/** Resolves with the next request/notification the server side observes for `method`. */
function waitForRequest(serverSocket, method) {
  return new Promise((resolve) => {
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.method === method) {
        serverSocket.removeEventListener('message', onMessage);
        resolve(message);
      }
    }
    serverSocket.addEventListener('message', onMessage);
  });
}

module.exports = {
  FakeWebSocket,
  createFakeSocketPair,
  sentMessages,
  respondSuccess,
  respondError,
  notify,
  waitForRequest,
};
