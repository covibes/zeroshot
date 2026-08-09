'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDirectory, removeTempDirectory } = require('../helpers/temp-directory');
const {
  HostedConfigError,
  loadInstalledHostedWorkerConfiguration,
} = require('../../zeroshot-rust/hosted-node/hosted-config');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIGURATION_CHECK = path.join(ROOT, 'zeroshot-rust', 'hosted-node', 'config-check.js');

function runConfigurationCheck(environment) {
  return spawnSync(process.execPath, [CONFIGURATION_CHECK], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
  });
}

function fixture() {
  const directory = createTempDirectory('zeroshot-hosted-config-');
  const settingsFile = path.join(directory, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      defaultProvider: 'future-provider',
      providerSettings: { 'future-provider': { endpoint: 'https://models.example' } },
    })
  );
  return {
    directory,
    environment: {
      GH_TOKEN: 'git-canary',
      GITHUB_TOKEN: 'git-canary',
      HOME: '/tmp/zeroshot-oecp/runtime',
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
      PATH: process.env.PATH,
      TMPDIR: '/tmp/zeroshot-oecp/runtime/tmp',
      ZEROSHOT_HOSTED_REPOSITORY: 'the-open-engine/zeroshot',
      ZEROSHOT_HOSTED_BASE_REVISION: 'a'.repeat(40),
      ZEROSHOT_HOSTED_DELIVERY_MODE: 'pr',
      ZEROSHOT_HOSTED_DELIVERY_TARGET: 'main',
      ZEROSHOT_HOSTED_DELIVERY_VERSION: 'zeroshot.delivery/v1',
      ZEROSHOT_HOSTED_EXECUTABLE: 'codex',
      ZEROSHOT_HOSTED_EXEC_ROOT: '/workspace/.git/zeroshot-runtime',
      ZEROSHOT_HOSTED_PROVIDER: 'future-provider',
      ZEROSHOT_HOSTED_MODEL: 'future/model',
      ZEROSHOT_ISOLATION_PROFILE: 'isolation.prepared-worktree@1',
      ZEROSHOT_PROVIDER_PROFILE: 'provider.hosted-direct@1',
      ZEROSHOT_SETTINGS_FILE: settingsFile,
      FUTURE_PROVIDER_TOKEN: 'provider-canary',
      FUTURE_PROVIDER_ENDPOINT: 'https://models.example',
    },
  };
}

describe('hosted worker runtime boundary', () => {
  it('accepts an arbitrary resolved runtime without provider or credential allowlists', () => {
    const { directory, environment } = fixture();
    try {
      const config = loadInstalledHostedWorkerConfiguration(environment);
      assert.equal(config.executable, 'codex');
      assert.equal(config.provider, 'future-provider');
      assert.equal(config.model, 'future/model');
      assert.deepEqual(config.delivery, {
        version: 'zeroshot.delivery/v1',
        mode: 'pr',
        repository: 'the-open-engine/zeroshot',
        targetBranch: 'main',
        baseRevision: 'a'.repeat(40),
      });
      assert.deepEqual(config.runtimeEnvironment, {
        FUTURE_PROVIDER_TOKEN: 'provider-canary',
        FUTURE_PROVIDER_ENDPOINT: 'https://models.example',
      });
      assert.deepEqual(config.settings, {
        defaultProvider: 'future-provider',
        providerSettings: {
          'future-provider': { endpoint: 'https://models.example' },
        },
      });
      assert.equal(Object.hasOwn(config.runtimeEnvironment, 'GH_TOKEN'), false);
    } finally {
      removeTempDirectory(directory);
    }
  });

  it('rejects malformed runtime authority without exposing environment values', () => {
    const { directory, environment } = fixture();
    try {
      for (const patch of [
        { ZEROSHOT_HOSTED_REPOSITORY: 'owner/repository/extra' },
        { ZEROSHOT_HOSTED_BASE_REVISION: 'not-a-commit' },
        { ZEROSHOT_HOSTED_DELIVERY_MODE: 'none' },
        { ZEROSHOT_HOSTED_EXECUTABLE: 'command with spaces' },
        { ZEROSHOT_HOSTED_PROVIDER: 'provider with spaces' },
        { ZEROSHOT_HOSTED_MODEL: '' },
        { ZEROSHOT_SETTINGS_FILE: '/missing/settings.json' },
      ]) {
        assert.throws(
          () => loadInstalledHostedWorkerConfiguration({ ...environment, ...patch }),
          (error) => {
            assert.ok(error instanceof HostedConfigError);
            assert.equal(error.code, 'HOSTED_CONFIGURATION_INVALID');
            assert.doesNotMatch(`${error.message}\n${error.stack}`, /canary/);
            return true;
          }
        );
      }
    } finally {
      removeTempDirectory(directory);
    }
  });
});

describe('hosted worker runtime preflight', () => {
  it('uses the provider registry to preflight process and bundled runtimes', () => {
    const { directory, environment } = fixture();
    const settingsFile = environment.ZEROSHOT_SETTINGS_FILE;
    const fakeOmp = path.join(directory, 'omp');
    try {
      fs.writeFileSync(
        fakeOmp,
        '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "omp help"; exit 0; fi\nexit 1\n',
        { mode: 0o700 }
      );
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ providerSettings: { omp: { transport: 'rpc' } } })
      );
      const ompEnvironment = {
        ...environment,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        ZEROSHOT_HOSTED_EXECUTABLE: 'omp',
      };
      const available = runConfigurationCheck(ompEnvironment);
      assert.equal(available.status, 0, available.stderr);

      fs.rmSync(fakeOmp);
      const rejected = runConfigurationCheck({
        ...ompEnvironment,
        PATH: directory,
      });
      assert.equal(rejected.status, 1);
      assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, /canary/);

      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          providerSettings: {
            gateway: {
              baseUrl: 'https://models.example/v1',
              apiKeyEnv: 'FUTURE_PROVIDER_TOKEN',
              model: 'gateway/test-model',
              toolPolicy: { roots: ['.'], commands: [] },
            },
          },
        })
      );
      const gateway = runConfigurationCheck({
        ...environment,
        PATH: directory,
        ZEROSHOT_HOSTED_EXECUTABLE: 'gateway',
      });
      assert.equal(gateway.status, 0, gateway.stderr);
    } finally {
      removeTempDirectory(directory);
    }
  });
});
