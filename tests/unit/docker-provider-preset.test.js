/**
 * The provider actually running under `--docker` must have its credential preset (mount and/or
 * env passthrough) auto-activated, so `--docker --provider <p>` authenticates without the user
 * manually listing <p> in dockerMounts. Regression guard for the Copilot case: its OAuth token is
 * not in a mountable dir (it lives in the OS keychain), so forwarding COPILOT_GITHUB_TOKEN is the
 * only path. Also guards the OMP case: an env/broker-only provider with zero automatic mounts,
 * whose exact 9-name allowlist must never leak Claude's Bedrock env vars or the undeclared-var
 * sentinel used elsewhere in the suite.
 */
const assert = require('assert');
const os = require('os');
const IsolationManager = require('../../src/isolation-manager');
const { getProviderMetadata } = require('../../lib/provider-names');

const OMP_ENV_NAMES = getProviderMetadata('omp').docker.envPassthrough;
const ZEROSHOT_UNDECLARED_SENTINEL = 'ZEROSHOT_UNDECLARED_SENTINEL';

function envSpecs(args) {
  // args are a flat docker argv; `-e` is followed by `NAME=value`.
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e') out.push(args[i + 1]);
  }
  return out;
}

function envNames(args) {
  return envSpecs(args).map((spec) => spec.split('=')[0]);
}

function mountSpecs(args) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-v') out.push(args[i + 1]);
  }
  return out;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('docker active-provider credential preset', function () {
  const settings = { dockerMounts: ['gh', 'git', 'ssh'], dockerEnvPassthrough: [] };
  let manager;

  beforeEach(function () {
    manager = new IsolationManager();
  });

  describe('_withActiveProviderPreset', function () {
    it('appends the running provider so its preset activates', function () {
      assert.deepEqual(manager._withActiveProviderPreset(['gh', 'git'], 'copilot'), [
        'gh',
        'git',
        'copilot',
      ]);
    });

    it('does not duplicate a provider already listed', function () {
      assert.deepEqual(manager._withActiveProviderPreset(['copilot'], 'copilot'), ['copilot']);
    });

    it('activates claude too (its own mount is skipped later, only its env preset applies)', function () {
      assert.deepEqual(manager._withActiveProviderPreset(['gh'], 'claude'), ['gh', 'claude']);
    });

    it('activates an env-only provider with no mount preset (omp)', function () {
      assert.deepEqual(manager._withActiveProviderPreset(['gh'], 'omp'), ['gh', 'omp']);
    });

    it('skips unknown providers', function () {
      assert.deepEqual(manager._withActiveProviderPreset(['gh'], 'not-a-provider'), ['gh']);
    });
  });

  describe('_applyCredentialMounts forwards the provider token', function () {
    const KEY = 'COPILOT_GITHUB_TOKEN';
    let saved;

    beforeEach(function () {
      saved = process.env[KEY];
      process.env[KEY] = 'tok-sentinel';
    });

    afterEach(function () {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    });

    it('forwards COPILOT_GITHUB_TOKEN when copilot is the active provider', function () {
      const args = [];
      manager._applyCredentialMounts(args, {}, settings, '/root', 'copilot');
      assert.ok(
        envSpecs(args).includes('COPILOT_GITHUB_TOKEN=tok-sentinel'),
        `expected COPILOT_GITHUB_TOKEN to be forwarded, got: ${JSON.stringify(envSpecs(args))}`
      );
    });

    it('does not forward it for an unrelated active provider', function () {
      const args = [];
      manager._applyCredentialMounts(args, {}, settings, '/root', 'codex');
      assert.ok(!envSpecs(args).some((spec) => spec.startsWith('COPILOT_GITHUB_TOKEN=')));
    });

    it('is disabled by noMounts', function () {
      const args = [];
      manager._applyCredentialMounts(args, { noMounts: true }, settings, '/root', 'copilot');
      assert.equal(args.length, 0);
    });

    // The plan holds ACTUAL values, not presence flags: only the value distinguishes a real
    // credential from a forced-empty `VAR=` passthrough that Docker faithfully delivers as "".
    it('returns the effective plan with actual values, not presence flags', function () {
      const args = [];
      const result = manager._applyCredentialMounts(args, {}, settings, '/root', 'copilot');
      assert.ok(Array.isArray(result.mountedHosts));
      assert.strictEqual(result.forwardedEnv.COPILOT_GITHUB_TOKEN, 'tok-sentinel');
      assert.ok(result.explicitEnvNames instanceof Set);
      assert.ok(Array.isArray(result.explicitMountContainerPaths));
    });
  });

  describe('OMP Docker preset: exact env allowlist, zero automatic mounts', function () {
    it('declares exactly the 5 registry-owned names (narrower than the full adapter inventory)', function () {
      assert.deepStrictEqual(OMP_ENV_NAMES, [
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'OMP_AUTH_BROKER_TOKEN',
        'OMP_AUTH_BROKER_URL',
        'OPENAI_API_KEY',
      ]);
    });

    it('never auto-forwards ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_FOUNDRY_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, or the path-valued broker snapshot/pool vars', function () {
      withEnv(
        {
          ANTHROPIC_OAUTH_TOKEN: 'oauth-sentinel',
          ANTHROPIC_FOUNDRY_API_KEY: 'foundry-sentinel',
          GOOGLE_API_KEY: 'google-sentinel',
          OPENROUTER_API_KEY: 'openrouter-sentinel',
          OMP_AUTH_BROKER_SNAPSHOT_CACHE: 'cache-sentinel',
          OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: 'pool-sentinel',
          OPENAI_API_KEY: 'sk-test',
        },
        () => {
          const args = [];
          manager._applyCredentialMounts(args, {}, settings, '/home/node', 'omp');
          const forwarded = envNames(args);
          for (const excluded of [
            'ANTHROPIC_OAUTH_TOKEN',
            'ANTHROPIC_FOUNDRY_API_KEY',
            'GOOGLE_API_KEY',
            'OPENROUTER_API_KEY',
            'OMP_AUTH_BROKER_SNAPSHOT_CACHE',
            'OMP_AUTH_BROKER_ACCOUNT_POOL_FILE',
          ]) {
            assert.ok(!forwarded.includes(excluded), `${excluded} must require explicit opt-in`);
          }
        }
      );
    });

    it('forwards exactly its 5 names into the container argv when all are set on the host', function () {
      const allSet = Object.fromEntries(OMP_ENV_NAMES.map((name) => [name, `val-${name}`]));
      withEnv(
        {
          ...allSet,
          [ZEROSHOT_UNDECLARED_SENTINEL]: 'leaked-if-broken',
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
          AWS_REGION: 'us-east-1',
        },
        () => {
          const args = [];
          manager._applyCredentialMounts(args, {}, settings, '/home/node', 'omp');
          const forwarded = envNames(args).sort();
          assert.deepStrictEqual(forwarded, [...OMP_ENV_NAMES].sort());
        }
      );
    });

    it('never forwards the undeclared sentinel or Claude Bedrock vars for omp', function () {
      withEnv(
        {
          [ZEROSHOT_UNDECLARED_SENTINEL]: 'leaked-if-broken',
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
          OPENAI_API_KEY: 'sk-test',
        },
        () => {
          const args = [];
          manager._applyCredentialMounts(args, {}, settings, '/home/node', 'omp');
          const forwarded = envNames(args);
          assert.ok(!forwarded.includes(ZEROSHOT_UNDECLARED_SENTINEL));
          assert.ok(!forwarded.includes('CLAUDE_CODE_USE_BEDROCK'));
          assert.ok(!forwarded.includes('AWS_BEARER_TOKEN_BEDROCK'));
        }
      );
    });

    it('never adds a -v mount under ~/.omp (env/broker-only, zero automatic mounts)', function () {
      withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
        const args = [];
        manager._applyCredentialMounts(args, {}, settings, '/home/node', 'omp');
        const ompMount = mountSpecs(args).find((spec) => spec.includes('.omp'));
        assert.strictEqual(ompMount, undefined, `unexpected omp mount: ${ompMount}`);
      });
    });
  });

  describe('claude Docker argv stays unchanged by the active-preset generalization', function () {
    it('produces the same mount-skip + env forwarding as before for the default claude provider', function () {
      withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', AWS_BEARER_TOKEN_BEDROCK: undefined }, () => {
        const args = [];
        const warnings = [];
        const savedWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
        try {
          manager._applyCredentialMounts(args, {}, settings, '/home/node', 'claude');
        } finally {
          console.warn = savedWarn;
        }

        // The claude preset mount ($HOME/.claude) is skipped — zeroshot manages it separately
        // via the cluster config dir mount already present in _buildBaseDockerArgs.
        const claudeMount = mountSpecs(args).find((spec) => spec.includes('/.claude'));
        assert.strictEqual(claudeMount, undefined);
        assert.ok(warnings.some((w) => w.includes('Claude config is managed by zeroshot')));

        // Its own env preset still forwards ANTHROPIC_API_KEY.
        assert.ok(envSpecs(args).includes('ANTHROPIC_API_KEY=sk-ant-test'));
      });
    });
  });

  describe('_assertProviderCredentialPlan for a keychain-token provider (copilot)', function () {
    let savedWarn;
    let warnings;

    beforeEach(function () {
      warnings = [];
      savedWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
    });

    afterEach(function () {
      console.warn = savedWarn;
    });

    it('warns to export the token even though ~/.copilot is mounted (mount holds no secret)', function () {
      manager._assertProviderCredentialPlan('copilot', {
        mountedHosts: [os.homedir() + '/.copilot'],
        forwardedEnv: {},
        config: {},
        containerHome: '/root',
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /COPILOT_GITHUB_TOKEN/);
    });

    it('stays silent once the token is forwarded in the effective plan', function () {
      manager._assertProviderCredentialPlan('copilot', {
        mountedHosts: [os.homedir() + '/.copilot'],
        forwardedEnv: { COPILOT_GITHUB_TOKEN: 'tok-sentinel' },
        config: {},
        containerHome: '/root',
      });
      assert.equal(warnings.length, 0);
    });

    it('still warns when the forwarded token value is empty or whitespace-only', function () {
      manager._assertProviderCredentialPlan('copilot', {
        mountedHosts: [os.homedir() + '/.copilot'],
        forwardedEnv: { COPILOT_GITHUB_TOKEN: '   ' },
        config: {},
        containerHome: '/root',
      });
      assert.equal(warnings.length, 1);
    });
  });

  describe('_assertProviderCredentialPlan fails closed for the env-only omp provider', function () {
    it('throws (never warns) when no auth env is forwarded', function () {
      assert.throws(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: {},
          config: {},
          containerHome: '/home/node',
        });
      }, /No usable credentials found for OMP/);
    });

    it('succeeds silently when an API key is forwarded', function () {
      assert.doesNotThrow(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: { OPENAI_API_KEY: 'sk-test' },
          config: {},
          containerHome: '/home/node',
        });
      });
    });

    // Regression guard for the presence-flag plan this replaced: `true` is not a credential
    // value, and a plan that cannot tell the two apart accepts a forced-empty `VAR=`.
    it('throws when a name is merely flagged present with no real value', function () {
      assert.throws(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: { OPENAI_API_KEY: true },
          config: {},
          containerHome: '/home/node',
        });
      }, /No usable credentials found for OMP/);
    });

    it('throws on a forced-empty API key value', function () {
      assert.throws(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: { OPENAI_API_KEY: '' },
          config: {},
          containerHome: '/home/node',
        });
      }, /No usable credentials found for OMP/);
    });

    it('throws on a malformed broker pair (URL without token)', function () {
      assert.throws(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: { OMP_AUTH_BROKER_URL: 'https://broker.example' },
          config: {},
          containerHome: '/home/node',
        });
      }, /No usable credentials found for OMP/);
    });

    it('throws on a broker URL that is not a usable http(s) URL', function () {
      assert.throws(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: {
            OMP_AUTH_BROKER_URL: 'broker.example:8765',
            OMP_AUTH_BROKER_TOKEN: 'tok-secret',
          },
          config: {},
          containerHome: '/home/node',
        });
      }, /OMP_AUTH_BROKER_URL is set but is not a usable http\(s\) URL/);
    });

    it('succeeds silently with a complete broker pair', function () {
      assert.doesNotThrow(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [],
          forwardedEnv: {
            OMP_AUTH_BROKER_URL: 'https://broker.example',
            OMP_AUTH_BROKER_TOKEN: 'tok-secret',
          },
          config: {},
          containerHome: '/home/node',
        });
      });
    });

    // Never mount/copy the host OMP auth store: an explicit ~/.omp mount is not auth either,
    // because the registry marks omp's credential as not living in a mount.
    it('does not accept a mount of the host auth store as credentials', function () {
      assert.throws(() => {
        manager._assertProviderCredentialPlan('omp', {
          mountedHosts: [os.homedir() + '/.omp'],
          explicitMountContainerPaths: ['/home/node/.omp'],
          forwardedEnv: {},
          explicitEnvNames: new Set(),
          config: {},
          containerHome: '/home/node',
        });
      }, /No usable credentials found for OMP/);
    });
  });
});
