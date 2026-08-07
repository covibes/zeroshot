'use strict';

const { spawn } = require('node:child_process');
const { loadHostedWorkerConfiguration } = require('./hosted-config');
const { provisionRuntimeCapability } = require('./runtime-capability');
const { cloneFixedRepository } = require('./workspace-bootstrap');

const SERVER = '/usr/local/bin/zeroshot-oecp-server';

async function main() {
  await provisionRuntimeCapability();
  const configuration = loadHostedWorkerConfiguration();
  await cloneFixedRepository(configuration);
  const server = spawn(SERVER, [], { env: process.env, stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.kill(signal));
  }
  server.once('error', () => {
    process.exitCode = 1;
  });
  server.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

main().catch(() => {
  process.stderr.write('Hosted capsule initialization failed\n');
  process.exitCode = 1;
});
