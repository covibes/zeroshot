'use strict';

const { probeRuntimeProviderCli } = require('../../lib/agent-cli-provider');
const { loadInstalledHostedWorkerConfiguration } = require('./hosted-config');

try {
  const config = loadInstalledHostedWorkerConfiguration();
  if (!probeRuntimeProviderCli(config.executable, undefined, config.settings).available) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
