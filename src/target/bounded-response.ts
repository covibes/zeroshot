async function declaredResponseBytes(
  response: Response,
  maxBytes: number,
  error: (kind: 'size' | 'json') => Error,
): Promise<number> {
  const declared = response.headers.get('content-length');
  if (declared === null) return 0;
  if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw error('size');
  }
  return Number(declared);
}

function growBuffer(
  bytes: Uint8Array,
  required: number,
  used: number,
  maxBytes: number,
): Uint8Array {
  const capacity = Math.min(
    maxBytes,
    Math.max(required, Math.max(bytes.byteLength * 2, 8 * 1024)),
  );
  const grown = new Uint8Array(capacity);
  grown.set(bytes.subarray(0, used));
  return grown;
}

function decodeJson(
  bytes: Uint8Array,
  error: (kind: 'size' | 'json') => Error,
): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw error('json');
  }
}

export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
  error: (kind: 'size' | 'json') => Error,
): Promise<unknown> {
  const declaredBytes = await declaredResponseBytes(response, maxBytes, error);
  const reader = response.body?.getReader();
  if (reader === undefined) return decodeJson(new Uint8Array(), error);
  let bytes: Uint8Array = new Uint8Array(
    Math.min(maxBytes, Math.max(declaredBytes, 8 * 1024)),
  );
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const nextTotal = total + value.byteLength;
    if (nextTotal > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw error('size');
    }
    if (nextTotal > bytes.byteLength) {
      bytes = growBuffer(bytes, nextTotal, total, maxBytes);
    }
    bytes.set(value, total);
    total = nextTotal;
  }
  return decodeJson(bytes.subarray(0, total), error);
}
