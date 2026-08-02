/**
 * OMP Docker auth: fail-closed env/broker gate.
 *
 * omp's Docker credential surface is env/broker-only (no automatic mount — see
 * tests/agent-cli-provider/omp-registry-capabilities.test.js and
 * tests/unit/docker-provider-preset.test.js for the registry/preset-level contract). This suite
 * proves the end-to-end behavior through `IsolationManager#createContainer`: an API-key fixture
 * or a complete broker URL+token pair succeeds; empty/malformed/absent auth throws before the
 * container is ever spawned, with remediation naming only env var NAMES (never values), and no
 * fallback to another provider. `docker run` itself is stubbed out — this suite never spawns a
 * real container or requires a built image.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IsolationManager = require('../src/isolation-manager');
const { getProviderMetadata } = require('../lib/provider-names');

const OMP_ENV_NAMES = getProviderMetadata('omp').docker.envPassthrough;

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-docker-auth-'));
}

// Baseline: unset every OMP auth env var first (regardless of host pollution), then apply the
// test's fixture on top, so each test's auth state is fully deterministic.
function withOmpEnv(overrides, fn) {
  const keys = [...new Set([...OMP_ENV_NAMES, ...Object.keys(overrides)])];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

describe('OMP Docker auth: fail-closed env/broker gate', function () {
  this.timeout(15000);

  let manager;
  let workDir;
  let clusterId;
  let counter = 0;
  let spawnedArgs;

  beforeEach(function () {
    manager = new IsolationManager();
    workDir = createTempDir();
    clusterId = `omp-docker-auth-${process.pid}-${counter++}`;
    spawnedArgs = null;
    // Stub out the actual `docker run` spawn: this suite verifies the fail-closed auth gate,
    // which runs before any container is created, not container lifecycle itself.
    manager._spawnContainer = (_clusterId, args) => {
      spawnedArgs = args;
      return Promise.resolve('fake-container-id');
    };
  });

  afterEach(function () {
    manager._cleanupClusterConfigDir(clusterId);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function attemptCreateContainer(envOverrides) {
    return withOmpEnv(envOverrides, () =>
      manager.createContainer(clusterId, {
        workDir,
        provider: 'omp',
        containerHome: '/home/node',
      })
    );
  }

  it('succeeds with an API-key fixture (OPENAI_API_KEY)', async function () {
    const containerId = await attemptCreateContainer({ OPENAI_API_KEY: 'sk-test' });
    assert.strictEqual(containerId, 'fake-container-id');
  });

  it('succeeds with a complete broker fixture (URL + TOKEN)', async function () {
    const containerId = await attemptCreateContainer({
      OMP_AUTH_BROKER_URL: 'https://broker.example',
      OMP_AUTH_BROKER_TOKEN: 'tok-secret',
    });
    assert.strictEqual(containerId, 'fake-container-id');
  });

  it('never creates or mounts the Claude credential/hook config dir for an omp container', async function () {
    await attemptCreateContainer({ OPENAI_API_KEY: 'sk-test' });

    // The base docker argv must never carry the ~/.claude mount for a non-claude provider — that
    // mount used to be unconditional and copied real host Claude credentials into every
    // container regardless of provider, contradicting OMP's env/broker-only, zero-automatic-mount
    // Docker isolation contract.
    assert.ok(Array.isArray(spawnedArgs), 'expected createContainer to reach _spawnContainer');
    const claudeMount = spawnedArgs.find(
      (arg) => typeof arg === 'string' && arg.includes(':/home/node/.claude')
    );
    assert.strictEqual(claudeMount, undefined, `unexpected Claude mount in argv: ${claudeMount}`);

    // No cluster config dir (which provisions real Claude credentials via
    // provisionClaudeCredentials) should have been created for this cluster at all.
    assert.strictEqual(manager.clusterConfigDirs.has(clusterId), false);
  });

  it('throws when no auth env is set at all (fails closed, no provider fallback)', async function () {
    await assert.rejects(attemptCreateContainer({}), /No usable credentials found for OMP/);
  });

  it('throws on an empty-string OPENAI_API_KEY (malformed, treated as absent)', async function () {
    await assert.rejects(
      attemptCreateContainer({ OPENAI_API_KEY: '' }),
      /No usable credentials found for OMP/
    );
  });

  it('throws on a broker URL without a token (partial pair is malformed, not "missing")', async function () {
    await assert.rejects(
      attemptCreateContainer({ OMP_AUTH_BROKER_URL: 'https://broker.example' }),
      /No usable credentials found for OMP/
    );
  });

  it('throws on a broker token without a URL', async function () {
    await assert.rejects(
      attemptCreateContainer({ OMP_AUTH_BROKER_TOKEN: 'tok-secret' }),
      /No usable credentials found for OMP/
    );
  });

  it('never includes a credential value in the thrown remediation message', async function () {
    try {
      await attemptCreateContainer({ OPENAI_API_KEY: 'sk-super-secret-value' });
      // OPENAI_API_KEY alone satisfies auth, so force a malformed case for this assertion instead.
    } catch {
      // not expected to throw here
    }

    try {
      await attemptCreateContainer({ OMP_AUTH_BROKER_URL: 'https://broker.example/secret-path' });
      assert.fail('expected the partial broker pair to throw');
    } catch (err) {
      assert.ok(
        !err.message.includes('https://broker.example/secret-path'),
        `remediation must name vars, not values: ${err.message}`
      );
      assert.match(err.message, /OMP_AUTH_BROKER_TOKEN/);
    }
  });

  it('lists the automatic allowlist names in the remediation for an env-only provider', async function () {
    try {
      await attemptCreateContainer({});
      assert.fail('expected throw');
    } catch (err) {
      for (const name of OMP_ENV_NAMES) {
        assert.ok(err.message.includes(name), `remediation should mention ${name}`);
      }
    }
  });

  it('mentions the custom dockerEnvPassthrough / --mount remediation path', async function () {
    try {
      await attemptCreateContainer({});
      assert.fail('expected throw');
    } catch (err) {
      assert.match(err.message, /dockerEnvPassthrough/);
      assert.match(err.message, /--mount/);
    }
  });
});

describe('Claude Docker containers still get their credential/hook config dir (fix is provider-scoped, not a blanket removal)', function () {
  let manager;
  let workDir;
  let clusterId;
  let spawnedArgs;

  beforeEach(function () {
    manager = new IsolationManager();
    workDir = createTempDir();
    clusterId = `claude-docker-config-${process.pid}-${Date.now()}`;
    spawnedArgs = null;
    manager._spawnContainer = (_clusterId, args) => {
      spawnedArgs = args;
      return Promise.resolve('fake-container-id');
    };
  });

  afterEach(function () {
    manager._cleanupClusterConfigDir(clusterId);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('creates and mounts the ~/.claude config dir when claude is the active provider', async function () {
    await manager.createContainer(clusterId, {
      workDir,
      provider: 'claude',
      containerHome: '/home/node',
    });

    assert.ok(Array.isArray(spawnedArgs));
    const claudeMount = spawnedArgs.find(
      (arg) => typeof arg === 'string' && arg.includes(':/home/node/.claude')
    );
    assert.ok(claudeMount, 'expected a ~/.claude mount for the claude provider');
    assert.strictEqual(manager.clusterConfigDirs.has(clusterId), true);
  });
});

describe('OMP custom credential accounting (dockerEnvPassthrough / --mount)', function () {
  it('validateEnvPassthrough accepts a custom env var name outside the automatic allowlist', function () {
    const { validateEnvPassthrough } = require('../lib/docker-config');
    assert.strictEqual(validateEnvPassthrough(['MY_CUSTOM_OMP_KEY']), null);
  });

  it('a custom credential forwarded via settings.dockerEnvPassthrough is identified as forwarded', function () {
    const manager = new IsolationManager();
    const settings = { dockerMounts: [], dockerEnvPassthrough: ['MY_CUSTOM_OMP_KEY'] };
    const saved = process.env.MY_CUSTOM_OMP_KEY;
    process.env.MY_CUSTOM_OMP_KEY = 'custom-value';
    try {
      const args = [];
      const { forwardedEnv } = manager._applyCredentialMounts(
        args,
        {},
        settings,
        '/home/node',
        'omp'
      );
      assert.strictEqual(forwardedEnv.MY_CUSTOM_OMP_KEY, true);
    } finally {
      if (saved === undefined) delete process.env.MY_CUSTOM_OMP_KEY;
      else process.env.MY_CUSTOM_OMP_KEY = saved;
    }
  });

  it('a custom --mount entry is accepted by resolveMounts as a genuine custom mount', function () {
    const { resolveMounts } = require('../lib/docker-config');
    const result = resolveMounts(
      [{ host: '~/custom-omp-creds', container: '$HOME/custom-omp-creds', readonly: true }],
      { containerHome: '/home/node' }
    );
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].container, '/home/node/custom-omp-creds');
  });
});
