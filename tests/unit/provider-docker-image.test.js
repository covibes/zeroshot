/**
 * Test: per-provider Docker image selection
 *
 * Providers whose CLI is not baked into the base image (copilot, codex, gemini, omp) run on a
 * per-provider image variant `<base>-<provider>-<installHash>` whose CLI install is a
 * Docker-cached build layer. The install command participates in the tag so a registry change
 * (e.g. bumping a package version) invalidates the cached image instead of `ensureImage` reusing
 * a stale one. Providers baked into the base image (claude) — or with no single-command
 * installer (opencode) — run on the base image directly.
 *
 * The install command is sourced from the provider registry (docker.install), never hardcoded
 * here, so this stays general-purpose across current and future providers.
 */

const assert = require('assert');
const crypto = require('crypto');
const IsolationManager = require('../../src/isolation-manager');
const { getProviderMetadata } = require('../../lib/provider-names');

function installTag(install) {
  return crypto.createHash('sha256').update(install).digest('hex').slice(0, 12);
}

describe('IsolationManager: per-provider image selection', function () {
  describe('imageForProvider', function () {
    it('returns the base image for a provider baked into it (claude)', function () {
      assert.strictEqual(IsolationManager.imageForProvider('claude'), 'zeroshot-cluster-base');
    });

    it('returns a per-provider variant hashed from the registry install command (copilot)', function () {
      const install = getProviderMetadata('copilot').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('copilot'),
        `zeroshot-cluster-base-copilot-${installTag(install)}`
      );
    });

    it('returns a per-provider variant for codex', function () {
      const install = getProviderMetadata('codex').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('codex'),
        `zeroshot-cluster-base-codex-${installTag(install)}`
      );
    });

    it('honors a custom base image when building the variant name', function () {
      const install = getProviderMetadata('copilot').docker.install;
      assert.strictEqual(
        IsolationManager.imageForProvider('copilot', 'my-base'),
        `my-base-copilot-${installTag(install)}`
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

    it('changes the tag when the install command changes', function () {
      const tagA = installTag('npm install -g foo@1.0.0');
      const tagB = installTag('npm install -g foo@2.0.0');
      assert.notStrictEqual(tagA, tagB);
    });

    it('matches /^zeroshot-cluster-base-omp-[0-9a-f]{12}$/ for omp', function () {
      assert.match(
        IsolationManager.imageForProvider('omp'),
        /^zeroshot-cluster-base-omp-[0-9a-f]{12}$/
      );
    });
  });

  describe('providerBuildArgs', function () {
    it('returns no build args for a baked-in provider (claude)', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('claude'), []);
    });

    it('emits PROVIDER_INSTALL for copilot from the registry command', function () {
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

    it('emits PROVIDER_INSTALL for omp containing bun and the package name', function () {
      const [buildArg] = IsolationManager.providerBuildArgs('omp');
      assert.ok(buildArg.startsWith('PROVIDER_INSTALL='));
      assert.ok(buildArg.includes('bun'), `expected 'bun' in: ${buildArg}`);
      assert.ok(
        buildArg.includes('@oh-my-pi/pi-coding-agent'),
        `expected '@oh-my-pi/pi-coding-agent' in: ${buildArg}`
      );
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('omp'), [
        `PROVIDER_INSTALL=${getProviderMetadata('omp').docker.install}`,
      ]);
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
});
