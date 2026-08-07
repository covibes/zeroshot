'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITY_SOURCE_PATH = '/run/zeroshot-bootstrap-source';
const MIN_CAPABILITY_BYTES = 32;
const MAX_CAPABILITY_BYTES = 256;
const MAX_CAPABILITY_FILE_BYTES = MAX_CAPABILITY_BYTES + 2;

function validateCapability(capability) {
  if (
    typeof capability !== 'string' ||
    capability.length < MIN_CAPABILITY_BYTES ||
    capability.length > MAX_CAPABILITY_BYTES ||
    !/^[!-~]+$/.test(capability)
  ) {
    throw new Error('OECP transport capability must be 32-256 ASCII graphic bytes');
  }
  return capability;
}

function assertProtectedFile(stat) {
  const protectedRegularFile =
    stat.isFile() &&
    stat.nlink === 1 &&
    (stat.mode & 0o7777) === 0o400 &&
    stat.size <= MAX_CAPABILITY_FILE_BYTES;
  if (!protectedRegularFile) {
    throw new Error('OECP transport capability file is not a protected bounded regular file');
  }
}

function readExact(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== bytes.length) {
    throw new Error('OECP transport capability file changed while it was read');
  }
  return bytes;
}

function decodeCapability(bytes) {
  let capability = bytes.toString('utf8');
  if (capability.endsWith('\r\n')) capability = capability.slice(0, -2);
  else if (capability.endsWith('\n')) capability = capability.slice(0, -1);
  return validateCapability(capability);
}

function readCapabilityFile(capabilityFile) {
  if (typeof capabilityFile !== 'string' || capabilityFile.length === 0) {
    throw new Error('ZEROSHOT_OECP_CAPABILITY_FILE must select a capability file');
  }
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const descriptor = fs.openSync(capabilityFile, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    assertProtectedFile(stat);
    return decodeCapability(readExact(descriptor, stat.size));
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveTransportCapability(options = {}, environment = process.env) {
  if (options.capability !== undefined) return validateCapability(options.capability);
  const capabilityFile = options.capabilityFile ?? environment.ZEROSHOT_OECP_CAPABILITY_FILE;
  if (capabilityFile === undefined) {
    throw new Error('OECP transport capability is required');
  }
  return readCapabilityFile(capabilityFile);
}

function deliverCapability(tag, name, capabilityFile) {
  const script = `
    const fs = require('node:fs');
    const net = require('node:net');
    const capability = fs.readFileSync('${CAPABILITY_SOURCE_PATH}', 'ascii');
    const deadline = Date.now() + 5000;
    let active;
    let settled = false;
    const overall = setTimeout(() => finish(false), 5000);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      active?.destroy();
      process.exitCode = ok ? 0 : 1;
    }
    function connect() {
      if (settled) return;
      let response = '';
      const socket = net.createConnection({ host: '127.0.0.1', port: 8086 });
      active = socket;
      let connected = false;
      let ended = false;
      socket.setTimeout(1000, () => finish(false));
      socket.once('connect', () => {
        connected = true;
        socket.end(capability);
      });
      socket.on('data', (chunk) => {
        response += chunk.toString('ascii');
        if (response.length > 3) finish(false);
      });
      socket.once('end', () => {
        ended = true;
        finish(response === 'OK\\n');
      });
      socket.once('error', () => {
        if (connected || Date.now() >= deadline) finish(false);
        else setTimeout(connect, 25);
      });
      socket.once('close', () => {
        if (connected && !ended) finish(false);
      });
    }
    connect();
  `;
  const delivered = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      `container:${name}`,
      '--mount',
      `type=bind,src=${capabilityFile},dst=${CAPABILITY_SOURCE_PATH},readonly`,
      '--entrypoint',
      '/usr/local/bin/node',
      tag,
      '-e',
      script,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
    }
  );
  if (delivered.error || delivered.status !== 0) {
    throw new Error('Hosted image capability bootstrap failed');
  }
}

module.exports = {
  deliverCapability,
  readCapabilityFile,
  resolveTransportCapability,
  validateCapability,
};
