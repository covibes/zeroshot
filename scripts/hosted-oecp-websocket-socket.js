'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;

class WebSocketRpcSocket extends EventEmitter {
  constructor(url, headers) {
    super();
    this.socket = new WebSocket(url, {
      handshakeTimeout: DEFAULT_HANDSHAKE_TIMEOUT_MS,
      headers,
    });
    this.socket.on('message', (bytes) => {
      this.emit('data', Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]));
    });
    this.socket.on('error', (error) => this.emit('error', error));
    this.socket.on('close', () => this.emit('close'));
  }

  write(frame, callback) {
    this.socket.send(frame, callback);
  }

  destroy() {
    this.socket.terminate();
  }
}

async function connectWebSocketSocket(url, headers) {
  const socket = new WebSocketRpcSocket(url, headers);
  await new Promise((resolve, reject) => {
    socket.socket.once('open', resolve);
    socket.socket.once('error', reject);
  });
  return socket;
}

module.exports = { connectWebSocketSocket };
