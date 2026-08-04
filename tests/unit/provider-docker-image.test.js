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
} = require('../../lib/agent-cli-provider/omp/release');

// Mirrors IsolationManager.imageForProvider: the derived tag is built from the base reference's
// NAME (tag/digest stripped, registry port kept), while the hash covers the FULL base reference.
function expectedVariantTag(baseImage, providerId, platform, install) {
  const hash = crypto
    .createHash('sha256')
    .update(`${baseImage}\n${platform || ''}\n${install}`)
    .digest('hex')
    .slice(0, 12);
  const { name } = IsolationManager.parseImageReference(baseImage);
  return `${name}-${providerId}-${hash}`;
}

const REGISTRY_HOST = /^[a-z0-9.-]+(?::\d+)?$/;
const NAME_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^\w[\w.-]{0,127}$/;

/**
 * Assert `reference` is a Docker reference a `docker run`/`docker build -t` would accept —
 * checked by hand-splitting rather than through the production parser, so this stays an
 * independent oracle. Rejects the malformed shapes a naive `${base}-${provider}` suffix produces:
 * `…@sha256:<hex>-omp-<hash>` (a digest with trailing junk) and `…:v2-omp-<hash>` (the suffix
 * swallowed into the tag).
 */
function assertValidImageReference(reference) {
  assert.ok(!reference.includes('@'), `derived reference must carry no digest: ${reference}`);

  const segments = reference.split('/');
  const hasRegistry =
    segments.length > 1 && (segments[0].includes('.') || segments[0].includes(':'));
  if (hasRegistry) {
    assert.match(segments.shift(), REGISTRY_HOST);
  }

  const last = segments.pop();
  for (const segment of segments) {
    assert.match(segment, NAME_COMPONENT);
  }

  const [name, ...tagParts] = last.split(':');
  assert.match(name, NAME_COMPONENT);
  assert.ok(tagParts.length <= 1, `at most one tag separator: ${reference}`);
  if (tagParts.length === 1) {
    assert.match(tagParts[0], TAG);
  }
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

  // Greptile P1: appending `-<provider>-<hash>` straight onto the base reference produced an
  // invalid image reference whenever the base carried a digest or tag, so the isolated run could
  // never start. The name is now derived from the reference's NAME component only.
  describe('imageForProvider: digest / tag / registry-port base references', function () {
    const OMP_INSTALL = getProviderMetadata('omp').docker.install;
    const DIGEST = 'sha256:' + 'a'.repeat(64);

    it('strips a pinned digest instead of appending after it', function () {
      const base = `registry.example/base@${DIGEST}`;
      const derived = IsolationManager.imageForProvider('omp', base);

      assert.ok(!derived.includes('@'), `digest must not survive into the derived tag: ${derived}`);
      assertValidImageReference(derived);
      assert.strictEqual(
        derived,
        expectedVariantTag(base, 'omp', OMP_DOCKER_PLATFORM, OMP_INSTALL)
      );
      assert.ok(derived.startsWith('registry.example/base-omp-'));
    });

    it('strips a tag instead of reinterpreting it', function () {
      const base = 'zeroshot-cluster-base:v2';
      const derived = IsolationManager.imageForProvider('omp', base);

      assert.ok(!derived.includes(':v2'), `tag must not survive into the derived tag: ${derived}`);
      assertValidImageReference(derived);
      assert.ok(derived.startsWith('zeroshot-cluster-base-omp-'));
    });

    it('keeps a registry port, which belongs to the name and is not a tag', function () {
      const derived = IsolationManager.imageForProvider('omp', 'registry.example:5000/base');

      assert.ok(derived.startsWith('registry.example:5000/base-omp-'), derived);
      assertValidImageReference(derived);
    });

    it('keeps a registry port while stripping the tag after it', function () {
      const derived = IsolationManager.imageForProvider('omp', 'registry.example:5000/base:v2');

      assert.ok(derived.startsWith('registry.example:5000/base-omp-'), derived);
      assert.ok(!derived.includes(':v2'), derived);
      assertValidImageReference(derived);
    });

    it('keeps a registry port while stripping tag AND digest', function () {
      const derived = IsolationManager.imageForProvider(
        'omp',
        `registry.example:5000/team/base:v2@${DIGEST}`
      );

      assert.ok(derived.startsWith('registry.example:5000/team/base-omp-'), derived);
      assert.ok(!derived.includes('@') && !derived.includes(':v2'), derived);
      assertValidImageReference(derived);
    });

    // The full base reference is part of the cache identity: two different pins of the same base
    // NAME must not share one cached derived tag.
    it('gives different digests of the same base name distinct derived tags', function () {
      const a = IsolationManager.imageForProvider(
        'omp',
        `registry.example/base@sha256:${'a'.repeat(64)}`
      );
      const b = IsolationManager.imageForProvider(
        'omp',
        `registry.example/base@sha256:${'b'.repeat(64)}`
      );
      assert.notStrictEqual(a, b);
    });

    it('gives different tags of the same base name distinct derived tags', function () {
      assert.notStrictEqual(
        IsolationManager.imageForProvider('omp', 'base:v1'),
        IsolationManager.imageForProvider('omp', 'base:v2')
      );
    });

    it('gives an untagged base and a tagged base distinct derived tags', function () {
      assert.notStrictEqual(
        IsolationManager.imageForProvider('omp', 'base'),
        IsolationManager.imageForProvider('omp', 'base:v1')
      );
    });

    it('is stable for the same base reference', function () {
      const base = `registry.example:5000/base:v2@${DIGEST}`;
      assert.strictEqual(
        IsolationManager.imageForProvider('omp', base),
        IsolationManager.imageForProvider('omp', base)
      );
    });

    it('passes a digest-pinned base straight through for a baked-in provider (claude)', function () {
      // Claude has no docker.install, so it runs the requested image verbatim — including its pin.
      const base = `registry.example/base@${DIGEST}`;
      assert.strictEqual(IsolationManager.imageForProvider('claude', base), base);
    });
  });

  describe('parseImageReference', function () {
    it('parses a bare name', function () {
      assert.deepStrictEqual(IsolationManager.parseImageReference('base'), {
        name: 'base',
        tag: null,
        digest: null,
      });
    });

    it('parses name:tag', function () {
      assert.deepStrictEqual(IsolationManager.parseImageReference('base:v2'), {
        name: 'base',
        tag: 'v2',
        digest: null,
      });
    });

    it('treats a colon before the last slash as a registry port, not a tag', function () {
      assert.deepStrictEqual(IsolationManager.parseImageReference('registry.example:5000/base'), {
        name: 'registry.example:5000/base',
        tag: null,
        digest: null,
      });
    });

    it('parses registry:port/name:tag', function () {
      assert.deepStrictEqual(
        IsolationManager.parseImageReference('registry.example:5000/base:v2'),
        { name: 'registry.example:5000/base', tag: 'v2', digest: null }
      );
    });

    it('parses a digest-pinned reference', function () {
      const digest = 'sha256:' + 'c'.repeat(64);
      assert.deepStrictEqual(
        IsolationManager.parseImageReference(`registry.example/base@${digest}`),
        { name: 'registry.example/base', tag: null, digest }
      );
    });

    it('parses tag and digest together', function () {
      const digest = 'sha256:' + 'd'.repeat(64);
      assert.deepStrictEqual(
        IsolationManager.parseImageReference(`registry.example:5000/team/base:v2@${digest}`),
        { name: 'registry.example:5000/team/base', tag: 'v2', digest }
      );
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
