'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const worker = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
worker.once('error', () => {
  process.exitCode = 1;
});
worker.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
