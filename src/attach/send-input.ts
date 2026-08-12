/**
 * sendInput - write stdin data to a live attach socket
 *
 * Uses the attach protocol's STDIN message to forward input to the PTY.
 * Returns { ok, error } instead of throwing on transport failures.
 */

import fs from 'node:fs';
import net from 'node:net';

import protocol from './protocol';

const DEFAULT_TIMEOUT_MS = 1500;

interface SendInputOptions {
  socketPath?: string;
  data?: Buffer | string | null;
  timeoutMs?: number;
}

interface SendInputResult {
  ok: boolean;
  error: string | null;
}

/** Send input to an attach socket via STDIN message. */
function sendInput(options: SendInputOptions = {}): Promise<SendInputResult> | SendInputResult {
  const { socketPath, data, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!socketPath) {
    throw new Error('sendInput: socketPath is required');
  }

  if (data === undefined || data === null) {
    throw new Error('sendInput: data is required');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`sendInput: timeoutMs must be positive (got ${timeoutMs})`);
  }

  if (!fs.existsSync(socketPath)) {
    return { ok: false, error: `Socket not found: ${socketPath}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const socket = net.createConnection(socketPath);

    const finish = (result: SendInputResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        socket.end();
        socket.destroy();
      } catch (cleanupError: unknown) {
        console.warn('[sendInput] socket cleanup failed:', cleanupError);
      }
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ ok: false, error: 'Timeout waiting for socket connection' });
    }, timeoutMs);

    socket.on('connect', () => {
      try {
        const encoded = protocol.encode(protocol.createStdinMessage(data));
        socket.write(encoded, (error?: Error | null) => {
          if (error) {
            finish({ ok: false, error: error.message });
          } else {
            finish({ ok: true, error: null });
          }
        });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        finish({ ok: false, error: reason });
      }
    });

    socket.on('error', (error: Error) => {
      finish({ ok: false, error: error.message });
    });
  });
}

export = {
  sendInput,
};
