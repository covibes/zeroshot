import { MAX_LINE_BYTES, type SourceSpan } from './semantic-contract';

type LineConsumer = (line: Buffer | null, source: SourceSpan) => void;

export class BoundedLineScanner {
  private readonly parts: Buffer[] = [];
  private lineBytes = 0;
  private lineStart = 0;
  private lineNumber = 1;
  private oversized = false;

  constructor(private readonly consumeLine: LineConsumer) {}

  consume(chunk: Buffer, absoluteStart: number): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      this.append(chunk.subarray(offset, end));
      if (newline === -1) return;
      this.flush(absoluteStart + newline);
      offset = newline + 1;
    }
  }

  finish(byteLength: number): void {
    if (this.lineBytes > 0 || this.oversized) this.flush(byteLength);
  }

  private append(part: Buffer): void {
    this.lineBytes += part.length;
    if (this.lineBytes > MAX_LINE_BYTES) {
      this.oversized = true;
      this.parts.length = 0;
      return;
    }
    if (!this.oversized && part.length > 0) this.parts.push(part);
  }

  private flush(byteEnd: number): void {
    const source: SourceSpan = {
      line_number: this.lineNumber,
      byte_start: this.lineStart,
      byte_end: byteEnd,
      timestamp_ms: null,
    };
    this.consumeLine(this.oversized ? null : Buffer.concat(this.parts, this.lineBytes), source);
    this.parts.length = 0;
    this.lineBytes = 0;
    this.lineStart = byteEnd + 1;
    this.lineNumber += 1;
    this.oversized = false;
  }
}
