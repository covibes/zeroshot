/**
 * Pure builders for byte-exact `encodeOmpRpcCommand` stdin command payloads.
 * Padding uses ASCII 'a' (1 byte/char) so the target byte count is reachable exactly;
 * the multibyte variant mixes in a 4-byte-UTF-8 emoji (2 UTF-16 code units) to prove
 * the byte accounting, not `.length`, governs the boundary.
 */

function jsonLineByteLength(command) {
  return Buffer.byteLength(`${JSON.stringify(command)}\n`, 'utf8');
}

function fillToExactBytes(base, fillerKey, targetBytes) {
  const baseline = { ...base, [fillerKey]: '' };
  const baselineBytes = jsonLineByteLength(baseline);
  if (targetBytes < baselineBytes) {
    throw new Error(
      `targetBytes ${targetBytes} is smaller than the unpadded command size ${baselineBytes}`
    );
  }
  const command = { ...base, [fillerKey]: 'a'.repeat(targetBytes - baselineBytes) };
  const actualBytes = jsonLineByteLength(command);
  if (actualBytes !== targetBytes) {
    throw new Error(`Padding produced ${actualBytes} bytes, expected ${targetBytes}.`);
  }
  return command;
}

function exactBoundaryPromptCommand(maxFrameBytes) {
  return fillToExactBytes(
    { id: 'boundary-cmd', type: 'prompt', message: '' },
    'message',
    maxFrameBytes
  );
}

function oneByteOverPromptCommand(maxFrameBytes) {
  return fillToExactBytes(
    { id: 'boundary-cmd', type: 'prompt', message: '' },
    'message',
    maxFrameBytes + 1
  );
}

function multibyteUtf8PromptCommand(maxFrameBytes) {
  const emoji = '\u{1F642}'; // 4 UTF-8 bytes, 2 UTF-16 code units
  const base = { id: 'boundary-cmd', type: 'prompt', message: '' };
  const baselineBytes = jsonLineByteLength(base);
  const available = maxFrameBytes - baselineBytes;
  if (available < 4) {
    throw new Error(`maxFrameBytes ${maxFrameBytes} leaves no room for a multibyte filler.`);
  }
  const emojiCount = Math.floor(available / 4);
  const remainderBytes = available - emojiCount * 4;
  const message = emoji.repeat(emojiCount) + 'a'.repeat(remainderBytes);
  const command = { ...base, message };
  const actualBytes = jsonLineByteLength(command);
  if (actualBytes !== maxFrameBytes) {
    throw new Error(`Multibyte filler produced ${actualBytes} bytes, expected ${maxFrameBytes}.`);
  }
  return command;
}

module.exports = {
  exactBoundaryPromptCommand,
  oneByteOverPromptCommand,
  multibyteUtf8PromptCommand,
};
