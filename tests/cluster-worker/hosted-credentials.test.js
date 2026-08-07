'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HostedConfigError,
  loadInstalledHostedWorkerConfiguration,
} = require('../../zeroshot-rust/hosted-node/hosted-config');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-hosted-config-'));
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
      assert.equal(config.provider, 'future-provider');
      assert.equal(config.model, 'future/model');
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
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed runtime authority without exposing environment values', () => {
    const { directory, environment } = fixture();
    try {
      for (const patch of [
        { ZEROSHOT_HOSTED_REPOSITORY: 'owner/repository/extra' },
        { ZEROSHOT_HOSTED_BASE_REVISION: 'not-a-commit' },
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
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
