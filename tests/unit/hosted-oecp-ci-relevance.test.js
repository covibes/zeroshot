'use strict';

const assert = require('node:assert');
const {
  comparisonChanges,
  comparisonForEvent,
  relevantPaths,
} = require('../../scripts/hosted-oecp-ci-relevance');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function scriptedGit(outcomes) {
  const calls = [];
  return {
    calls,
    runner(program, args, options) {
      calls.push({ args, options, program });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error('Unexpected git invocation');
      return { stdout: '', ...outcome };
    },
  };
}

function assertArgvOnly(calls) {
  for (const call of calls) {
    assert.strictEqual(call.program, 'git');
    assert.ok(Array.isArray(call.args));
    assert.ok(call.args.every((argument) => typeof argument === 'string'));
    assert.strictEqual(call.options.shell, undefined);
  }
}

describe('hosted OECP CI event and SHA parsing', function () {
  it('derives deterministic comparisons for every CI event', function () {
    assert.deepStrictEqual(
      comparisonForEvent('pull_request', {
        pull_request: { base: { sha: BASE }, head: { sha: HEAD } },
      }),
      { base: BASE, head: HEAD, mergeBase: true }
    );
    assert.deepStrictEqual(
      comparisonForEvent('merge_group', {
        merge_group: { base_sha: BASE, head_sha: HEAD },
      }),
      { base: BASE, head: HEAD }
    );
    assert.deepStrictEqual(comparisonForEvent('push', { before: BASE, after: HEAD }), {
      base: BASE,
      head: HEAD,
    });
    assert.deepStrictEqual(comparisonForEvent('push', { before: '0'.repeat(40), after: HEAD }), {
      forced: true,
      reason: 'push has no base commit',
    });
    assert.deepStrictEqual(comparisonForEvent('workflow_dispatch', {}), {
      forced: true,
      reason: 'manual workflow dispatch',
    });
    assert.throws(
      () => comparisonForEvent('pull_request', { pull_request: {} }),
      /not a commit SHA/
    );
    const git = scriptedGit([]);
    assert.throws(
      () => comparisonChanges({ base: '--upload-pack=payload', head: HEAD }, '/repo', git.runner),
      /not a commit SHA/
    );
    assert.deepStrictEqual(git.calls, []);
  });
});

describe('hosted OECP comparison availability', function () {
  it('conservatively runs when the base commit cannot be materialized', function () {
    const git = scriptedGit([{ status: 1 }, { status: 1 }]);
    assert.deepStrictEqual(comparisonChanges({ base: BASE, head: HEAD }, '/repo', git.runner), {
      forced: true,
      reason: 'base commit is unavailable',
    });
    assert.deepStrictEqual(git.calls[1].args, [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=1',
      'origin',
      BASE,
    ]);
    assertArgvOnly(git.calls);
  });

  it('conservatively runs when the head commit cannot be materialized', function () {
    const git = scriptedGit([{ status: 0 }, { status: 1 }, { status: 1 }]);
    assert.deepStrictEqual(comparisonChanges({ base: BASE, head: HEAD }, '/repo', git.runner), {
      forced: true,
      reason: 'head commit is unavailable',
    });
    assert.strictEqual(git.calls[2].args.at(-1), HEAD);
    assertArgvOnly(git.calls);
  });

  it('conservatively runs with a bounded reason when the diff fails', function () {
    const git = scriptedGit([
      { status: 0 },
      { status: 0 },
      { status: 1, stderr: 'sensitive git diagnostic' },
    ]);
    const result = comparisonChanges(
      { base: BASE, head: HEAD, mergeBase: true },
      '/repo',
      git.runner
    );
    assert.deepStrictEqual(result, { forced: true, reason: 'commit comparison failed' });
    assert.ok(!result.reason.includes('sensitive'));
    assert.deepStrictEqual(git.calls[2].args, [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      `${BASE}...${HEAD}`,
      '--',
    ]);
    assertArgvOnly(git.calls);
  });

  it('rechecks a fetched commit before comparing paths', function () {
    const git = scriptedGit([
      { status: 1 },
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: 'docker/zeroshot-oecp/Dockerfile\0' },
    ]);
    assert.deepStrictEqual(comparisonChanges({ base: BASE, head: HEAD }, '/repo', git.runner), {
      changed: ['docker/zeroshot-oecp/Dockerfile'],
    });
    assert.deepStrictEqual(git.calls[2].args, ['cat-file', '-e', `${BASE}^{commit}`]);
    assertArgvOnly(git.calls);
  });
});

describe('hosted OECP path matching', function () {
  it('matches image inputs and directories without matching unrelated paths', function () {
    const changed = [
      'docs/hosted-oecp.md',
      'scripts/hosted-oecp-ci-relevance.js',
      'crates/openengine-cluster-protocol/src/lib.rs',
      'docker/zeroshot-oecp/package-lock.json',
      'docs/unrelated.md',
    ];
    assert.deepStrictEqual(
      relevantPaths(changed, [
        'crates',
        'docker/zeroshot-oecp/package-lock.json',
        'scripts/hosted-oecp-ci-relevance.js',
      ]),
      [
        'scripts/hosted-oecp-ci-relevance.js',
        'crates/openengine-cluster-protocol/src/lib.rs',
        'docker/zeroshot-oecp/package-lock.json',
      ]
    );
  });
});
