const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  OMP_INSTALL_COMMAND,
  OMP_PACKAGE_NAME,
  OMP_RELEASE_ASSETS,
  OMP_SUPPORTED_VERSION,
  findOmpReleaseAsset,
  ompReleaseAssetDownloadUrl,
} = require('../../lib/agent-cli-provider/omp/release');
const {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  OmpRpcFrameDecoder,
  OmpRpcProtocolError,
  assertNoPreNegotiationRpcChunk,
  classifyOmpRpcFrameType,
  encodeOmpRpcCommand,
} = require('../../lib/agent-cli-provider/omp/rpc-protocol');
const {
  exactBoundaryPromptCommand,
  multibyteUtf8PromptCommand,
  oneByteOverPromptCommand,
} = require('../helpers/omp-rpc-boundary-vectors');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'omp-rpc');
const HELPERS_DIR = __dirname;

function fixturePath(name) {
  return path.join(FIXTURES_DIR, `${name}.jsonl`);
}

function readFixture(name) {
  return fs.readFileSync(fixturePath(name));
}

function decodeWhole(limits, buffer) {
  const decoder = new OmpRpcFrameDecoder(limits);
  const frames = [...decoder.push(buffer)];
  decoder.finish();
  return frames;
}

function decodeSplit(limits, buffer, chunkSize) {
  const decoder = new OmpRpcFrameDecoder(limits);
  const frames = [];
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    frames.push(...decoder.push(buffer.subarray(offset, offset + chunkSize)));
  }
  decoder.finish();
  return frames;
}

function assertProtocolError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OmpRpcProtocolError, `expected OmpRpcProtocolError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const HAPPY_PATH_SCENARIOS = [
  'negotiate-v2',
  'request-response',
  'event-before-ack',
  'same-id-late-failure',
  'lifecycle-continuation',
  'compacted-agent-end',
  'chunked-response',
  'extension-ui-request',
  'stderr-emission.stdout',
  'early-shutdown',
  'extension-shutdown',
];

const TEST_LIMITS = {
  maxPhysicalFrameBytes: 65536,
  maxReassembledFrameBytes: 4096,
  maxConcurrentReassemblies: 1,
  maxChunksPerFrame: 8,
  maxInflightReassemblyBytes: 4096,
};

function chunkLine(overrides) {
  return `${JSON.stringify({ type: 'rpc_chunk', ...overrides })}\n`;
}

function twoChunkPayload(jsonText) {
  const bytes = Buffer.from(jsonText, 'utf8');
  const half = Math.max(1, Math.ceil(bytes.byteLength / 2));
  const first = bytes.subarray(0, half);
  const second = bytes.subarray(half);
  return { byteLength: bytes.byteLength, first, second };
}

function fillNegotiateCommandToExactBytes(targetBytes) {
  const base = { id: 'boundary-cmd', type: 'negotiate_protocol', protocolVersion: 2, note: '' };
  const baselineBytes = Buffer.byteLength(`${JSON.stringify({ ...base, note: '' })}\n`, 'utf8');
  if (targetBytes < baselineBytes) {
    throw new Error(
      `targetBytes ${targetBytes} is smaller than the unpadded command size ${baselineBytes}`
    );
  }
  const command = { ...base, note: 'a'.repeat(targetBytes - baselineBytes) };
  const actualBytes = Buffer.byteLength(`${JSON.stringify(command)}\n`, 'utf8');
  if (actualBytes !== targetBytes) {
    throw new Error(`Padding produced ${actualBytes} bytes, expected ${targetBytes}.`);
  }
  return command;
}

module.exports = {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  HAPPY_PATH_SCENARIOS,
  FIXTURES_DIR,
  HELPERS_DIR,
  OMP_INSTALL_COMMAND,
  OMP_PACKAGE_NAME,
  OMP_RELEASE_ASSETS,
  OMP_SUPPORTED_VERSION,
  OmpRpcFrameDecoder,
  TEST_LIMITS,
  assert,
  assertNoPreNegotiationRpcChunk,
  assertProtocolError,
  chunkLine,
  classifyOmpRpcFrameType,
  decodeSplit,
  decodeWhole,
  encodeOmpRpcCommand,
  exactBoundaryPromptCommand,
  fillNegotiateCommandToExactBytes,
  findOmpReleaseAsset,
  fs,
  fixturePath,
  multibyteUtf8PromptCommand,
  ompReleaseAssetDownloadUrl,
  oneByteOverPromptCommand,
  path,
  readFixture,
  spawn,
  twoChunkPayload,
};
