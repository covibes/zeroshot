/**
 * Test: Docker Configuration
 *
 * Tests the configurable Docker mount system:
 * - Mount presets and custom mounts
 * - $HOME placeholder expansion
 * - Env var resolution (simple, patterns, forced values)
 * - Validation
 */

const assert = require('assert');
const { listProviderMetadata } = require('../../lib/provider-names');
const {
  MOUNT_PRESETS,
  ENV_PRESETS,
  PROVIDER_ENV_ONLY_PRESETS,
  resolveMounts,
  resolveEnvs,
  expandEnvPatterns,
  validateMountConfig,
  validateEnvPassthrough,
  validateProviderEnvAuth,
} = require('../../lib/docker-config');

const MOUNT_DECLARING_PROVIDER_IDS = listProviderMetadata()
  .filter((metadata) => metadata.docker.mount)
  .map((metadata) => metadata.id);
const ENV_ONLY_PROVIDER_IDS = listProviderMetadata()
  .filter((metadata) => !metadata.docker.mount)
  .map((metadata) => metadata.id);

describe('Docker Configuration', function () {
  registerMountPresetTests();
  registerEnvOnlyPresetTests();
  registerEnvPresetTests();
  registerResolveMountsTests();
  registerResolveEnvsTests();
  registerExpandEnvPatternsTests();
  registerValidateMountConfigTests();
  registerValidateEnvPassthroughTests();
  registerValidateProviderEnvAuthTests();
  registerAwsWorkflowTests();
  registerCustomMountWorkflowTests();
});

function registerMountPresetTests() {
  describe('MOUNT_PRESETS', function () {
    it('should have all expected presets', function () {
      const expected = [
        'gh',
        'git',
        'ssh',
        'aws',
        'azure',
        'kube',
        'terraform',
        'gcloud',
        ...MOUNT_DECLARING_PROVIDER_IDS,
      ];
      for (const preset of expected) {
        assert.ok(MOUNT_PRESETS[preset], `Missing preset: ${preset}`);
      }
    });

    it('should build provider mount presets only from providers that declare docker.mount', function () {
      for (const metadata of listProviderMetadata()) {
        if (metadata.docker.mount) {
          assert.deepStrictEqual(MOUNT_PRESETS[metadata.id], metadata.docker.mount);
        } else {
          assert.strictEqual(
            MOUNT_PRESETS[metadata.id],
            undefined,
            `Env-only provider ${metadata.id} must not have a mount preset`
          );
        }
      }
    });

    it('should use $HOME placeholder in container paths', function () {
      for (const [name, preset] of Object.entries(MOUNT_PRESETS)) {
        assert.ok(
          preset.container.startsWith('$HOME/'),
          `Preset ${name} should use $HOME placeholder, got: ${preset.container}`
        );
      }
    });

    it('should use ~ in host paths', function () {
      for (const [name, preset] of Object.entries(MOUNT_PRESETS)) {
        assert.ok(
          preset.host.startsWith('~/'),
          `Preset ${name} should use ~ for host path, got: ${preset.host}`
        );
      }
    });

    it('should have readonly property', function () {
      for (const [name, preset] of Object.entries(MOUNT_PRESETS)) {
        assert.ok(
          typeof preset.readonly === 'boolean',
          `Preset ${name} should have boolean readonly property`
        );
      }
    });
  });
}

function registerEnvOnlyPresetTests() {
  describe('PROVIDER_ENV_ONLY_PRESETS / env-only mount resolution', function () {
    it('lists every provider with envPassthrough but no docker.mount (e.g. omp)', function () {
      assert.ok(ENV_ONLY_PROVIDER_IDS.length > 0, 'expected at least one env-only provider');
      for (const id of ENV_ONLY_PROVIDER_IDS) {
        assert.ok(PROVIDER_ENV_ONLY_PRESETS.has(id), `expected ${id} in PROVIDER_ENV_ONLY_PRESETS`);
      }
      for (const id of MOUNT_DECLARING_PROVIDER_IDS) {
        assert.ok(
          !PROVIDER_ENV_ONLY_PRESETS.has(id),
          `mount-declaring provider ${id} must not be env-only`
        );
      }
    });

    it('resolveMounts() returns [] for an env-only preset instead of throwing', function () {
      for (const id of ENV_ONLY_PROVIDER_IDS) {
        assert.deepStrictEqual(resolveMounts([id]), []);
      }
    });

    it('resolveMounts() still throws for a genuinely unknown preset', function () {
      assert.throws(() => resolveMounts(['not-a-real-preset']), /Unknown mount preset/);
    });

    it('validateMountConfig() accepts an env-only preset name', function () {
      for (const id of ENV_ONLY_PROVIDER_IDS) {
        assert.strictEqual(validateMountConfig([id]), null);
      }
    });
  });
}

function registerEnvPresetTests() {
  describe('ENV_PRESETS', function () {
    it('should have expected preset keys', function () {
      assert.ok(ENV_PRESETS.aws);
      assert.ok(ENV_PRESETS.azure);
      assert.ok(ENV_PRESETS.gcloud);
      assert.ok(ENV_PRESETS.kube);
      assert.ok(ENV_PRESETS.terraform);
      for (const metadata of listProviderMetadata()) {
        assert.ok(ENV_PRESETS[metadata.id]);
      }
    });

    it('should include AWS_PAGER= forced value for aws preset', function () {
      assert.ok(
        ENV_PRESETS.aws.includes('AWS_PAGER='),
        'AWS preset should force AWS_PAGER to empty'
      );
    });

    it('should include pattern for terraform', function () {
      assert.ok(
        ENV_PRESETS.terraform.includes('TF_VAR_*'),
        'Terraform preset should include TF_VAR_* pattern'
      );
    });

    it('should build provider env presets from provider registry metadata', function () {
      for (const metadata of listProviderMetadata()) {
        assert.deepStrictEqual(ENV_PRESETS[metadata.id], metadata.docker.envPassthrough);
      }
    });
  });
}

function registerResolveMountsTests() {
  describe('resolveMounts()', function () {
    it('should resolve preset names to mount specs', function () {
      const result = resolveMounts(['aws']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].host, '~/.aws');
      assert.strictEqual(result[0].container, '/root/.aws');
      assert.strictEqual(result[0].readonly, true);
    });

    it('should expand $HOME with custom containerHome', function () {
      const result = resolveMounts(['aws'], { containerHome: '/home/node' });
      assert.strictEqual(result[0].container, '/home/node/.aws');
    });

    it('should default containerHome to /root', function () {
      const result = resolveMounts(['aws']);
      assert.strictEqual(result[0].container, '/root/.aws');
    });

    it('should resolve multiple presets', function () {
      const result = resolveMounts(['gh', 'git', 'ssh']);
      assert.strictEqual(result.length, 3);
    });

    it('should resolve custom mount objects', function () {
      const result = resolveMounts([
        { host: '~/.myconfig', container: '$HOME/.myconfig', readonly: true },
      ]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].host, '~/.myconfig');
      assert.strictEqual(result[0].container, '/root/.myconfig');
      assert.strictEqual(result[0].readonly, true);
    });

    it('should default readonly to true for custom mounts', function () {
      const result = resolveMounts([{ host: '~/.foo', container: '/bar' }]);
      assert.strictEqual(result[0].readonly, true);
    });

    it('should allow readonly: false for custom mounts', function () {
      const result = resolveMounts([{ host: '~/.foo', container: '/bar', readonly: false }]);
      assert.strictEqual(result[0].readonly, false);
    });

    it('should resolve mixed presets and custom mounts', function () {
      const result = resolveMounts(['aws', { host: '~/.custom', container: '$HOME/.custom' }], {
        containerHome: '/home/user',
      });
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].container, '/home/user/.aws');
      assert.strictEqual(result[1].container, '/home/user/.custom');
    });

    it('should throw on unknown preset', function () {
      assert.throws(() => resolveMounts(['unknown']), /Unknown mount preset: "unknown"/);
    });

    it('should throw on missing host property', function () {
      assert.throws(
        () => resolveMounts([{ container: '/foo' }]),
        /must have "host" and "container"/
      );
    });

    it('should throw on missing container property', function () {
      assert.throws(() => resolveMounts([{ host: '~/.foo' }]), /must have "host" and "container"/);
    });

    it('should throw on non-array input', function () {
      assert.throws(() => resolveMounts('aws'), /must be an array/);
    });

    it('should throw on invalid item type', function () {
      assert.throws(() => resolveMounts([123]), /Invalid mount config/);
    });
  });
}

function registerResolveEnvsTests() {
  describe('resolveEnvs()', function () {
    it('should return empty array for empty config', function () {
      const result = resolveEnvs([]);
      assert.deepStrictEqual(result, []);
    });

    it('should include preset env vars', function () {
      const result = resolveEnvs(['aws']);
      assert.ok(result.includes('AWS_REGION'));
      assert.ok(result.includes('AWS_DEFAULT_REGION'));
      assert.ok(result.includes('AWS_PROFILE'));
      assert.ok(result.includes('AWS_PAGER='));
    });

    it('should include extra envs', function () {
      const result = resolveEnvs([], ['MY_VAR', 'OTHER_VAR']);
      assert.ok(result.includes('MY_VAR'));
      assert.ok(result.includes('OTHER_VAR'));
    });

    it('should combine preset and extra envs', function () {
      const result = resolveEnvs(['aws'], ['MY_VAR']);
      assert.ok(result.includes('AWS_REGION'));
      assert.ok(result.includes('MY_VAR'));
    });

    it('should deduplicate envs', function () {
      const result = resolveEnvs(['aws'], ['AWS_REGION']);
      const awsRegionCount = result.filter((e) => e === 'AWS_REGION').length;
      assert.strictEqual(awsRegionCount, 1);
    });

    it('should ignore non-preset strings', function () {
      const result = resolveEnvs([{ host: '~/.foo', container: '/foo' }]);
      assert.deepStrictEqual(result, []);
    });
  });
}

function registerExpandEnvPatternsTests() {
  describe('expandEnvPatterns()', function () {
    it('should return simple vars as-is', function () {
      const result = expandEnvPatterns(['MY_VAR']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'MY_VAR');
      assert.strictEqual(result[0].value, null);
      assert.strictEqual(result[0].forced, false);
    });

    it('should expand pattern vars', function () {
      const mockEnv = {
        TF_VAR_foo: 'foo_value',
        TF_VAR_bar: 'bar_value',
        OTHER_VAR: 'other',
      };
      const result = expandEnvPatterns(['TF_VAR_*'], mockEnv);
      assert.strictEqual(result.length, 2);
      assert.ok(result.some((r) => r.name === 'TF_VAR_foo'));
      assert.ok(result.some((r) => r.name === 'TF_VAR_bar'));
    });

    it('should handle forced empty value (VAR=)', function () {
      const result = expandEnvPatterns(['AWS_PAGER=']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'AWS_PAGER');
      assert.strictEqual(result[0].value, '');
      assert.strictEqual(result[0].forced, true);
    });

    it('should handle forced value (VAR=value)', function () {
      const result = expandEnvPatterns(['TERM=xterm']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'TERM');
      assert.strictEqual(result[0].value, 'xterm');
      assert.strictEqual(result[0].forced, true);
    });

    it('should handle forced value with = in value (VAR=foo=bar)', function () {
      const result = expandEnvPatterns(['MY_VAR=foo=bar']);
      assert.strictEqual(result[0].name, 'MY_VAR');
      assert.strictEqual(result[0].value, 'foo=bar');
    });

    it('should handle mixed env specs', function () {
      const mockEnv = { TF_VAR_x: '1' };
      const result = expandEnvPatterns(['AWS_REGION', 'TF_VAR_*', 'AWS_PAGER='], mockEnv);

      const simple = result.find((r) => r.name === 'AWS_REGION');
      const pattern = result.find((r) => r.name === 'TF_VAR_x');
      const forced = result.find((r) => r.name === 'AWS_PAGER');

      assert.ok(simple && !simple.forced);
      assert.ok(pattern && !pattern.forced);
      assert.ok(forced && forced.forced && forced.value === '');
    });
  });
}

function registerValidateMountConfigTests() {
  describe('validateMountConfig()', function () {
    it('should accept valid preset names', function () {
      assert.strictEqual(validateMountConfig(['gh', 'git', 'ssh']), null);
    });

    it('should accept valid custom objects', function () {
      const config = [{ host: '~/.foo', container: '/bar', readonly: true }];
      assert.strictEqual(validateMountConfig(config), null);
    });

    it('should accept mixed config', function () {
      const config = ['aws', { host: '~/.foo', container: '/bar' }];
      assert.strictEqual(validateMountConfig(config), null);
    });

    it('should reject unknown presets', function () {
      const error = validateMountConfig(['unknown']);
      assert.ok(error && error.includes('Unknown mount preset'));
    });

    it('should reject missing host', function () {
      const error = validateMountConfig([{ container: '/bar' }]);
      assert.ok(error && error.includes('missing "host"'));
    });

    it('should reject missing container', function () {
      const error = validateMountConfig([{ host: '~/.foo' }]);
      assert.ok(error && error.includes('missing "container"'));
    });

    it('should reject invalid readonly type', function () {
      const error = validateMountConfig([{ host: '~/.foo', container: '/bar', readonly: 'yes' }]);
      assert.ok(error && error.includes('"readonly" must be a boolean'));
    });

    it('should reject non-array input', function () {
      const error = validateMountConfig('aws');
      assert.ok(error && error.includes('must be an array'));
    });
  });
}

function registerValidateEnvPassthroughTests() {
  describe('validateEnvPassthrough()', function () {
    it('should accept valid env var names', function () {
      assert.strictEqual(validateEnvPassthrough(['MY_VAR', 'OTHER_VAR']), null);
    });

    it('should accept pattern syntax', function () {
      assert.strictEqual(validateEnvPassthrough(['TF_VAR_*']), null);
    });

    it('should accept forced value syntax', function () {
      assert.strictEqual(validateEnvPassthrough(['AWS_PAGER=', 'TERM=xterm']), null);
    });

    it('should reject non-array input', function () {
      const error = validateEnvPassthrough('MY_VAR');
      assert.ok(error && error.includes('must be an array'));
    });

    it('should reject non-string items', function () {
      const error = validateEnvPassthrough([123]);
      assert.ok(error && error.includes('Must be a string'));
    });
  });
}

function registerValidateProviderEnvAuthTests() {
  describe('validateProviderEnvAuth()', function () {
    it('passes when no docker.envAuth is declared (e.g. codex)', function () {
      assert.deepStrictEqual(validateProviderEnvAuth('codex', {}), { ok: true });
    });

    it('is satisfied by a single requireOneOf var (e.g. OPENAI_API_KEY)', function () {
      const result = validateProviderEnvAuth('omp', { OPENAI_API_KEY: 'sk-test' });
      assert.deepStrictEqual(result, { ok: true });
    });

    it('rejects an empty-string value as absent', function () {
      const result = validateProviderEnvAuth('omp', { OPENAI_API_KEY: '' });
      assert.strictEqual(result.ok, false);
    });

    it('rejects nothing set at all', function () {
      const result = validateProviderEnvAuth('omp', {});
      assert.strictEqual(result.ok, false);
      assert.ok(!/sk-|tok-/.test(result.message), 'message must never contain credential values');
    });

    it('is satisfied by a complete requireTogether broker pair', function () {
      const result = validateProviderEnvAuth('omp', {
        OMP_AUTH_BROKER_URL: 'https://broker.example',
        OMP_AUTH_BROKER_TOKEN: 'tok-secret',
      });
      assert.deepStrictEqual(result, { ok: true });
    });

    it('rejects a broker URL without a token (partial requireTogether group)', function () {
      const result = validateProviderEnvAuth('omp', {
        OMP_AUTH_BROKER_URL: 'https://broker.example',
      });
      assert.strictEqual(result.ok, false);
      assert.ok(!result.message.includes('https://broker.example'), 'must name vars, not values');
    });

    it('rejects a broker token without a URL (partial requireTogether group)', function () {
      const result = validateProviderEnvAuth('omp', { OMP_AUTH_BROKER_TOKEN: 'tok-secret' });
      assert.strictEqual(result.ok, false);
      assert.ok(!result.message.includes('tok-secret'), 'must name vars, not values');
    });

    it('never includes credential values in the failure message, only names', function () {
      const result = validateProviderEnvAuth('omp', { GEMINI_API_KEY: '', OPENAI_API_KEY: '' });
      assert.strictEqual(result.ok, false);
      assert.match(result.message, /OPENAI_API_KEY/);
    });
  });
}

function registerAwsWorkflowTests() {
  describe('Integration: AWS workflow', function () {
    it('should correctly configure AWS mounts and envs', function () {
      // User configures: dockerMounts: ['aws']
      const mounts = resolveMounts(['aws'], { containerHome: '/root' });
      const envSpecs = resolveEnvs(['aws']);
      const expandedEnvs = expandEnvPatterns(envSpecs, {
        AWS_REGION: 'us-east-1',
        AWS_PROFILE: 'default',
      });

      // Mount should be correct
      assert.strictEqual(mounts[0].host, '~/.aws');
      assert.strictEqual(mounts[0].container, '/root/.aws');
      assert.strictEqual(mounts[0].readonly, true);

      // Envs should include forced AWS_PAGER and optional AWS_REGION
      const pager = expandedEnvs.find((e) => e.name === 'AWS_PAGER');
      const region = expandedEnvs.find((e) => e.name === 'AWS_REGION');

      assert.ok(pager && pager.forced && pager.value === '');
      assert.ok(region && !region.forced);
    });
  });
}

function registerCustomMountWorkflowTests() {
  describe('Integration: Custom mount workflow', function () {
    it('should correctly configure custom mounts', function () {
      const config = ['git', { host: '~/.myapp', container: '$HOME/.myapp', readonly: false }];

      const mounts = resolveMounts(config, { containerHome: '/home/node' });

      assert.strictEqual(mounts.length, 2);
      assert.strictEqual(mounts[0].container, '/home/node/.gitconfig');
      assert.strictEqual(mounts[1].host, '~/.myapp');
      assert.strictEqual(mounts[1].container, '/home/node/.myapp');
      assert.strictEqual(mounts[1].readonly, false);
    });
  });
}
