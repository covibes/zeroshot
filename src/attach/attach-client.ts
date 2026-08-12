/** Terminal client for attaching to a running task or agent. */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import protocol from './protocol';

const CTRL_B = '\x02';
const CTRL_C = '\x03';
const CTRL_Z = '\x1a';
const DETACH_TIMEOUT = 500;

interface AttachInput extends NodeJS.ReadableStream {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => AttachInput;
}

interface AttachOutput extends NodeJS.WritableStream {
  columns: number;
  isTTY?: boolean;
  rows: number;
}

interface AttachClientOptions {
  socketPath: string;
  stdin?: AttachInput;
  stdout?: AttachOutput;
}

interface ServerMessage {
  code: unknown;
  data: unknown;
  message: unknown;
  signal: unknown;
  type: unknown;
}

function readServerMessage(message: unknown): ServerMessage {
  if ((typeof message !== 'object' && typeof message !== 'function') || message === null) {
    throw new TypeError(`Cannot read properties of ${message}`);
  }
  return {
    code: Reflect.get(message, 'code'),
    data: Reflect.get(message, 'data'),
    message: Reflect.get(message, 'message'),
    signal: Reflect.get(message, 'signal'),
    type: Reflect.get(message, 'type'),
  };
}

function dataMessage(data: unknown): { data?: string | null } {
  if (data === undefined || !data) return {};
  if (typeof data === 'string') return { data };
  throw new TypeError('Attach protocol data must be a base64 string');
}

class AttachClient extends EventEmitter {
  readonly socketPath: string;
  readonly stdin: AttachInput;
  readonly stdout: AttachOutput;
  readonly clientId: string;
  socket: net.Socket | null = null;
  decoder = new protocol.MessageDecoder();
  connected = false;
  wasRawMode: boolean | undefined | null = null;
  ctrlBPressed = false;
  ctrlBTimeout: NodeJS.Timeout | null = null;

  constructor(options: AttachClientOptions) {
    super();
    if (!options.socketPath) {
      throw new Error('AttachClient: socketPath is required');
    }
    this.socketPath = options.socketPath;
    this.stdin = options.stdin || process.stdin;
    this.stdout = options.stdout || process.stdout;
    this.clientId = crypto.randomUUID();

    this._onSocketData = this._onSocketData.bind(this);
    this._onSocketClose = this._onSocketClose.bind(this);
    this._onSocketError = this._onSocketError.bind(this);
    this._onStdinData = this._onStdinData.bind(this);
    this._onResize = this._onResize.bind(this);
  }

  connect(): Promise<void> {
    if (this.connected) {
      throw new Error('AttachClient: Already connected');
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;

      socket.on('connect', () => {
        this.connected = true;
        const cols = this.stdout.columns || 80;
        const rows = this.stdout.rows || 24;
        socket.write(protocol.encode(protocol.createAttachMessage(this.clientId, cols, rows)));
        this._setupTerminal();
        socket.on('data', this._onSocketData);
        socket.on('close', this._onSocketClose);
        socket.on('error', this._onSocketError);
        resolve();
      });

      socket.on('error', (error: Error) => {
        if (!this.connected) reject(error);
      });

      const timeout = setTimeout(() => {
        if (!this.connected) {
          socket.destroy();
          reject(new Error('Connection timeout'));
        }
      }, 5000);
      socket.on('connect', () => clearTimeout(timeout));
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    try {
      this.socket?.write(protocol.encode(protocol.createDetachMessage(this.clientId)));
    } catch {
      // Ignore transport failures during detach.
    }
    this._cleanup();
    this.emit('detach');
  }

  sendSignal(signal: string): void {
    if (!this.connected) return;
    try {
      this.socket?.write(protocol.encode(protocol.createSignalMessage(signal)));
    } catch {
      // Ignore transport failures while signaling.
    }
  }

  private _setupTerminal(): void {
    if (this.stdin.isTTY && this.stdin.setRawMode) {
      this.wasRawMode = this.stdin.isRaw;
      this.stdin.setRawMode(true);
    }
    this.stdin.resume();
    this.stdin.on('data', this._onStdinData);
    if (this.stdout.isTTY) this.stdout.on('resize', this._onResize);

    process.on('SIGINT', () => this.disconnect());
    process.on('SIGTERM', () => {
      this._cleanup();
      process.exit(0);
    });
  }

  private _restoreTerminal(): void {
    if (this.stdin.isTTY && this.stdin.setRawMode && this.wasRawMode !== null) {
      Reflect.apply(this.stdin.setRawMode, this.stdin, [this.wasRawMode]);
    }
    this.stdin.removeListener('data', this._onStdinData);
    if (this.stdout.isTTY) this.stdout.removeListener('resize', this._onResize);
    this.stdin.pause();
  }

  private _onSocketData(data: Buffer): void {
    try {
      for (const message of this.decoder.feed(data)) this._handleMessage(message);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.emit('error', new Error(`Protocol error: ${reason}`));
      this._cleanup();
    }
  }

  private _handleMessage(message: unknown): void {
    const serverMessage = readServerMessage(message);
    switch (serverMessage.type) {
      case protocol.MessageType.OUTPUT:
      case protocol.MessageType.HISTORY: {
        const data = protocol.decodeData(dataMessage(serverMessage.data));
        if (data) this.stdout.write(data);
        break;
      }
      case protocol.MessageType.STATE:
        this.emit('state', message);
        break;
      case protocol.MessageType.EXIT: {
        const { code, signal } = serverMessage;
        this.emit('exit', { code, signal });
        this._cleanup();
        break;
      }
      case protocol.MessageType.ERROR:
        this.emit(
          'error',
          new Error(serverMessage.message === undefined ? undefined : String(serverMessage.message))
        );
        break;
    }
  }

  private _onStdinData(data: Buffer | string): void {
    const input = data.toString();
    if (this.ctrlBPressed) {
      this.ctrlBPressed = false;
      if (this.ctrlBTimeout) {
        clearTimeout(this.ctrlBTimeout);
        this.ctrlBTimeout = null;
      }
      if (input === 'd' || input === 'D') return this.disconnect();
      if (input === 'c' || input === 'C') {
        this.stdout.write('\r\n⚠️  Sending SIGINT to agent (interrupting task)...\r\n');
        return this.sendSignal('SIGINT');
      }
      if (input === '?') return this._showHelp();
      this._forwardInput(Buffer.from([0x02]));
      this._forwardInput(data);
      return;
    }

    if (input === CTRL_B) {
      this.ctrlBPressed = true;
      this.ctrlBTimeout = setTimeout(() => {
        if (this.ctrlBPressed) {
          this.ctrlBPressed = false;
          this._forwardInput(data);
        }
      }, DETACH_TIMEOUT);
      return;
    }
    if (input === CTRL_C) return this.disconnect();
    if (input === CTRL_Z) return this.sendSignal('SIGTSTP');
    this._forwardInput(data);
  }

  private _forwardInput(data: Buffer | string): void {
    if (!this.connected) return;
    try {
      this.socket?.write(protocol.encode(protocol.createStdinMessage(data)));
    } catch {
      // Ignore transport failures while forwarding terminal input.
    }
  }

  private _onResize(): void {
    if (!this.connected) return;
    try {
      this.socket?.write(
        protocol.encode(protocol.createResizeMessage(this.stdout.columns, this.stdout.rows))
      );
    } catch {
      // Ignore transport failures while forwarding terminal size.
    }
  }

  private _onSocketClose(): void {
    if (this.connected) {
      this.emit('close');
      this._cleanup();
    }
  }

  private _onSocketError(error: Error): void {
    this.emit('error', error);
    this._cleanup();
  }

  private _showHelp(): void {
    const horizontal = '─'.repeat(58);
    this.stdout.write(`
\r\n╭${horizontal}╮
\r\n│              Vibe Attach - Key Bindings                  │
\r\n├${horizontal}┤
\r\n│  Ctrl+C      Detach (task continues running)             │
\r\n│  Ctrl+B d    Also detach (for tmux muscle memory)        │
\r\n│  Ctrl+B ?    Show this help                              │
\r\n│  Ctrl+B c    ⚠️  Interrupt agent (sends SIGINT)           │
\r\n│  Ctrl+Z      Suspend process (sends SIGTSTP)             │
\r\n╰${horizontal}╯
\r\n`);
  }

  private _cleanup(): void {
    this.connected = false;
    if (this.ctrlBTimeout) {
      clearTimeout(this.ctrlBTimeout);
      this.ctrlBTimeout = null;
    }
    this._restoreTerminal();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

export = AttachClient;
