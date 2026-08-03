export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
  error: (kind: 'size' | 'json') => Error,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw error('size');
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    try {
      return JSON.parse('');
    } catch {
      throw error('json');
    }
  }

  const declaredBytes = declared === null ? 0 : Number(declared);
  let bytes = new Uint8Array(Math.min(maxBytes, Math.max(declaredBytes, 8 * 1024)));
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
      const capacity = Math.min(
        maxBytes,
        Math.max(nextTotal, Math.max(bytes.byteLength * 2, 8 * 1024)),
      );
      const grown = new Uint8Array(capacity);
      grown.set(bytes.subarray(0, total));
      bytes = grown;
    }
    bytes.set(value, total);
    total = nextTotal;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)),
    );
  } catch {
    throw error('json');
  }
}
