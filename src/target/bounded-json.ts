interface BoundedJsonErrors {
  readonly tooLarge: () => Error;
  readonly invalid: () => Error;
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  errors: BoundedJsonErrors
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw errors.tooLarge();

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw errors.tooLarge();
    return parseJson(bytes, errors);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw errors.tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJson(bytes, errors);
}

function parseJson(bytes: Uint8Array, errors: BoundedJsonErrors): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw errors.invalid();
  }
}
