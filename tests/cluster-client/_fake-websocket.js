'use strict';

const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;
const READY_STATE_CLOSED = 3;

/**
 * Minimal `ClusterWebSocketLike`-compatible fake (see src/cluster/websocket-transport.ts) driven
 * entirely by a scripted `respond(request, socket)` callback: `{ reply, after }`, where `reply` is
 * the JSON-RPC response/notification object to deliver and `after(socket)` runs once `reply` has
 * been routed (so it can push follow-up notifications, e.g. simulated `event` traffic, only after
 * the establishing response registered the subscription).
 */
class FakeWebSocket {
  constructor(url, respond) {
    this.url = url;
    this.readyState = READY_STATE_CONNECTING;
    this.sent = [];
    this._listeners = { open: [], close: [], error: [], message: [] };
    this._respond = respond || null;
    queueMicrotask(() => {
      if (this.readyState === READY_STATE_CLOSED) return;
      this.readyState = READY_STATE_OPEN;
      this._emit('open', undefined);
    });
  }

  send(data) {
    this.sent.push(data);
    if (!this._respond) return;
    const request = JSON.parse(data);
    const outcome = this._respond(request, this);
    if (!outcome) return;
    const { reply, after } = outcome;
    queueMicrotask(() => {
      if (reply) this._emit('message', { data: JSON.stringify(reply) });
      if (after) queueMicrotask(() => after(this));
    });
  }

  close() {
    if (this.readyState === READY_STATE_CLOSED) return;
    this.readyState = READY_STATE_CLOSED;
    queueMicrotask(() => this._emit('close', { code: 1000, reason: '' }));
  }

  addEventListener(type, listener) {
    this._listeners[type].push(listener);
  }

  _emit(type, event) {
    for (const listener of this._listeners[type].slice()) listener(event);
  }

  /** Test-only: deliver an unsolicited server->client frame (e.g. a subscription `event`). */
  push(message) {
    queueMicrotask(() => this._emit('message', { data: JSON.stringify(message) }));
  }

  /** Test-only: simulate the connection dying (server crash, network partition, etc). */
  simulateDisconnect() {
    this.close();
  }
}

function createWebSocketFactory(respond) {
  const sockets = [];
  const factory = (url) => {
    const socket = new FakeWebSocket(url, respond);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

module.exports = { FakeWebSocket, createWebSocketFactory, READY_STATE_OPEN };
