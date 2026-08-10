const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildTelemetry } = require('./foreground-benchmark-result');

function serialized(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function atomicWriteNew(targetPath, content) {
  const directory = path.dirname(targetPath);
  const temporary = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor;
  let published = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, targetPath);
    published = true;
    fs.unlinkSync(temporary);
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    error.atomicTargetPublished = published;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary write error; a leftover randomized temp is non-authoritative.
    }
  }
}

function removeOrphanTelemetry(telemetryPath, primaryError) {
  try {
    fs.unlinkSync(telemetryPath);
  } catch (cleanupError) {
    if (cleanupError.code !== 'ENOENT') primaryError.cleanupError = cleanupError;
  }
}

function writeBenchmarkResultBundle(resultPath, result, snapshot) {
  if (typeof resultPath !== 'string' || resultPath.length === 0) {
    throw new Error('result path must be non-empty text');
  }
  const resolvedResult = path.resolve(resultPath);
  const telemetryPath = `${resolvedResult}.telemetry.json`;
  const telemetry = buildTelemetry(result.runId, snapshot);
  const telemetryBytes = serialized(telemetry);
  atomicWriteNew(telemetryPath, telemetryBytes);
  const receipt = {
    ...result,
    telemetry: {
      artifact: path.basename(telemetryPath),
      byteLength: telemetryBytes.length,
      sha256: crypto.createHash('sha256').update(telemetryBytes).digest('hex'),
    },
  };
  try {
    atomicWriteNew(resolvedResult, serialized(receipt));
  } catch (error) {
    if (!error.atomicTargetPublished) removeOrphanTelemetry(telemetryPath, error);
    throw error;
  }
  return receipt;
}

module.exports = { writeBenchmarkResultBundle };
