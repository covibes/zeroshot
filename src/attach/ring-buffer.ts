/**
 * RingBuffer - Fixed-size circular buffer for output history
 *
 * Used by AttachServer to store recent output for late-joining clients.
 * When buffer fills, oldest data is overwritten.
 *
 * Design:
 * - Fixed allocation (no dynamic resizing)
 * - O(1) write and read operations
 * - Thread-safe for single writer (Node.js is single-threaded)
 */

class RingBuffer {
  buffer: Buffer;
  maxSize: number;
  writePos: number;
  size: number;

  /**
   * @param maxSize - Maximum buffer size in bytes (default 1MB)
   */
  constructor(maxSize = 1024 * 1024) {
    if (maxSize <= 0) {
      throw new Error('RingBuffer maxSize must be positive');
    }
    this.buffer = Buffer.alloc(maxSize);
    this.maxSize = maxSize;
    this.writePos = 0; // Next write position
    this.size = 0; // Current data size (0 to maxSize)
  }

  /** Write data to the buffer. */
  write(data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buf.length === 0) return;

    // If data is larger than buffer, only keep the last maxSize bytes
    if (buf.length >= this.maxSize) {
      buf.copy(this.buffer, 0, buf.length - this.maxSize);
      this.writePos = 0;
      this.size = this.maxSize;
      return;
    }

    // Calculate how much wraps around
    const spaceToEnd = this.maxSize - this.writePos;

    if (buf.length <= spaceToEnd) {
      // No wrap needed
      buf.copy(this.buffer, this.writePos);
      this.writePos += buf.length;
    } else {
      // Wrap around
      buf.copy(this.buffer, this.writePos, 0, spaceToEnd);
      buf.copy(this.buffer, 0, spaceToEnd);
      this.writePos = buf.length - spaceToEnd;
    }

    // Update size (capped at maxSize)
    this.size = Math.min(this.size + buf.length, this.maxSize);
  }

  /** Read all buffered data. */
  read(): Buffer {
    if (this.size === 0) {
      return Buffer.alloc(0);
    }

    const result = Buffer.alloc(this.size);

    if (this.size < this.maxSize) {
      // Buffer not full yet, data starts at 0
      this.buffer.copy(result, 0, 0, this.size);
    } else {
      // Buffer is full, data starts at writePos (oldest data)
      const startPos = this.writePos;
      const firstChunkSize = this.maxSize - startPos;

      this.buffer.copy(result, 0, startPos, this.maxSize);
      this.buffer.copy(result, firstChunkSize, 0, startPos);
    }

    return result;
  }

  /** Clear the buffer. */
  clear(): void {
    this.writePos = 0;
    this.size = 0;
  }

  /** Get current data size. */
  getSize(): number {
    return this.size;
  }

  /** Check if buffer is empty. */
  isEmpty(): boolean {
    return this.size === 0;
  }

  /** Check if buffer is full. */
  isFull(): boolean {
    return this.size === this.maxSize;
  }
}

export = RingBuffer;
