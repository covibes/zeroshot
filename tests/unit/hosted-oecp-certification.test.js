'use strict';

const assert = require('node:assert/strict');
const {
  assertCertificationProvenance,
  assertStablePackageIsolation,
  parseArgs,
} = require('../../scripts/hosted-oecp-certification');

function provenanceFixture() {
  const expected = {
    sourceSha: 'a'.repeat(40),
    zeroCloudCommit: 'b'.repeat(40),
    runtimeImageDigest: `sha256:${'c'.repeat(64)}`,
    runtimeManifestDigest: 'd'.repeat(64),
  };
  const candidate = {
    ...expected,
    tarballDigest: `sha256:${'e'.repeat(64)}`,
  };
  const packageManifest = {
    name: '@the-open-engine/zeroshot-private-hosted-candidate',
    private: true,
    zeroshotPrivateCandidate: { ...expected },
  };
  return { candidate, expected, packageManifest };
}

describe('hosted candidate-to-image certification contracts', () => {
  it('requires an explicit zero-cloud commit and validates the image tag', () => {
    assert.deepEqual(parseArgs(['--zero-cloud-commit', 'a'.repeat(40)]), {
      imageTag: 'zeroshot-oecp:certification',
      zeroCloudCommit: 'a'.repeat(40),
    });
    assert.throws(() => parseArgs([]), /zero-cloud-commit/);
    assert.throws(
      () => parseArgs(['--zero-cloud-commit', 'a'.repeat(40), '--image-tag', '--bad']),
      /image-tag/
    );
  });

  it('rejects stable package leakage from every private certification surface', () => {
    const clean = { files: [{ path: 'cli/index.js' }, { path: 'scripts/check-path.js' }] };
    assert.doesNotThrow(() => assertStablePackageIsolation(clean));
    for (const leaked of [
      'private/hosted-cli-candidate/register.js',
      'docker/zeroshot-oecp/Dockerfile',
      'scripts/hosted-oecp-certification.js',
      'tests/private-hosted-cli/package-isolation.test.js',
      'PRIVATE_HOSTED_CANDIDATE.txt',
    ]) {
      assert.throws(
        () => assertStablePackageIsolation({ files: [...clean.files, { path: leaked }] }),
        /leaked private paths/
      );
    }
  });

  it('fails closed when candidate source, cloud, image, or manifest provenance differs', () => {
    const fixture = provenanceFixture();
    assert.doesNotThrow(() =>
      assertCertificationProvenance(fixture.candidate, fixture.packageManifest, fixture.expected)
    );
    for (const field of Object.keys(fixture.expected)) {
      const candidate = { ...fixture.candidate, [field]: 'different' };
      assert.throws(
        () => assertCertificationProvenance(candidate, fixture.packageManifest, fixture.expected),
        (error) => error.message.includes(field)
      );
      const packageManifest = {
        ...fixture.packageManifest,
        zeroshotPrivateCandidate: {
          ...fixture.packageManifest.zeroshotPrivateCandidate,
          [field]: 'different',
        },
      };
      assert.throws(
        () => assertCertificationProvenance(fixture.candidate, packageManifest, fixture.expected),
        (error) => error.message.includes(field)
      );
    }
  });
});
