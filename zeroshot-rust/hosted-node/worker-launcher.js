'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { installHostedWorkerConfiguration } = require('./hosted-config');

const configuration = installHostedWorkerConfiguration();
const childEnvironment = {
  HOME: '/tmp/zeroshot-oecp',
  LANG: 'C.UTF-8',
  NODE_ENV: 'production',
  PATH: '/opt/zeroshot/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  ZEROSHOT_HOSTED_REPOSITORY: configuration.repository,
  ZEROSHOT_HOSTED_BASE_REVISION: configuration.baseRevision,
  ZEROSHOT_HOSTED_PROVIDER: configuration.provider,
  ZEROSHOT_HOSTED_MODEL_LEVEL: configuration.modelLevel,
  OPENAI_BASE_URL: configuration.providerEndpoint,
  ZEROSHOT_ISOLATION_PROFILE: 'isolation.prepared-worktree@1',
  ZEROSHOT_PROVIDER_PROFILE: 'provider.hosted-direct@1',
  ...configuration.workerEnvironment,
};
const worker = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
  cwd: process.cwd(),
  env: childEnvironment,
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
