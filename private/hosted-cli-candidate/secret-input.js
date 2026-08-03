'use strict';

const { spawn } = require('node:child_process');

const MAX_SECRET_BYTES = 4096;
const MAX_GH_OUTPUT_BYTES = 32 * 1024;

function spawnBounded(command, args, maxBytes = MAX_GH_OUTPUT_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const collect = (chunks, isStdout) => (chunk) => {
      const copy = Buffer.from(chunk);
      if (isStdout) stdoutBytes += copy.length;
      else stderrBytes += copy.length;
      if (stdoutBytes + stderrBytes > maxBytes) {
        overflow = true;
        copy.fill(0);
        child.kill('SIGKILL');
        return;
      }
      chunks.push(copy);
    };
    child.stdout.on('data', collect(stdout, true));
    child.stderr.on('data', collect(stderr, false));
    child.once('error', (error) =>
      reject(new Error(`${command} is unavailable`, { cause: error }))
    );
    child.once('close', (code) => {
      const out = Buffer.concat(stdout, stdoutBytes);
      const err = Buffer.concat(stderr, stderrBytes);
      for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
      if (overflow) {
        out.fill(0);
        err.fill(0);
        reject(new Error(`${command} output exceeded the safety bound`));
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function trimmedSecret(buffer, label) {
  let start = 0;
  let end = buffer.length;
  while (
    start < end &&
    (buffer[start] === 0x20 ||
      buffer[start] === 0x09 ||
      buffer[start] === 0x0a ||
      buffer[start] === 0x0d)
  )
    start += 1;
  while (
    end > start &&
    (buffer[end - 1] === 0x20 ||
      buffer[end - 1] === 0x09 ||
      buffer[end - 1] === 0x0a ||
      buffer[end - 1] === 0x0d)
  )
    end -= 1;
  if (end === start || end - start > MAX_SECRET_BYTES)
    throw new Error(`${label} is empty or exceeds the safety bound`);
  return Buffer.from(buffer.subarray(start, end));
}

class PromptInput {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.iterator = input[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
  }

  async line(prompt, { secret = false, maxBytes = MAX_SECRET_BYTES } = {}) {
    this.output.write(prompt);
    if (secret && this.input.isTTY && typeof this.input.setRawMode === 'function') {
      return this.#rawSecret(maxBytes);
    }
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline !== -1) {
        const line = Buffer.from(this.pending.subarray(0, newline));
        const rest = Buffer.from(this.pending.subarray(newline + 1));
        this.pending.fill(0);
        this.pending = rest;
        if (line.length > maxBytes) {
          line.fill(0);
          throw new Error('stdin value exceeded the safety bound');
        }
        return line;
      }
      const next = await this.iterator.next();
      if (next.done) {
        if (this.pending.length === 0) throw new Error('stdin ended before the required value');
        const line = this.pending;
        this.pending = Buffer.alloc(0);
        if (line.length > maxBytes) {
          line.fill(0);
          throw new Error('stdin value exceeded the safety bound');
        }
        return line;
      }
      const chunk = Buffer.from(next.value);
      if (this.pending.length + chunk.length > MAX_SECRET_BYTES * 2 + 32) {
        chunk.fill(0);
        this.pending.fill(0);
        this.pending = Buffer.alloc(0);
        throw new Error('stdin exceeded the setup safety bound');
      }
      const combined = Buffer.concat([this.pending, chunk]);
      this.pending.fill(0);
      chunk.fill(0);
      this.pending = combined;
    }
  }

  async #rawSecret(maxBytes) {
    const value = Buffer.alloc(maxBytes);
    let length = 0;
    const wasRaw = Boolean(this.input.isRaw);
    this.input.setRawMode(true);
    this.input.resume();
    try {
      for await (const source of this.iterator) {
        const chunk = Buffer.from(source);
        try {
          for (const byte of chunk) {
            if (byte === 0x03) throw new globalThis.DOMException('setup interrupted', 'AbortError');
            if (byte === 0x0a || byte === 0x0d) {
              this.output.write('\n');
              return Buffer.from(value.subarray(0, length));
            }
            if (byte === 0x7f || byte === 0x08) {
              if (length > 0) length -= 1;
              continue;
            }
            if (length >= maxBytes) throw new Error('secret exceeded the safety bound');
            value[length] = byte;
            length += 1;
          }
        } finally {
          chunk.fill(0);
        }
      }
      throw new Error('stdin ended before the secret');
    } finally {
      value.fill(0);
      this.input.setRawMode(wasRaw);
      this.input.pause();
    }
  }

  clear() {
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
  }
}

module.exports = { MAX_SECRET_BYTES, PromptInput, spawnBounded, trimmedSecret };
