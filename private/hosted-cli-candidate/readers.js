'use strict';

const fs = require('node:fs');
const { TextDecoder } = require('node:util');

const MAX_GRAPH_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;

function validateFilePath(filePath, label) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath === '-') {
    throw new Error(`${label} must be an explicit JSON file path`);
  }
}

async function openNoFollow(filePath, label) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  try {
    return await fs.promises.open(filePath, flags);
  } catch (error) {
    if (error && error.code === 'ELOOP') {
      throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  }
}

function validateFileSize(stat, label, maxBytes) {
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte bound or is empty`);
  }
}

async function readExactBytes(handle, bytes, size, label) {
  let offset = 0;
  while (offset <= size) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
    if (offset > size) throw new Error(`${label} changed while it was read`);
  }
  if (offset !== size) throw new Error(`${label} changed while it was read`);
}

function parseJsonBytes(bytes, size, label) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readBoundedJsonFile(filePath, label, maxBytes) {
  validateFilePath(filePath, label);
  let handle;
  let bytes;
  try {
    handle = await openNoFollow(filePath, label);
    const stat = await handle.stat();
    validateFileSize(stat, label, maxBytes);
    bytes = Buffer.allocUnsafe(stat.size + 1);
    await readExactBytes(handle, bytes, stat.size, label);
    return parseJsonBytes(bytes, stat.size, label);
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

async function readHostedInputs(graphPath, inputPath, assertGraphSpec) {
  const graph = await readBoundedJsonFile(graphPath, 'graph', MAX_GRAPH_BYTES);
  assertGraphSpec(graph);
  if (
    graph.profile !== 'openengine.graph.single-worker/v1' ||
    graph.root?.kind !== 'step' ||
    graph.root.worker !== 'legacy.zeroshot.ship@1' ||
    graph.root.attempts !== 1
  ) {
    throw new Error(
      'hosted run requires exactly openengine.graph.single-worker/v1 with one legacy.zeroshot.ship@1 attempt'
    );
  }
  const input = await readBoundedJsonFile(inputPath, 'input', MAX_INPUT_BYTES);
  return Object.freeze({ graph, input });
}

module.exports = {
  MAX_GRAPH_BYTES,
  MAX_INPUT_BYTES,
  readBoundedJsonFile,
  readHostedInputs,
};
