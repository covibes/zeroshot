/**
 * Private parent -> detached-watcher prompt channel.
 *
 * The OMP prompt is task content (repository text, instructions, whatever a caller pasted in), so
 * it must never travel in the watcher's argv: `ps` and /proc/<pid>/cmdline expose argv to every
 * local user for the entire lifetime of a long-lived watcher. task-lib/runner.js therefore hands
 * the prompt to task-lib/rpc-watcher.js over the anonymous stdin pipe fork() creates for it. The
 * pipe has exactly two ends and no name, so nothing is written to the filesystem, the task log, or
 * the ledger while the prompt is in transit.
 *
 * Framing is a newline-terminated JSON header followed by exactly `promptBytes` UTF-8 bytes. That
 * declared length is what lets the receiver tell a complete payload apart from an absent,
 * truncated, over-long, or over-contract one, so it can fail closed instead of prompting the
 * provider with a partial instruction.
 */

const { TextDecoder } = require('util');

const PROMPT_CHANNEL_KIND = 'zeroshot-watcher-prompt-v1';

// The header is a single short JSON object ({"kind":"...","promptBytes":1048576} is 56 bytes), so a
// peer that never sends a newline must not be able to make the receiver buffer without bound before
// the declared payload length is even known.
const MAX_PROMPT_CHANNEL_HEADER_BYTES = 256;

class WatcherPromptChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WatcherPromptChannelError';
    this.code = code;
  }
}

function encodeWatcherPromptFrame(prompt) {
  const body = Buffer.from(prompt, 'utf8');
  const header = `${JSON.stringify({ kind: PROMPT_CHANNEL_KIND, promptBytes: body.byteLength })}\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), body]);
}

/**
 * Write the framed prompt into the watcher's stdin pipe and close the write end.
 *
 * The receiver owns fail-closed handling for a short or missing payload, so a watcher that already
 * exited (a cancellation requested before spawn closes the read end) has to surface here as a
 * swallowed EPIPE rather than as an unhandled 'error' that would take down the spawning process.
 */
function sendWatcherPrompt(stream, prompt) {
  stream.on('error', () => {});
  stream.end(encodeWatcherPromptFrame(prompt));
}

function parsePromptChannelHeader(headerText, maxBytes) {
  let header;
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new WatcherPromptChannelError(
      'malformed-header',
      'Prompt channel header is not valid JSON.'
    );
  }
  if (header === null || typeof header !== 'object' || header.kind !== PROMPT_CHANNEL_KIND) {
    throw new WatcherPromptChannelError(
      'malformed-header',
      `Prompt channel header is not a ${PROMPT_CHANNEL_KIND} frame.`
    );
  }
  const { promptBytes } = header;
  if (!Number.isSafeInteger(promptBytes) || promptBytes < 0) {
    throw new WatcherPromptChannelError(
      'malformed-header',
      "Prompt channel header has an invalid 'promptBytes' value."
    );
  }
  if (promptBytes > maxBytes) {
    throw new WatcherPromptChannelError(
      'prompt-too-large',
      `Prompt channel declared ${promptBytes} bytes, above the ${maxBytes}-byte contract.`
    );
  }
  return promptBytes;
}

/**
 * Read exactly one framed prompt off `stream`, or reject with a WatcherPromptChannelError.
 *
 * Every rejection path is a fail-closed one: an absent channel, a header that never arrives, a
 * declared length above `maxBytes`, a payload that ends short of (or overruns) the declared length,
 * and invalid UTF-8 all reject rather than resolving with partial text.
 */
function receiveWatcherPrompt(stream, { maxBytes }) {
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== 'function' || stream.isTTY) {
      reject(
        new WatcherPromptChannelError(
          'absent',
          'No private prompt pipe is attached to this watcher.'
        )
      );
      return;
    }

    let buffer = Buffer.alloc(0);
    let declaredBytes = null;
    let settled = false;

    function detach() {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      // destroy() can emit 'error' after the listeners above are gone, which would otherwise throw
      // as an unhandled 'error' event and mask the real channel outcome.
      stream.on('error', () => {});
      try {
        stream.destroy();
      } catch {
        // Already released; nothing further to close.
      }
    }

    function fail(code, message) {
      if (settled) return;
      settled = true;
      detach();
      reject(new WatcherPromptChannelError(code, message));
    }

    function succeed(prompt) {
      if (settled) return;
      settled = true;
      detach();
      resolve(prompt);
    }

    function readHeader() {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        if (buffer.byteLength > MAX_PROMPT_CHANNEL_HEADER_BYTES) {
          fail(
            'malformed-header',
            `Prompt channel header exceeded ${MAX_PROMPT_CHANNEL_HEADER_BYTES} bytes without a newline.`
          );
        }
        return false;
      }
      const headerText = buffer.subarray(0, newlineIndex).toString('utf8');
      buffer = buffer.subarray(newlineIndex + 1);
      try {
        declaredBytes = parsePromptChannelHeader(headerText, maxBytes);
      } catch (error) {
        fail(error.code, error.message);
        return false;
      }
      return true;
    }

    function consume() {
      if (declaredBytes === null && !readHeader()) return;
      if (buffer.byteLength > declaredBytes) {
        fail(
          'overlong-payload',
          `Prompt channel delivered more than the declared ${declaredBytes} bytes.`
        );
        return;
      }
      if (buffer.byteLength < declaredBytes) return;
      let prompt;
      try {
        prompt = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        fail('invalid-utf8', 'Prompt channel payload is not valid UTF-8.');
        return;
      }
      succeed(prompt);
    }

    function onData(chunk) {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    }

    function onEnd() {
      fail(
        'truncated',
        declaredBytes === null
          ? 'Prompt channel closed before a complete header arrived.'
          : `Prompt channel closed after ${buffer.byteLength} of ${declaredBytes} declared bytes.`
      );
    }

    function onError(error) {
      fail('channel-error', `Prompt channel failed: ${error.message}`);
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

module.exports = {
  MAX_PROMPT_CHANNEL_HEADER_BYTES,
  PROMPT_CHANNEL_KIND,
  WatcherPromptChannelError,
  encodeWatcherPromptFrame,
  receiveWatcherPrompt,
  sendWatcherPrompt,
};
