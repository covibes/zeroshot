/**
 * OMP Docker auth: fail-closed env/broker gate.
 *
 * omp's Docker credential surface is env/broker-only (no automatic mount — see
 * tests/agent-cli-provider/omp-registry-capabilities.test.js and
 * tests/unit/docker-provider-preset.test.js for the registry/preset-level contract). This suite
 * proves the end-to-end behavior through `IsolationManager#createContainer`:
 *
 *  - an automatic-allowlist API key or a complete broker URL+token pair succeeds;
 *  - absent / empty / forced-empty / whitespace-only / malformed-URL auth throws BEFORE any
 *    workspace or container side effect, with remediation naming only env var NAMES (never
 *    values), and with no fallback to another provider;
 *  - a registry-known credential outside the automatic allowlist works when — and only when — it
 *    is explicitly passed through, and a *path* credential additionally needs an explicit mount
 *    that actually provides its container path;
 *  - remediation never tells an env-only provider to mount its host auth store.
 *
 * `docker run` itself is stubbed out — this suite never spawns a real container or requires a
 * built image.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IsolationManager = require('../src/isolation-manager');
const { getProviderMetadata } = require('../lib/provider-names');

const OMP_ENV_NAMES = getProviderMetadata('omp').docker.envPassthrough;
// Registry-known OMP credentials that are deliberately NOT on the automatic allowlist. Used both
// for negative coverage (never forwarded automatically) and positive coverage (usable once the
// user explicitly opts them in).
const CUSTOM_KEY = 'OPENROUTER_API_KEY';
const CUSTOM_PATH_KEY = 'GOOGLE_APPLICATION_CREDENTIALS';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-docker-auth-'));
}

// Baseline: unset every OMP auth env var first (regardless of host pollution), then apply the
// test's fixture on top, so each test's auth state is fully deterministic.
function withOmpEnv(overrides, fn) {
  const keys = [
    ...new Set([...OMP_ENV_NAMES, CUSTOM_KEY, CUSTOM_PATH_KEY, ...Object.keys(overrides)]),
  ];
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
  let settingsDir;
  let clusterId;
  let counter = 0;
  let spawnedArgs;
  let effects;
  let savedSettingsFile;

  beforeEach(function () {
    manager = new IsolationManager();
    workDir = createTempDir();
    settingsDir = createTempDir();
    clusterId = `omp-docker-auth-${process.pid}-${counter++}`;
    spawnedArgs = null;
    effects = { removedContainer: false, preparedWorkspace: false };

    // Isolate settings from the developer's real ~/.zeroshot/settings.json.
    savedSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
    process.env.ZEROSHOT_SETTINGS_FILE = path.join(settingsDir, 'settings.json');
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({ defaultProvider: 'omp', providerSettings: { omp: { transport: 'rpc' } } })
    );

    // Stub out the actual `docker run` spawn: this suite verifies the fail-closed auth gate,
    // which runs before any container is created, not container lifecycle itself.
    manager._spawnContainer = (_clusterId, args) => {
      spawnedArgs = args;
      return Promise.resolve('fake-container-id');
    };
    // Record the two side effects the auth gate must precede.
    const removeContainer = manager._removeContainerByName.bind(manager);
    manager._removeContainerByName = (name) => {
      effects.removedContainer = true;
      return removeContainer(name);
    };
    const prepareWorkspace = manager._prepareIsolatedWorkspace.bind(manager);
    manager._prepareIsolatedWorkspace = (...args) => {
      effects.preparedWorkspace = true;
      return prepareWorkspace(...args);
    };
  });

  afterEach(function () {
    manager._cleanupClusterConfigDir(clusterId);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(settingsDir, { recursive: true, force: true });
    if (savedSettingsFile === undefined) delete process.env.ZEROSHOT_SETTINGS_FILE;
    else process.env.ZEROSHOT_SETTINGS_FILE = savedSettingsFile;
  });

  function writeSettings(settings) {
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({
        ...settings,
        defaultProvider: settings.defaultProvider || 'omp',
        providerSettings: {
          ...(settings.providerSettings || {}),
          omp: { ...(settings.providerSettings?.omp || {}), transport: 'rpc' },
        },
      })
    );
  }

  function attemptCreateContainer(envOverrides, config = {}) {
    return withOmpEnv(envOverrides, () =>
      manager.createContainer(clusterId, {
        workDir,
        provider: 'omp',
        containerHome: '/home/node',
        ...config,
      })
    );
  }

  async function rejectionFrom(envOverrides, config = {}) {
    try {
      await attemptCreateContainer(envOverrides, config);
    } catch (err) {
      return err;
    }
    return assert.fail('expected createContainer to reject');
  }

  describe('automatic allowlist fixtures', function () {
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
      // container regardless of provider, contradicting OMP's env/broker-only,
      // zero-automatic-mount Docker isolation contract.
      assert.ok(Array.isArray(spawnedArgs), 'expected createContainer to reach _spawnContainer');
      const claudeMount = spawnedArgs.find(
        (arg) => typeof arg === 'string' && arg.includes(':/home/node/.claude')
      );
      assert.strictEqual(claudeMount, undefined, `unexpected Claude mount in argv: ${claudeMount}`);

      // No cluster config dir (which provisions real Claude credentials via
      // provisionClaudeCredentials) should have been created for this cluster at all.
      assert.strictEqual(manager.clusterConfigDirs.has(clusterId), false);
    });
  });

  describe('missing / malformed auth fails closed', function () {
    it('throws when no auth env is set at all (fails closed, no provider fallback)', async function () {
      await assert.rejects(attemptCreateContainer({}), /No usable credentials found for OMP/);
    });

    it('throws on an empty-string OPENAI_API_KEY (malformed, treated as absent)', async function () {
      await assert.rejects(
        attemptCreateContainer({ OPENAI_API_KEY: '' }),
        /No usable credentials found for OMP/
      );
    });

    it('throws on a whitespace-only OPENAI_API_KEY', async function () {
      await assert.rejects(
        attemptCreateContainer({ OPENAI_API_KEY: '   \t  ' }),
        /No usable credentials found for OMP/
      );
    });

    // The internal plan holds actual values, so a forced-empty passthrough (which really does
    // reach `docker run -e OPENAI_API_KEY=`) cannot masquerade as an authenticated plan.
    it('throws on a forced-empty passthrough (dockerEnvPassthrough: ["OPENAI_API_KEY="])', async function () {
      writeSettings({ dockerEnvPassthrough: ['OPENAI_API_KEY='] });
      const err = await rejectionFrom({});
      assert.match(err.message, /No usable credentials found for OMP/);

      // ...and the forced-empty value really was in the effective plan, which is exactly why a
      // presence-flag plan would have wrongly accepted it.
      const plan = manager._buildCredentialPlan(
        {},
        { dockerMounts: [], dockerEnvPassthrough: ['OPENAI_API_KEY='] },
        '/home/node',
        'omp'
      );
      assert.strictEqual(plan.forwardedEnv.OPENAI_API_KEY, '');
      assert.ok(plan.args.includes('OPENAI_API_KEY='));
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

    it('throws on a broker URL that is not a usable http(s) URL', async function () {
      const err = await rejectionFrom({
        OMP_AUTH_BROKER_URL: 'broker.example:8765',
        OMP_AUTH_BROKER_TOKEN: 'tok-secret',
      });
      assert.match(err.message, /OMP_AUTH_BROKER_URL is set but is not a usable http\(s\) URL/);
      assert.ok(!err.message.includes('broker.example:8765'), err.message);
    });

    // A malformed broker URL is a hard plan defect: another credential does not paper over it,
    // because OMP hard-errors on a broker URL it cannot resolve.
    it('throws on a malformed broker URL even when a valid API key is also present', async function () {
      await assert.rejects(
        attemptCreateContainer({
          OPENAI_API_KEY: 'sk-test',
          OMP_AUTH_BROKER_URL: 'not-a-url',
          OMP_AUTH_BROKER_TOKEN: 'tok-secret',
        }),
        /is not a usable http\(s\) URL/
      );
    });

    // Review item 6: the auth gate must precede `_removeContainerByName()` and
    // `_prepareIsolatedWorkspace()`, matching the platform probe's pre-effect ordering.
    it('fails before ANY workspace or container side effect', async function () {
      await assert.rejects(attemptCreateContainer({}), /No usable credentials found for OMP/);

      assert.strictEqual(effects.removedContainer, false, 'must not remove any container');
      assert.strictEqual(effects.preparedWorkspace, false, 'must not prepare a workspace');
      assert.strictEqual(spawnedArgs, null, 'must not spawn a container');
      assert.strictEqual(manager.clusterConfigDirs.has(clusterId), false);
      assert.strictEqual(
        fs.existsSync(path.join(os.tmpdir(), 'zeroshot-isolated', clusterId)),
        false,
        'no isolated workspace copy may be left behind'
      );
    });

    it('still reaches those effects once auth is satisfied', async function () {
      await attemptCreateContainer({ OPENAI_API_KEY: 'sk-test' });
      assert.strictEqual(effects.removedContainer, true);
      assert.strictEqual(effects.preparedWorkspace, true);
    });
  });

  describe('explicitly opted-in custom credentials', function () {
    // Review item 3: a registry-known OMP credential outside the five-name automatic allowlist
    // must WORK once explicitly passed through — the allowlist narrows automatic forwarding, it
    // does not make other credentials permanently unusable.
    it('succeeds with a custom API key that is explicitly passed through', async function () {
      writeSettings({ dockerEnvPassthrough: [CUSTOM_KEY] });
      const containerId = await attemptCreateContainer({ [CUSTOM_KEY]: 'or-test-key' });
      assert.strictEqual(containerId, 'fake-container-id');
      assert.ok(spawnedArgs.includes(`${CUSTOM_KEY}=or-test-key`), 'value reaches the container');
    });

    it('still fails when that same custom key is only in the host env (no passthrough)', async function () {
      const err = await rejectionFrom({ [CUSTOM_KEY]: 'or-test-key' });
      assert.match(err.message, /No usable credentials found for OMP/);
      assert.ok(!spawnedArgs, 'a non-allowlisted credential is never automatically forwarded');
    });

    it('succeeds with a forced-value custom passthrough (VAR=value)', async function () {
      writeSettings({ dockerEnvPassthrough: [`${CUSTOM_KEY}=or-forced`] });
      const containerId = await attemptCreateContainer({});
      assert.strictEqual(containerId, 'fake-container-id');
    });

    it('rejects a forced-EMPTY custom passthrough (VAR=)', async function () {
      writeSettings({ dockerEnvPassthrough: [`${CUSTOM_KEY}=`] });
      await assert.rejects(attemptCreateContainer({}), /No usable credentials found for OMP/);
    });
  });

  describe('path credentials require the container path AND an explicit mount', function () {
    let credentialFile;

    beforeEach(function () {
      credentialFile = path.join(workDir, 'gcp-creds.json');
      fs.writeFileSync(credentialFile, '{"type":"service_account"}');
    });

    // Review item 4 (negative): an explicit path env alone is not auth. The host file existing
    // proves nothing — without a mount the container simply cannot read it.
    it('throws when the path env is explicit but nothing mounts its container path', async function () {
      writeSettings({
        dockerEnvPassthrough: [`${CUSTOM_PATH_KEY}=/home/node/gcp-creds.json`],
      });
      const err = await rejectionFrom({});
      assert.match(
        err.message,
        new RegExp(
          `${CUSTOM_PATH_KEY} points at a container path that no explicit --mount provides`
        )
      );
    });

    // Review item 4 (positive): container-path env + a mount that actually provides that path.
    it('succeeds when an explicit mount provides exactly that container path', async function () {
      writeSettings({
        dockerEnvPassthrough: [`${CUSTOM_PATH_KEY}=/home/node/gcp-creds.json`],
      });
      const containerId = await attemptCreateContainer(
        {},
        {
          mounts: [
            { host: credentialFile, container: '/home/node/gcp-creds.json', readonly: true },
          ],
        }
      );
      assert.strictEqual(containerId, 'fake-container-id');
      assert.ok(spawnedArgs.includes(`${credentialFile}:/home/node/gcp-creds.json:ro`));
    });

    it('succeeds when an explicit directory mount contains the credential path', async function () {
      writeSettings({
        dockerEnvPassthrough: [`${CUSTOM_PATH_KEY}=/home/node/gcp/creds.json`],
      });
      const containerId = await attemptCreateContainer(
        {},
        { mounts: [{ host: workDir, container: '/home/node/gcp', readonly: true }] }
      );
      assert.strictEqual(containerId, 'fake-container-id');
    });

    it('throws when the mount provides a DIFFERENT container path', async function () {
      writeSettings({
        dockerEnvPassthrough: [`${CUSTOM_PATH_KEY}=/home/node/gcp-creds.json`],
      });
      await assert.rejects(
        attemptCreateContainer(
          {},
          { mounts: [{ host: credentialFile, container: '/home/node/other.json', readonly: true }] }
        ),
        /points at a container path that no explicit --mount provides/
      );
    });

    it('does not count a host path that merely exists', async function () {
      // The value is a HOST path that exists but is not a container path any mount provides.
      writeSettings({ dockerEnvPassthrough: [`${CUSTOM_PATH_KEY}=${credentialFile}`] });
      await assert.rejects(
        attemptCreateContainer({}),
        /points at a container path that no explicit --mount provides/
      );
    });
  });

  describe('remediation text', function () {
    it('never includes a credential value in the thrown remediation message', async function () {
      const err = await rejectionFrom({
        OMP_AUTH_BROKER_URL: 'https://broker.example/secret-path',
      });
      assert.ok(
        !err.message.includes('https://broker.example/secret-path'),
        `remediation must name vars, not values: ${err.message}`
      );
      assert.match(err.message, /OMP_AUTH_BROKER_TOKEN/);
    });

    it('lists the automatic allowlist names in the remediation for an env-only provider', async function () {
      const err = await rejectionFrom({});
      for (const name of OMP_ENV_NAMES) {
        assert.ok(err.message.includes(name), `remediation should mention ${name}`);
      }
    });

    it('mentions the custom dockerEnvPassthrough / --mount remediation path', async function () {
      const err = await rejectionFrom({});
      assert.match(err.message, /dockerEnvPassthrough/);
      assert.match(err.message, /--mount/);
    });

    // Review item 4: the old remediation derived its mount hint from OMP's credentialPaths[0] and
    // told the user to mount `~/.omp` — directly contradicting the never-mount-the-host-auth-store
    // requirement. Env-only providers get a generic custom-path example and a broker preference.
    it('never recommends mounting the host OMP auth store', async function () {
      const err = await rejectionFrom({});
      const credentialPath = getProviderMetadata('omp').credentialPaths[0];
      assert.ok(credentialPath, 'omp declares a host credential path');
      assert.ok(
        !err.message.includes(credentialPath),
        `remediation must not name the host auth store: ${err.message}`
      );
      assert.ok(!/--mount\s*~/.test(err.message), err.message);
      assert.match(err.message, /never mounted or copied into the container/);
    });

    it('prefers the auth broker over host credentials', async function () {
      const err = await rejectionFrom({});
      assert.match(err.message, /Prefer the auth broker/);
      assert.match(err.message, /OMP_AUTH_BROKER_URL \+ OMP_AUTH_BROKER_TOKEN/);
    });

    it('uses a generic container path in the custom file-credential example', async function () {
      const err = await rejectionFrom({});
      assert.match(err.message, /--mount \/host\/path\/to\/credential:\/home\/node\/credential:ro/);
    });
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

  it('the effective plan preserves the actual value, not a presence flag', function () {
    const manager = new IsolationManager();
    const settings = { dockerMounts: [], dockerEnvPassthrough: ['MY_CUSTOM_OMP_KEY'] };
    const saved = process.env.MY_CUSTOM_OMP_KEY;
    process.env.MY_CUSTOM_OMP_KEY = 'custom-value';
    try {
      const plan = manager._buildCredentialPlan({}, settings, '/home/node', 'omp');
      assert.strictEqual(plan.forwardedEnv.MY_CUSTOM_OMP_KEY, 'custom-value');
      assert.strictEqual(plan.explicitEnvNames.has('MY_CUSTOM_OMP_KEY'), true);
    } finally {
      if (saved === undefined) delete process.env.MY_CUSTOM_OMP_KEY;
      else process.env.MY_CUSTOM_OMP_KEY = saved;
    }
  });

  it("the running provider's own preset is automatic, not explicit", function () {
    const manager = new IsolationManager();
    const settings = { dockerMounts: [], dockerEnvPassthrough: [] };
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-auto';
    try {
      const plan = manager._buildCredentialPlan({}, settings, '/home/node', 'omp');
      assert.strictEqual(plan.forwardedEnv.OPENAI_API_KEY, 'sk-auto');
      assert.strictEqual(
        plan.explicitEnvNames.has('OPENAI_API_KEY'),
        false,
        'the auto-activated provider preset is not an explicit opt-in'
      );
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
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

  // Direct coverage of the classification rule itself: a registry-known credential that reaches
  // the container through some non-explicit route is still rejected, so the explicit-opt-in
  // requirement is enforced by the rule and not merely by which vars happen to be forwarded.
  it('rejects a registry-known credential forwarded without an explicit opt-in', function () {
    const manager = new IsolationManager();
    assert.throws(
      () =>
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          explicitMountContainerPaths: [],
          forwardedEnv: { OPENROUTER_API_KEY: 'or-test' },
          explicitEnvNames: new Set(),
          config: {},
          containerHome: '/home/node',
        }),
      /OPENROUTER_API_KEY \(known .* credentials outside the automatic allowlist\) were not explicitly opted in/
    );
  });

  it('accepts that same credential once it is in the explicit plan', function () {
    const manager = new IsolationManager();
    manager._assertProviderCredentialPlan('omp', {
      mountedHosts: [],
      explicitMountContainerPaths: [],
      forwardedEnv: { OPENROUTER_API_KEY: 'or-test' },
      explicitEnvNames: new Set(['OPENROUTER_API_KEY']),
      config: {},
      containerHome: '/home/node',
    });
  });
});
