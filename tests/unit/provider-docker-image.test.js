/**
 * Test: per-provider Docker image selection
 *
 * Providers whose CLI is not baked into the base image (copilot, codex, gemini, omp) run on a
 * per-provider image variant `<base>-<provider>-<hash>` whose CLI install is a Docker-cached
 * build layer. The hash is derived from the install command and registry-owned platform so a
 * pinned-version/platform change busts the cached tag. Providers baked into the base image
 * (claude) — or with no single-command installer (opencode) — run on the base image directly.
 *
 * The install command is sourced from the provider registry (docker.install), never hardcoded
 * here, so this stays general-purpose across current and future providers.
 */

const assert = require('assert');
const crypto = require('crypto');
const IsolationManager = require('../../src/isolation-manager');
const { getProviderMetadata } = require('../../lib/provider-names');
const {
  OMP_DOCKER_INSTALL_COMMAND,
  OMP_DOCKER_PLATFORM,
  OMP_RELEASE_DOWNLOAD_BASE_URL,
  OMP_SUPPORTED_VERSION,
  findOmpReleaseAsset,
} = require('../../lib/agent-cli-provider/omp-release');

function expectedVariantTag(baseImage, providerId, platform, install) {
  const hash = crypto
    .createHash('sha256')
    .update(`${platform || ''}\n${install}`)
    .digest('hex')
    .slice(0, 12);
  return `${baseImage}-${providerId}-${hash}`;
}

describe('IsolationManager: per-provider image selection', function () {
  describe('imageForProvider', function () {
    it('returns the base image for a provider baked into it (claude)', function () {
      assert.strictEqual(IsolationManager.imageForProvider('claude'), 'zeroshot-cluster-base');
    });

    it('returns an install-identity-hashed variant for a provider with docker.install (copilot)', function () {
      const install = getProviderMetadata('copilot').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('copilot'),
        expectedVariantTag('zeroshot-cluster-base', 'copilot', null, install)
      );
    });

    it('returns a hashed variant for codex', function () {
      const install = getProviderMetadata('codex').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('codex'),
        expectedVariantTag('zeroshot-cluster-base', 'codex', null, install)
      );
    });

    it('honors a custom base image when building the variant name', function () {
      const install = getProviderMetadata('copilot').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('copilot', 'my-base'),
        expectedVariantTag('my-base', 'copilot', null, install)
      );
    });

    it('normalizes provider aliases to the canonical image (no duplicate per alias)', function () {
      // `openai` is an alias of `codex`; both must resolve to the same variant image so we don't
      // build a redundant `-openai` image alongside `-codex`.
      assert.strictEqual(
        IsolationManager.imageForProvider('openai'),
        IsolationManager.imageForProvider('codex')
      );
    });

    it('falls back to the base image for a provider with no docker.install (opencode)', function () {
      assert.strictEqual(IsolationManager.imageForProvider('opencode'), 'zeroshot-cluster-base');
    });

    it('bakes the registry-owned platform into the hash for omp (linux/amd64)', function () {
      const install = getProviderMetadata('omp').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('omp'),
        expectedVariantTag('zeroshot-cluster-base', 'omp', OMP_DOCKER_PLATFORM, install)
      );
    });

    it('changes the omp tag if the platform-independent hash inputs change', function () {
      // Regression guard: the tag must not collapse to the same value as a platform-less provider
      // that happens to share an install-command length; omp's tag must be platform-scoped.
      const withoutPlatform = expectedVariantTag(
        'zeroshot-cluster-base',
        'omp',
        null,
        getProviderMetadata('omp').docker.install
      );
      assert.notStrictEqual(IsolationManager.imageForProvider('omp'), withoutPlatform);
    });
  });

  describe('providerBuildArgs', function () {
    it('returns no build args for a baked-in provider (claude)', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('claude'), []);
    });

    it('emits PROVIDER_INSTALL for copilot from the registry command (no config roots)', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('copilot'), [
        'PROVIDER_INSTALL=npm install -g @github/copilot',
      ]);
    });

    it('emits PROVIDER_INSTALL for codex from the registry command', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('codex'), [
        'PROVIDER_INSTALL=npm install -g @openai/codex',
      ]);
    });

    it('matches the value the registry advertises (no hardcoded drift)', function () {
      const registryInstall = getProviderMetadata('copilot').docker.install;
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('copilot'), [
        `PROVIDER_INSTALL=${registryInstall}`,
      ]);
    });

    it('emits the pinned digest-verified install command plus PROVIDER_CONFIG_ROOTS for omp', function () {
      const args = IsolationManager.providerBuildArgs('omp');
      assert.strictEqual(args.length, 2);
      assert.strictEqual(args[0], `PROVIDER_INSTALL=${OMP_DOCKER_INSTALL_COMMAND}`);
      assert.strictEqual(args[1], 'PROVIDER_CONFIG_ROOTS=/home/node/.omp');

      const asset = findOmpReleaseAsset('linux-x64');
      assert.ok(args[0].includes(`${OMP_RELEASE_DOWNLOAD_BASE_URL}/${asset.name}`));
      assert.ok(args[0].includes(asset.sha256));
      assert.ok(args[0].includes('sha256sum -c -'));
      assert.ok(args[0].includes(`"$v" = "${OMP_SUPPORTED_VERSION}"`));
      assert.ok(args[0].includes('omp --version'));
    });

    it('honors a custom containerHome for PROVIDER_CONFIG_ROOTS', function () {
      const args = IsolationManager.providerBuildArgs('omp', '/root');
      assert.ok(args.includes('PROVIDER_CONFIG_ROOTS=/root/.omp'));
    });
  });

  describe('registry docker.install', function () {
    it('is set for npm-installable providers and absent for baked-in claude', function () {
      assert.ok(
        getProviderMetadata('copilot').docker.install,
        'copilot should have docker.install'
      );
      assert.ok(getProviderMetadata('codex').docker.install, 'codex should have docker.install');
      assert.ok(getProviderMetadata('gemini').docker.install, 'gemini should have docker.install');
      assert.ok(getProviderMetadata('omp').docker.install, 'omp should have docker.install');
      assert.strictEqual(
        getProviderMetadata('claude').docker.install,
        undefined,
        'claude is baked into the base image and must not declare docker.install'
      );
    });
  });

  describe('registry docker.platform', function () {
    it('is set to linux/amd64 for omp only', function () {
      assert.strictEqual(getProviderMetadata('omp').docker.platform, 'linux/amd64');
      assert.strictEqual(getProviderMetadata('claude').docker.platform, undefined);
      assert.strictEqual(getProviderMetadata('copilot').docker.platform, undefined);
    });

    it('IsolationManager.providerDockerPlatform reads it from the registry', function () {
      assert.strictEqual(IsolationManager.providerDockerPlatform('omp'), 'linux/amd64');
      assert.strictEqual(IsolationManager.providerDockerPlatform('claude'), null);
    });
  });

  describe('registry docker.configRoots', function () {
    it('is set to $HOME/.omp for omp only', function () {
      assert.deepStrictEqual(getProviderMetadata('omp').docker.configRoots, ['$HOME/.omp']);
      assert.strictEqual(getProviderMetadata('claude').docker.configRoots, undefined);
    });

    it('IsolationManager.providerConfigRoots expands $HOME to containerHome', function () {
      assert.deepStrictEqual(IsolationManager.providerConfigRoots('omp', '/home/node'), [
        '/home/node/.omp',
      ]);
      assert.deepStrictEqual(IsolationManager.providerConfigRoots('claude', '/home/node'), []);
    });
  });
});
