'use strict';

const fs = require('fs');

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

module.exports = { readCapabilityFile, resolveTransportCapability, validateCapability };
