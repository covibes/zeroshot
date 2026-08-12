import type { EventEmitter } from 'node:events';
import type net from 'node:net';

import type RingBuffer from './ring-buffer';

export type AttachServerState = 'stopped' | 'starting' | 'running' | 'exiting' | 'exited';
export type ExitSignal = string | number | undefined | null;

export interface AttachServerOptions {
  id: string;
  socketPath: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  bufferSize?: number;
}

export interface MessageDecoder {
  feed(data: Buffer): unknown[];
}

export interface AttachClientConnection {
  socket: net.Socket;
  decoder: MessageDecoder;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  pid: number;
  kill(signal: string): void;
  resize(cols: number, rows: number): void;
  write(data: Buffer | string): void;
  onData(handler: (data: string) => void): unknown;
  onExit(handler: (event: PtyExitEvent) => void): unknown;
}

export interface AttachServerRuntimeState {
  id: string;
  socketPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  outputBuffer: RingBuffer;
  clients: Map<unknown, AttachClientConnection>;
  pty: PtyProcess | null;
  server: net.Server | null;
  state: AttachServerState;
  exitCode: number | null;
  exitSignal: ExitSignal;
  pid: number | null;
}

export interface AttachServerOperations extends EventEmitter {
  sendSignal(signal: string): boolean;
  resize(cols: number, rows: number): void;
  write(data: Buffer | string): boolean;
  getState(): Record<string, unknown>;
  _handleClientConnection(socket: net.Socket): void;
  _handleClientMessage(
    socket: net.Socket,
    message: unknown,
    setClientId: (id: unknown) => void
  ): void;
  _removeClient(clientId: unknown): void;
  _sendError(socket: net.Socket, message: string): void;
  _handlePtyOutput(data: Buffer | string): void;
  _onProcessExit(exitCode: number, signal: ExitSignal): void;
  _onServerError(error: Error): void;
  _cleanup(): Promise<void>;
}

export type AttachServerHost = AttachServerRuntimeState & AttachServerOperations;
