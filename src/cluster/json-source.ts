import { ClusterRequestError } from './errors.js';
import { MAX_FRAME_BYTES } from './generated/protocol.js';

export const MAX_REQUEST_BYTES = MAX_FRAME_BYTES;

export function decodeBoundedJson(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_REQUEST_BYTES) {
    throw new ClusterRequestError(
      `request payload of ${bytes.length} bytes exceeds the ${MAX_REQUEST_BYTES} byte limit`,
      'OVERSIZED_JSON',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ClusterRequestError('request payload is not valid UTF-8', 'INVALID_UTF8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ClusterRequestError('request payload is not valid JSON', 'MALFORMED_JSON');
  }
}

// Callers resolve `--graph`/`--input` specifiers ('-' vs. a file path) to a byte
// source themselves; opening the filesystem stream stays outside src/cluster so this
// module keeps no host-specific dependency (not even the `NodeJS` ambient namespace,
// which isn't resolvable from a consumer's declaration-only install) beyond the
// standard async-iterable protocol every Node Readable already implements — mirrors
// how WebSocketLike is injected instead of importing 'ws' directly, see socket.ts.
export async function readBoundedSource(
  source: AsyncIterable<Uint8Array | string>,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new ClusterRequestError(
        `request payload exceeds the ${MAX_REQUEST_BYTES} byte limit`,
        'OVERSIZED_JSON',
      );
    }
    chunks.push(bytes);
  }
  const assembled = new Uint8Array(total);
  let offset = 0;
  for (const bytes of chunks) {
    assembled.set(bytes, offset);
    offset += bytes.length;
  }
  return assembled;
}

export function assertDistinctRequestSources(
  graph: string,
  input: string | undefined,
): asserts input is string {
  if (input === undefined) {
    throw new ClusterRequestError('--input is required for every hosted run', 'MISSING_INPUT');
  }
  if (graph === '-' && input === '-') {
    throw new ClusterRequestError(
      'graph and input cannot both read from stdin',
      'AMBIGUOUS_STDIN_SOURCE',
    );
  }
}
