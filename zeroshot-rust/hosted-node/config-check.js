'use strict';

const {
  prepareSingleAgentProviderCommand,
  probeRuntimeProviderCli,
} = require('../../lib/agent-cli-provider');
const { createCommandSpecCleanup } = require('../../src/command-cleanup-ownership');
const { loadInstalledHostedWorkerConfiguration } = require('./hosted-config');

try {
  const config = loadInstalledHostedWorkerConfiguration();
  if (!probeRuntimeProviderCli(config.executable, undefined, config.settings).available) {
    throw new Error('hosted executable is unavailable');
  }
  const prepared = prepareSingleAgentProviderCommand(
    {
      context: 'Validate the installed hosted provider runtime.',
      provider: config.executable,
      options: {
        ...(config.executable === 'omp' ? {} : { authEnv: config.runtimeEnvironment }),
        autoApprove: true,
        cwd: process.cwd(),
        executionContext: 'docker',
        ...(config.model === undefined ? {} : { modelSpec: { model: config.model } }),
      },
    },
    config.settings
  );
  const ownsCleanup =
    Array.isArray(prepared.commandSpec.cleanup) && prepared.commandSpec.cleanup.length > 0;
  if (ownsCleanup && !createCommandSpecCleanup(prepared.commandSpec, () => {}).runSync()) {
    throw new Error('hosted provider preflight cleanup failed');
  }
} catch {
  process.exitCode = 1;
}
