const assert = require('assert');

const {
  analyzeMessage,
  maxReleaseType,
  releaseTypeForMessages,
  validateReleaseConfig,
} = require('../scripts/release-preflight');

describe('release preflight', () => {
  it('does not retain the retired release-promotion commit type', () => {
    assert.strictEqual(analyzeMessage('release: promote dev to main'), null);
    assert.strictEqual(analyzeMessage('release(main): promote dev to main'), null);
  });

  it('classifies conventional breaking commits as majors', () => {
    assert.strictEqual(analyzeMessage('feat!: replace release flow'), 'major');
    assert.strictEqual(
      analyzeMessage('fix: repair release\n\nBREAKING CHANGE: config moved'),
      'major'
    );
  });

  it('preserves the highest release type found', () => {
    assert.strictEqual(maxReleaseType('patch', 'minor'), 'minor');
    assert.strictEqual(maxReleaseType('minor', 'patch'), 'minor');
    assert.strictEqual(maxReleaseType('minor', 'major'), 'major');
  });

  it('allows trunk commits that intentionally produce no publication', () => {
    assert.strictEqual(
      releaseTypeForMessages(['docs: clarify setup', 'chore: refresh fixtures']),
      null
    );
    assert.strictEqual(
      releaseTypeForMessages(['docs: clarify setup', 'fix: repair attach']),
      'patch'
    );
  });

  it('rejects branch-writing plugins in the effective release config', () => {
    assert.throws(
      () =>
        validateReleaseConfig({
          release: {
            branches: ['main'],
            plugins: [
              '@semantic-release/commit-analyzer',
              './scripts/semantic-release-notes.js',
              ['@semantic-release/npm', { npmPublish: true }],
              '@semantic-release/git',
              '@semantic-release/github',
            ],
          },
        }),
      /must not be in the effective release config/
    );
  });

  it('rejects custom analyzer rules that would distort semantic versioning', () => {
    assert.throws(
      () =>
        validateReleaseConfig({
          release: {
            branches: ['main'],
            plugins: [
              [
                '@semantic-release/commit-analyzer',
                { releaseRules: [{ type: 'release', release: 'minor' }] },
              ],
              './scripts/semantic-release-notes.js',
              ['@semantic-release/npm', { npmPublish: true }],
              '@semantic-release/github',
            ],
          },
        }),
      /standard conventional release rules/
    );
  });

  it('accepts the protected-main release config', () => {
    const plugins = validateReleaseConfig({
      release: {
        branches: ['main'],
        plugins: [
          '@semantic-release/commit-analyzer',
          './scripts/semantic-release-notes.js',
          ['@semantic-release/npm', { npmPublish: true }],
          '@semantic-release/github',
        ],
      },
    });

    assert.deepStrictEqual(plugins, [
      '@semantic-release/commit-analyzer',
      './scripts/semantic-release-notes.js',
      '@semantic-release/npm',
      '@semantic-release/github',
    ]);
  });
});
