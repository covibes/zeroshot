import type net from 'node:net';

import protocol from './protocol';
import type { AttachServerHost } from './attach-server-types';

function messageField(message: unknown, field: string): unknown {
  if ((typeof message !== 'object' && typeof message !== 'function') || message === null) {
    throw new TypeError(`Cannot read properties of ${message}`);
  }
  return Reflect.get(message, field);
}

function decodeClientData(data: unknown): Buffer | null {
  if (!data) return null;
  if (typeof data !== 'string') {
    throw new TypeError('Attach protocol data must be a base64 string');
  }
  return Buffer.from(data, 'base64');
}

function attachClient(
  host: AttachServerHost,
  socket: net.Socket,
  message: unknown,
  setClientId: (id: unknown) => void
): void {
  const clientId = messageField(message, 'clientId');
  if (!clientId) {
    host._sendError(socket, 'ATTACH requires clientId');
    return;
  }
  host.clients.set(clientId, { socket, decoder: new protocol.MessageDecoder() });
  setClientId(clientId);
  const history = host.outputBuffer.read();
  if (history.length > 0) {
    socket.write(protocol.encode(protocol.createHistoryMessage(history)));
  }
  socket.write(protocol.encode(protocol.createStateMessage(host.getState())));
  const cols = messageField(message, 'cols');
  const rows = messageField(message, 'rows');
  if (cols && rows) Reflect.apply(host.resize, host, [cols, rows]);
  host.emit('clientAttach', { clientId });
}

function resizeClient(host: AttachServerHost, message: unknown): void {
  const cols = messageField(message, 'cols');
  const rows = messageField(message, 'rows');
  if (cols && rows) Reflect.apply(host.resize, host, [cols, rows]);
}

function writeClientInput(host: AttachServerHost, message: unknown): void {
  const data = decodeClientData(messageField(message, 'data'));
  if (data) host.write(data);
}

export function handleClientConnection(host: AttachServerHost, socket: net.Socket): void {
  const decoder = new protocol.MessageDecoder();
  let clientId: unknown = null;
  socket.on('data', (data: Buffer) => {
    try {
      for (const message of decoder.feed(data)) {
        host._handleClientMessage(socket, message, (id) => {
          clientId = id;
        });
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      host._sendError(socket, `Protocol error: ${reason}`);
      socket.end();
    }
  });
  socket.on('close', () => {
    if (clientId) host._removeClient(clientId);
  });
  socket.on('error', () => {
    if (clientId) host._removeClient(clientId);
  });
}

export function handleClientMessage(
  host: AttachServerHost,
  socket: net.Socket,
  message: unknown,
  setClientId: (id: unknown) => void
): void {
  const type = messageField(message, 'type');
  switch (type) {
    case protocol.MessageType.ATTACH:
      attachClient(host, socket, message, setClientId);
      break;
    case protocol.MessageType.DETACH:
      host._removeClient(messageField(message, 'clientId'));
      socket.end();
      break;
    case protocol.MessageType.RESIZE:
      resizeClient(host, message);
      break;
    case protocol.MessageType.SIGNAL:
      Reflect.apply(host.sendSignal, host, [messageField(message, 'signal')]);
      break;
    case protocol.MessageType.STDIN:
      writeClientInput(host, message);
      break;
    default:
      host._sendError(socket, `Unknown message type: ${type}`);
  }
}

export function removeClient(host: AttachServerHost, clientId: unknown): void {
  if (host.clients.has(clientId)) {
    host.clients.delete(clientId);
    host.emit('clientDetach', { clientId });
  }
}

export function sendClientError(socket: net.Socket, message: string): void {
  try {
    socket.write(protocol.encode(protocol.createErrorMessage(message)));
  } catch {
    // Client disconnected.
  }
}
