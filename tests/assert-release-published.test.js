const assert = require('assert');

const {
  latestReleaseTag,
  provenanceStatement,
  verifyInstalledCli,
  verifyProvenance,
} = require('../scripts/assert-release-published');
const { releaseTypeForMessages } = require('../scripts/release-preflight');

describe('release publication assertion', () => {
  it('selects the highest semver release tag on HEAD', () => {
    assert.strictEqual(latestReleaseTag(['v6.5.0', 'v6.6.0']), 'v6.6.0');
    assert.strictEqual(latestReleaseTag(['v6.10.0', 'v6.9.9']), 'v6.10.0');
  });

  it('ignores non-release tags', () => {
    assert.strictEqual(latestReleaseTag(['nightly', 'v6.6.0-beta.1', 'v6.6.0']), 'v6.6.0');
    assert.strictEqual(latestReleaseTag(['nightly']), null);
  });

  it('distinguishes intentional trunk no-ops from missing releases', () => {
    assert.strictEqual(releaseTypeForMessages(['docs: update publishing guide']), null);
    assert.strictEqual(releaseTypeForMessages(['fix: repair release']), 'patch');
  });

  it('requires provenance from the Zeroshot release workflow and exact commit', () => {
    const statement = {
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: 'https://github.com/the-open-engine/zeroshot',
              path: '.github/workflows/release.yml',
            },
          },
          resolvedDependencies: [{ digest: { gitCommit: 'a'.repeat(40) } }],
        },
      },
    };

    assert.doesNotThrow(() => verifyProvenance(statement, 'a'.repeat(40)));
    assert.throws(() => verifyProvenance(statement, 'b'.repeat(40)), /does not resolve/);
  });

  it('decodes the SLSA provenance statement from npm attestations', () => {
    const statement = { predicateType: 'https://slsa.dev/provenance/v1' };
    const attestations = {
      attestations: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
            },
          },
        },
      ],
    };

    assert.deepStrictEqual(provenanceStatement(attestations), statement);
  });

  it('verifies the published CLI through a clean global-prefix install', () => {
    const calls = [];
    const execute = (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('--version')) return 'zeroshot 6.7.2';
      return '';
    };
    let removed = null;

    verifyInstalledCli('@the-open-engine/zeroshot', '6.7.2', {
      execute,
      makeTempRoot: () => '/tmp/zeroshot-release-proof',
      removeTempRoot: (root) => {
        removed = root;
      },
      platform: 'linux',
    });

    assert.deepStrictEqual(calls[0], {
      command: 'npm',
      args: [
        'install',
        '--global',
        '--prefix',
        '/tmp/zeroshot-release-proof',
        '--no-audit',
        '--no-fund',
        '@the-open-engine/zeroshot@6.7.2',
      ],
      options: undefined,
    });
    assert.deepStrictEqual(
      calls.slice(1).map(({ command, args }) => ({ command, args })),
      [
        {
          command: '/tmp/zeroshot-release-proof/bin/zeroshot',
          args: ['--version'],
        },
        {
          command: '/tmp/zeroshot-release-proof/bin/zeroshot',
          args: ['--help'],
        },
        {
          command: '/tmp/zeroshot-release-proof/bin/zeroshot',
          args: ['list'],
        },
      ]
    );
    assert.strictEqual(removed, '/tmp/zeroshot-release-proof');
  });

  it('cleans up the temporary install when CLI verification fails', () => {
    let removed = null;

    assert.throws(
      () =>
        verifyInstalledCli('@the-open-engine/zeroshot', '6.7.2', {
          execute: (command, args) => {
            if (args.includes('--version')) return 'zeroshot 6.7.1';
            return '';
          },
          makeTempRoot: () => '/tmp/zeroshot-release-proof-failure',
          removeTempRoot: (root) => {
            removed = root;
          },
          platform: 'linux',
        }),
      /expected 6.7.2/
    );
    assert.strictEqual(removed, '/tmp/zeroshot-release-proof-failure');
  });
});
