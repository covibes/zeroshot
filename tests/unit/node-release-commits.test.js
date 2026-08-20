const assert = require('node:assert/strict');

const { analyzeNodeCommits } = require('../../scripts/node-release-analyzer');
const { filterNodeCommits } = require('../../scripts/node-release-commits');

const commits = [
  { hash: 'aaaaaaa', message: 'feat: native product change' },
  { hash: 'bbbbbbb', message: 'fix: Node product change' },
  {
    hash: 'ccccccc',
    message: 'feat: shared protocol change\n\nBREAKING CHANGE: replace the wire contract',
  },
  { message: 'fix: unclassified commit' },
];

function pathsForCommit(hash) {
  return {
    aaaaaaa: ['zeroshot-rust/src/main.rs'],
    bbbbbbb: ['src/orchestrator.js'],
    ccccccc: ['crates/openengine-cluster-protocol/src/graph.rs'],
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
