#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectTarget } = require('../lib/install');

try {
  const { executable } = selectTarget();
  const binary = path.join(__dirname, 'native', executable);
  if (!fs.existsSync(binary)) {
    throw new Error(`NATIVE_BINARY_MISSING: ${binary}; reinstall @the-open-engine/zeroshot-rust`);
  }
  const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status === null ? 1 : result.status;
} catch (error) {
  process.stderr.write(`zeroshot-rust: ${error.message}\n`);
  process.exitCode = 1;
}
