/**
 * The provider actually running under `--docker` must have its credential preset (mount + env
 * passthrough) auto-activated, so `--docker --provider <p>` authenticates without the user manually
 * listing <p> in dockerMounts. Regression guard for the Copilot case: its OAuth token is not in a
 * mountable dir (it lives in the OS keychain), so forwarding COPILOT_GITHUB_TOKEN is the only path.
 */
const assert = require('assert');
const IsolationManager = require('../../src/isolation-manager');

function envSpecs(args) {
  // args are a flat docker argv; `-e` is followed by `NAME=value`.
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e') out.push(args[i + 1]);
  }
  return out;
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

    it('skips claude (mounted separately) and unknown providers', function () {
      assert.deepEqual(manager._withActiveProviderPreset(['gh'], 'claude'), ['gh']);
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
  });

  describe('_warnMissingProviderCredentials for a keychain-token provider (copilot)', function () {
    const KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
    let savedEnv;
    let savedWarn;
    let warnings;

    beforeEach(function () {
      savedEnv = {};
      for (const k of KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
      warnings = [];
      savedWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);
    });

    afterEach(function () {
      console.warn = savedWarn;
      for (const k of KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it('warns to export the token even though ~/.copilot is mounted (mount holds no secret)', function () {
      manager._warnMissingProviderCredentials(
        'copilot',
        [require('os').homedir() + '/.copilot'],
        {},
        '/root'
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /COPILOT_GITHUB_TOKEN/);
    });

    it('stays silent once the token is exported', function () {
      process.env.COPILOT_GITHUB_TOKEN = 'tok-sentinel';
      manager._warnMissingProviderCredentials(
        'copilot',
        [require('os').homedir() + '/.copilot'],
        {},
        '/root'
      );
      assert.equal(warnings.length, 0);
    });
  });

  describe('omp preset', function () {
    const { getProviderMetadata } = require('../../lib/provider-names');
    const declaredEnvUnion = new Set([
      ...getProviderMetadata('omp').docker.envPassthrough,
      ...getProviderMetadata('claude').docker.envPassthrough,
    ]);
    const CREDENTIAL_KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];
    const SENTINEL = 'ZEROSHOT_UNDECLARED_SECRET';
    let savedEnv;

    beforeEach(function () {
      savedEnv = {};
      for (const k of [...CREDENTIAL_KEYS, SENTINEL]) {
        savedEnv[k] = process.env[k];
      }
    });

    afterEach(function () {
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    describe('_withActiveProviderPreset', function () {
      it('appends omp so its preset activates', function () {
        assert.deepEqual(manager._withActiveProviderPreset(['gh'], 'omp'), ['gh', 'omp']);
      });

      it('does not duplicate omp when already listed', function () {
        assert.deepEqual(manager._withActiveProviderPreset(['gh', 'omp'], 'omp'), ['gh', 'omp']);
      });
    });

    describe('_applyCredentialMounts', function () {
      it('forwards declared credential env vars when set', function () {
        process.env.OPENROUTER_API_KEY = 'or-sentinel';
        process.env.ANTHROPIC_API_KEY = 'anthropic-sentinel';
        const args = [];
        manager._applyCredentialMounts(args, {}, settings, '/root', 'omp');
        const specs = envSpecs(args);
        assert.ok(specs.includes('OPENROUTER_API_KEY=or-sentinel'));
        assert.ok(specs.includes('ANTHROPIC_API_KEY=anthropic-sentinel'));
      });

      it('never forwards an undeclared sentinel var', function () {
        process.env[SENTINEL] = 'nope';
        process.env.OPENROUTER_API_KEY = 'or-sentinel';
        const args = [];
        manager._applyCredentialMounts(args, {}, settings, '/root', 'omp');
        assert.ok(!envSpecs(args).some((spec) => spec.startsWith(`${SENTINEL}=`)));
      });

      it('only forwards -e names declared by omp or claude docker.envPassthrough', function () {
        process.env.OPENROUTER_API_KEY = 'or-sentinel';
        process.env.ANTHROPIC_API_KEY = 'anthropic-sentinel';
        const args = [];
        manager._applyCredentialMounts(args, {}, settings, '/root', 'omp');
        for (const spec of envSpecs(args)) {
          const name = spec.slice(0, spec.indexOf('='));
          assert.ok(
            declaredEnvUnion.has(name),
            `forwarded -e ${name} is not declared by omp or claude docker.envPassthrough`
          );
        }
      });

      it('is disabled by noMounts', function () {
        process.env.OPENROUTER_API_KEY = 'or-sentinel';
        const args = [];
        manager._applyCredentialMounts(args, { noMounts: true }, settings, '/root', 'omp');
        assert.equal(args.length, 0);
      });
    });

    describe('_warnMissingProviderCredentials', function () {
      let warnings;
      let savedWarn;

      beforeEach(function () {
        warnings = [];
        savedWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
      });

      afterEach(function () {
        console.warn = savedWarn;
      });

      it('warns when ~/.omp is not mounted and no credential env is set', function () {
        manager._warnMissingProviderCredentials('omp', [], {}, '/root');
        assert.equal(warnings.length, 1);
      });

      it('stays silent once ANTHROPIC_API_KEY is exported', function () {
        process.env.ANTHROPIC_API_KEY = 'anthropic-sentinel';
        manager._warnMissingProviderCredentials('omp', [], {}, '/root');
        assert.equal(warnings.length, 0);
      });
    });
  });
});
