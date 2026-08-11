interface MessageBufferTarget {
  _bufferedMessages?: unknown[];
  _bufferDrainScheduled?: boolean;
  _currentExecution?: Promise<unknown> | null;
  id?: string;
  running: boolean;
  state: string;
}

interface MessageBufferOptions {
  maxBuffered?: number;
  label?: string;
}

type DrainFunction = () => Promise<unknown>;
type MessageHandler = (message: unknown) => Promise<unknown> | unknown;

/**
 * Ensures trigger-matching messages are never dropped just because an
 * agent or subcluster is busy.
 */
function bufferMessage(
  target: MessageBufferTarget,
  message: unknown,
  options: MessageBufferOptions = {}
): void {
  const maxBuffered = options.maxBuffered ?? 200;

  if (!target._bufferedMessages) {
    target._bufferedMessages = [];
  }

  if (target._bufferedMessages.length >= maxBuffered) {
    target._bufferedMessages.shift();
  }

  target._bufferedMessages.push(message);
}

function scheduleDrain(
  target: MessageBufferTarget,
  drainFn: DrainFunction,
  options: MessageBufferOptions = {}
): void {
  if (target._bufferDrainScheduled) {
    return;
  }

  target._bufferDrainScheduled = true;

  const label = options.label || 'MessageBuffer';
  const id = target.id || 'unknown';

  const run = (): void => {
    target._bufferDrainScheduled = false;
    drainFn().catch((error: Error) => {
      console.error(`\n${'='.repeat(80)}`);
      console.error(`🔴 FATAL: ${label} drain crashed (${id})`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Error: ${error.message}`);
      console.error(`Stack: ${error.stack}`);
      console.error(`${'='.repeat(80)}\n`);
      setImmediate(() => {
        throw error;
      });
    });
  };

  const current = target._currentExecution;
  if (current && typeof current.finally === 'function') {
    current.finally(() => setImmediate(run));
    return;
  }

  setImmediate(run);
}

async function drainBufferedMessages(
  target: MessageBufferTarget,
  handleFn: MessageHandler,
  options: MessageBufferOptions = {}
): Promise<void> {
  if (!target.running) {
    return;
  }

  const buffer = target._bufferedMessages;
  if (!buffer || buffer.length === 0) {
    return;
  }

  if (target.state !== 'idle') {
    scheduleDrain(target, () => drainBufferedMessages(target, handleFn, options), options);
    return;
  }

  while (target.running && target.state === 'idle' && buffer.length > 0) {
    const next = buffer.shift();
    await handleFn(next);
  }
}

export = {
  bufferMessage,
  scheduleDrain,
  drainBufferedMessages,
};
