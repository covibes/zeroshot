'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installRuntimeCapability } = require('../../zeroshot-rust/hosted-node/runtime-capability');

const ROOT = path.resolve(__dirname, '..', '..');

describe('private hosted worker runtime', () => {
  it('materializes and removes the one-time task capability', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-runtime-capability-'));
    const capabilityFile = path.join(directory, 'capability');
    const environment = {
      ZEROSHOT_OECP_RUNTIME_CAPABILITY: 'a'.repeat(64),
      ZEROSHOT_OECP_CAPABILITY_FILE: capabilityFile,
    };
    try {
      installRuntimeCapability(environment);
      assert.strictEqual(environment.ZEROSHOT_OECP_RUNTIME_CAPABILITY, undefined);
      assert.strictEqual(fs.readFileSync(capabilityFile, 'ascii'), 'a'.repeat(64));
      assert.strictEqual(fs.statSync(capabilityFile).mode & 0o777, 0o400);
      environment.ZEROSHOT_OECP_RUNTIME_CAPABILITY = 'b'.repeat(64);
      assert.throws(() => installRuntimeCapability(environment), /EEXIST/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads an injected adapter without loading the production engine', () => {
    const probe = [
      "const Module = require('module');",
      'const load = Module._load;',
      'Module._load = function(request, ...args) {',
      "  if (request.endsWith('/engine-adapter') || request === './engine-adapter') throw new Error('production engine loaded');",
      '  return load.call(this, request, ...args);',
      '};',
      "const { createLegacyClusterWorker } = require('./lib/cluster-worker');",
      'createLegacyClusterWorker({',
      '  profileRegistry: {}, artifactResolver: {},',
      '  engineAdapter: {}, cleanupFailureReporter() {}',
      '});',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
  });

  it('refuses to launch outside the fixed prepared workspace', () => {
    const result = spawnSync(process.execPath, ['zeroshot-rust/hosted-node/worker-launcher.js'], {
      cwd: ROOT,
      env: {
        HOME: '/tmp/zeroshot-oecp',
        LANG: 'C.UTF-8',
        NODE_ENV: 'production',
        PATH: process.env.PATH,
        ZEROSHOT_HOSTED_CREDENTIALS_JSON: JSON.stringify({
          GH_TOKEN: 'git-canary',
          OPENAI_API_KEY: 'provider-canary',
        }),
        ZEROSHOT_HOSTED_REPOSITORY: 'the-open-engine/zeroshot',
        ZEROSHOT_HOSTED_BASE_REVISION: 'a'.repeat(40),
        ZEROSHOT_HOSTED_PROVIDER: 'codex',
        ZEROSHOT_HOSTED_MODEL_LEVEL: 'level2',
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
        ZEROSHOT_ISOLATION_PROFILE: 'isolation.prepared-worktree@1',
        ZEROSHOT_PROVIDER_PROFILE: 'provider.hosted-direct@1',
      },
      encoding: 'utf8',
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Invalid fixed capsule workspace/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /git-canary|provider-canary/);
  });
});
