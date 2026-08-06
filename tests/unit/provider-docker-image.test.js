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

const {
  IsolationManager,
  OMP_DOCKER_PLATFORM,
  assert,
  crypto,
  expectedVariantTag,
  getProviderMetadata,
} = require('../helpers/provider-docker-image-harness');

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
      const install = getProviderMetadata('omp').docker.install;
      const hashWithoutPlatform = crypto
        .createHash('sha256')
        .update(`zeroshot-cluster-base\n\n${install}`)
        .digest('hex')
        .slice(0, 12);
      assert.notStrictEqual(
        IsolationManager.imageForProvider('omp'),
        `zeroshot-cluster-base-omp-${hashWithoutPlatform}`
      );
    });
  });
});
