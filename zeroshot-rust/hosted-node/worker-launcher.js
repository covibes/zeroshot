'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installHostedWorkerConfiguration } = require('./hosted-config');

const HOME = '/tmp/zeroshot-oecp';
const configuration = installHostedWorkerConfiguration();
if (configuration.provider === 'codex') {
  const credentialName = Object.keys(configuration.workerEnvironment).find(
    (name) => name !== 'GH_TOKEN'
  );
  if (credentialName === undefined) throw new Error('Hosted provider credential is unavailable');
  const configDirectory = path.join(HOME, '.codex');
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configDirectory, 'config.toml'),
    [
      'model_provider = "zeroshot_hosted"',
      '[model_providers.zeroshot_hosted]',
      'name = "Zeroshot Hosted"',
      `base_url = ${JSON.stringify(configuration.providerEndpoint)}`,
      `env_key = ${JSON.stringify(credentialName)}`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'supports_websockets = false',
      '[shell_environment_policy]',
      'inherit = "core"',
      'ignore_default_excludes = false',
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
}
const childEnvironment = {
  HOME,
  LANG: 'C.UTF-8',
  NODE_ENV: 'production',
  PATH: '/opt/zeroshot/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  TMPDIR: HOME,
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
