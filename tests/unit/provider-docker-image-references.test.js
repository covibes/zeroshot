const {
  IsolationManager,
  OMP_DOCKER_PLATFORM,
  assert,
  assertValidImageReference,
  expectedVariantTag,
  getProviderMetadata,
} = require('../helpers/provider-docker-image-harness');

describe('IsolationManager: per-provider image selection', function () {
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
});
