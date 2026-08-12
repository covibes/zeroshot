import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type net from 'node:net';
import path from 'node:path';

import RingBuffer from './ring-buffer';
import socketDiscovery from './socket-discovery';
import {
  handleClientConnection,
  handleClientMessage,
  removeClient,
  sendClientError,
} from './attach-server-clients';
import { cleanupAttachServer } from './attach-server-cleanup';
import { handleProcessExit, handlePtyOutput } from './attach-server-events';
import { spawnPty } from './attach-server-pty';
import { resizePty, sendPtySignal, stopPty, writePty } from './attach-server-runtime';
import { startSocketServer } from './attach-server-socket';
import type {
  AttachClientConnection,
  AttachServerHost,
  AttachServerOptions,
  AttachServerState,
  ExitSignal,
  PtyProcess,
} from './attach-server-types';

const DEFAULT_BUFFER_SIZE = 1024 * 1024;
const { cleanupStaleSocket } = socketDiscovery;

class AttachServer extends EventEmitter implements AttachServerHost {
  id: string;
  socketPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  outputBuffer: RingBuffer;
  clients = new Map<unknown, AttachClientConnection>();
  pty: PtyProcess | null = null;
  server: net.Server | null = null;
  state: AttachServerState = 'stopped';
  exitCode: number | null = null;
  exitSignal: ExitSignal = null;
  pid: number | null = null;

  constructor(options: AttachServerOptions) {
    super();
    if (!options.id) throw new Error('AttachServer: id is required');
    if (!options.socketPath) throw new Error('AttachServer: socketPath is required');
    if (!options.command) throw new Error('AttachServer: command is required');
    this.id = options.id;
    this.socketPath = options.socketPath;
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.cols = options.cols || 120;
    this.rows = options.rows || 30;
    this.outputBuffer = new RingBuffer(options.bufferSize || DEFAULT_BUFFER_SIZE);

    this._onProcessExit = this._onProcessExit.bind(this);
    this._onServerError = this._onServerError.bind(this);
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`AttachServer: Cannot start from state '${this.state}'`);
    }
    this.state = 'starting';
    const socketDir = path.dirname(this.socketPath);
    if (!fs.existsSync(socketDir)) fs.mkdirSync(socketDir, { recursive: true });
    await cleanupStaleSocket(this.socketPath);
    if (fs.existsSync(this.socketPath)) {
      throw new Error(`AttachServer: Socket already in use: ${this.socketPath}`);
    }
    await this._startServer();
    await this._spawnPty();
    this.state = 'running';
    this.emit('start', { id: this.id, pid: this.pid });
  }

  async stop(signal = 'SIGTERM'): Promise<void> {
    await stopPty(this, signal);
  }

  sendSignal(signal: string): boolean {
    return sendPtySignal(this, signal);
  }

  resize(cols: number, rows: number): void {
    resizePty(this, cols, rows);
  }

  write(data: Buffer | string): boolean {
    return writePty(this, data);
  }

  getState(): Record<string, unknown> {
    return {
      id: this.id,
      state: this.state,
      pid: this.pid,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      clientCount: this.clients.size,
      bufferSize: this.outputBuffer.getSize(),
    };
  }

  _startServer(): Promise<void> {
    return startSocketServer(this);
  }

  _spawnPty(): void {
    spawnPty(this);
  }

  _handlePtyOutput(data: Buffer | string): void {
    handlePtyOutput(this, data);
  }

  _handleClientConnection(socket: net.Socket): void {
    handleClientConnection(this, socket);
  }

  _handleClientMessage(
    socket: net.Socket,
    message: unknown,
    setClientId: (id: unknown) => void
  ): void {
    handleClientMessage(this, socket, message, setClientId);
  }

  _removeClient(clientId: unknown): void {
    removeClient(this, clientId);
  }

  _sendError(socket: net.Socket, message: string): void {
    sendClientError(socket, message);
  }

  _onProcessExit(exitCode: number, signal: ExitSignal): void {
    handleProcessExit(this, exitCode, signal);
  }

  _onServerError(error: Error): void {
    this.emit('error', error);
  }

  async _cleanup(): Promise<void> {
    await cleanupAttachServer(this);
  }
}

export = AttachServer;
