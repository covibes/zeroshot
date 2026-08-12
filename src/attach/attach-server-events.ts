import protocol from './protocol';
import type { AttachServerHost, ExitSignal } from './attach-server-types';

export function handlePtyOutput(host: AttachServerHost, data: Buffer | string): void {
  host.outputBuffer.write(data);
  const message = protocol.encode(protocol.createOutputMessage(data));
  for (const [clientId, client] of host.clients) {
    try {
      client.socket.write(message);
    } catch {
      host._removeClient(clientId);
    }
  }
  host.emit('output', data);
}

export function handleProcessExit(
  host: AttachServerHost,
  exitCode: number,
  signal: ExitSignal
): void {
  host.exitCode = exitCode;
  host.exitSignal = signal;
  host.state = 'exited';
  const exitMessage = protocol.encode(protocol.createExitMessage(exitCode, signal));
  for (const [, client] of host.clients) {
    try {
      client.socket.write(exitMessage);
      client.socket.end();
    } catch {
      // Client already disconnected.
    }
  }
  host.emit('exit', { exitCode, signal });
  setTimeout(() => void host._cleanup(), 500);
}
