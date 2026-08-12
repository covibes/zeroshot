/**
 * Protocol - Message framing for attach/detach IPC
 *
 * Uses length-prefixed JSON messages over Unix sockets.
 * Format: [4-byte length (BE)] [JSON payload]
 */

const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB max message

const MessageType = {
  // Client → Server
  ATTACH: 'attach',
  DETACH: 'detach',
  RESIZE: 'resize',
  SIGNAL: 'signal',
  STDIN: 'stdin',

  // Server → Client
  OUTPUT: 'output',
  HISTORY: 'history',
  STATE: 'state',
  EXIT: 'exit',
  ERROR: 'error',
} as const;

type BinaryData = Buffer | string;
type MessageWithData = { data?: string | null };
type AttachMessage = {
  type: typeof MessageType.ATTACH;
  clientId: string;
  cols: number;
  rows: number;
};
type DetachMessage = { type: typeof MessageType.DETACH; clientId: string };
type ResizeMessage = { type: typeof MessageType.RESIZE; cols: number; rows: number };
type SignalMessage = { type: typeof MessageType.SIGNAL; signal: string };
type DataMessage<T extends string> = { type: T; data: string };
type OutputMessage = DataMessage<typeof MessageType.OUTPUT> & { timestamp: number };
type ExitMessage = { type: typeof MessageType.EXIT; code: number | null; signal: string | null };
type ErrorMessage = { type: typeof MessageType.ERROR; message: string };

/** Encode a message for transmission. */
function encode(message: object): Buffer {
  const json = JSON.stringify(message) as string;
  const payload = Buffer.from(json, 'utf8');

  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${payload.length} bytes (max ${MAX_MESSAGE_SIZE})`);
  }

  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);

  return frame;
}

/** Streaming decoder for framed messages. */
class MessageDecoder {
  buffer: Buffer;

  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** Feed a received data chunk into the decoder. */
  feed(data: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages: unknown[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);

      if (length > MAX_MESSAGE_SIZE) {
        throw new Error(`Message too large: ${length} bytes (max ${MAX_MESSAGE_SIZE})`);
      }

      if (this.buffer.length < 4 + length) {
        // Incomplete message, wait for more data
        break;
      }

      const payload = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);

      try {
        const message: unknown = JSON.parse(payload.toString('utf8'));
        messages.push(message);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in message: ${reason}`);
      }
    }

    return messages;
  }

  /** Reset decoder state. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

function createAttachMessage(clientId: string, cols: number, rows: number): AttachMessage {
  return { type: MessageType.ATTACH, clientId, cols, rows };
}

function createDetachMessage(clientId: string): DetachMessage {
  return { type: MessageType.DETACH, clientId };
}

function createResizeMessage(cols: number, rows: number): ResizeMessage {
  return { type: MessageType.RESIZE, cols, rows };
}

function createSignalMessage(signal: string): SignalMessage {
  if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP'].includes(signal)) {
    throw new Error(`Invalid signal: ${signal}`);
  }
  return { type: MessageType.SIGNAL, signal };
}

function createStdinMessage(data: BinaryData): DataMessage<typeof MessageType.STDIN> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { type: MessageType.STDIN, data: buf.toString('base64') };
}

function createOutputMessage(data: BinaryData, timestamp = Date.now()): OutputMessage {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { type: MessageType.OUTPUT, data: buf.toString('base64'), timestamp };
}

function createHistoryMessage(data: BinaryData): DataMessage<typeof MessageType.HISTORY> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { type: MessageType.HISTORY, data: buf.toString('base64') };
}

function createStateMessage(state: Record<string, unknown>): Record<string, unknown> {
  return { type: MessageType.STATE, ...state };
}

function createExitMessage(code: number | null, signal: string | null): ExitMessage {
  return { type: MessageType.EXIT, code, signal };
}

function createErrorMessage(message: string): ErrorMessage {
  return { type: MessageType.ERROR, message };
}

/** Decode the base64 data field from OUTPUT/HISTORY/STDIN messages. */
function decodeData(message: MessageWithData): Buffer | null {
  if (message.data) {
    return Buffer.from(message.data, 'base64');
  }
  return null;
}

export = {
  encode,
  MessageDecoder,
  MessageType,
  createAttachMessage,
  createDetachMessage,
  createResizeMessage,
  createSignalMessage,
  createStdinMessage,
  createOutputMessage,
  createHistoryMessage,
  createStateMessage,
  createExitMessage,
  createErrorMessage,
  decodeData,
  MAX_MESSAGE_SIZE,
};
