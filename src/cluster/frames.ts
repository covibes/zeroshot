export type FrameRecord = Readonly<Record<string, unknown>>;

export type BoundedFrameText =
  | { readonly kind: 'frame'; readonly text: string; readonly bytes: number }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'unsupported' };

function boundedUtf8Length(value: string, maximum: number): number | undefined {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else { bytes += 4; index += 1; }
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

export function boundedFrameText(event: unknown, maximum: number): BoundedFrameText {
  const candidate = event && typeof event === 'object' && 'data' in event
    ? event.data
    : event;
  if (typeof candidate === 'string') {
    const bytes = boundedUtf8Length(candidate, maximum);
    return bytes === undefined ? { kind: 'oversized' } : { kind: 'frame', text: candidate, bytes };
  }
  if (candidate instanceof ArrayBuffer) {
    if (candidate.byteLength > maximum) return { kind: 'oversized' };
    return { kind: 'frame', text: new TextDecoder().decode(candidate), bytes: candidate.byteLength };
  }
  if (ArrayBuffer.isView(candidate)) {
    if (candidate.byteLength > maximum) return { kind: 'oversized' };
    const view = new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
    return { kind: 'frame', text: new TextDecoder().decode(view), bytes: candidate.byteLength };
  }
  return { kind: 'unsupported' };
}

export function isRecord(value: unknown): value is FrameRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
