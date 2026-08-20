const assert = require('node:assert/strict');

const { analyzeNodeCommits } = require('../../scripts/node-release-analyzer');
const { filterNodeCommits, hasNodeReleaseCommit } = require('../../scripts/node-release-commits');

const commits = [
  { hash: 'aaaaaaa', message: 'feat: native product change' },
  { hash: 'bbbbbbb', message: 'fix: Node product change' },
  {
    hash: 'ccccccc',
    message: 'feat: shared protocol change\n\nBREAKING CHANGE: replace the wire contract',
  },
  { hash: 'ddddddd', message: 'feat(rust): document the native product' },
  { hash: 'eeeeeee', message: 'feat(v2): update native contributor guidance' },
  { message: 'fix: unclassified commit' },
];

function pathsForCommit(hash) {
  return {
    aaaaaaa: ['zeroshot-rust/src/main.rs'],
    bbbbbbb: ['src/orchestrator.js'],
    ccccccc: ['crates/openengine-cluster-protocol/src/graph.rs'],
    ddddddd: ['zeroshot-rust/src/main.rs', 'README.md'],
    eeeeeee: ['zeroshot-rust/src/main.rs', 'AGENTS.md', '.dockerignore'],
  }[hash];
}

describe('Node release commit ownership', function () {
  it('filters Rust-only commits while retaining Node, shared, and unclassifiable commits', function () {
    const messages = filterNodeCommits(commits, { pathsForCommit }).map((commit) => commit.message);
    assert.deepStrictEqual(messages, [
      'fix: Node product change',
      'feat: shared protocol change\n\nBREAKING CHANGE: replace the wire contract',
      'fix: unclassified commit',
    ]);
  });

  it('finds pending Node work even when a Rust-only commit is the tested head', function () {
    assert.equal(hasNodeReleaseCommit([commits[1], commits[0]], { pathsForCommit }), true);
    assert.equal(
      hasNodeReleaseCommit([commits[0], commits[3], commits[4]], { pathsForCommit }),
      false
    );
  });

  it('derives Node semantic versions only from Node-relevant history', async function () {
    const logger = { log() {} };
    const context = { commits, cwd: process.cwd(), logger };
    const analyzer = await import('@semantic-release/commit-analyzer');

    assert.strictEqual(
      await analyzeNodeCommits({}, context, { analyzer, pathsForCommit }),
      'major'
    );
    assert.strictEqual(
      await analyzeNodeCommits(
        {},
        { ...context, commits: [commits[0]] },
        { analyzer, pathsForCommit }
      ),
      null
    );
    assert.strictEqual(
      await analyzeNodeCommits(
        {},
        { ...context, commits: [commits[1]] },
        { analyzer, pathsForCommit }
      ),
      'patch'
    );
  });
});
