const assert = require('assert');

const {
  parseReleaseTag,
  validateCommit,
  verifyExistingNpmVersion,
} = require('../../scripts/release-recovery');

describe('release recovery', function () {
  it('accepts stable semantic release tags', function () {
    assert.strictEqual(parseReleaseTag('v6.7.2'), '6.7.2');
  });

  it('rejects malformed tags and abbreviated commits', function () {
    assert.throws(() => parseReleaseTag('release/6.7.2'), /must match vX.Y.Z/);
    assert.throws(() => validateCommit('abc123'), /full lowercase commit SHA/);
  });

  it('accepts only matching npm provenance', function () {
    assert.doesNotThrow(() =>
      verifyExistingNpmVersion(
        {
          version: '6.7.2',
          gitHead: 'a'.repeat(40),
          'dist.attestations': { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
        },
        '6.7.2',
        'a'.repeat(40)
      )
    );
    assert.throws(
      () =>
        verifyExistingNpmVersion(
          {
            version: '6.7.2',
            gitHead: 'b'.repeat(40),
            'dist.attestations': { provenance: {} },
          },
          '6.7.2',
          'a'.repeat(40)
        ),
      /gitHead/
    );
  });
});
