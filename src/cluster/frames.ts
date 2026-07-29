export type FrameRecord = Readonly<Record<string, unknown>>;

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function frameText(event: unknown): string | undefined {
  const candidate = event && typeof event === 'object' && 'data' in event
    ? event.data
    : event;
  if (typeof candidate === 'string') return candidate;
  if (candidate instanceof ArrayBuffer) return new TextDecoder().decode(candidate);
  if (ArrayBuffer.isView(candidate)) {
    return new TextDecoder().decode(
      new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength),
    );
  }
  return undefined;
}

export function isRecord(value: unknown): value is FrameRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
