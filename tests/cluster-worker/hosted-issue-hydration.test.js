'use strict';

const assert = require('node:assert/strict');
const {
  hydrateIssueRequest,
  parseIssueNumber,
  renderIssue,
} = require('../../zeroshot-rust/hosted-node/issue-hydration');

const REPOSITORY = 'the-open-engine/private-demo';
const URL = `https://github.com/${REPOSITORY}/issues/13`;

function issue() {
  return {
    number: 13,
    title: 'Implement proration',
    body: 'Handle upgrades and downgrades atomically.',
    labels: [{ name: 'enhancement' }],
    assignees: [{ login: 'octocat' }],
    comments: [
      {
        author: { login: 'reviewer' },
        createdAt: '2026-08-12T10:00:00Z',
        body: 'Cover rollback behavior.',
      },
    ],
    url: URL,
  };
}

describe('private hosted issue hydration', () => {
  it('accepts only issue identifiers bound to the fixed repository', () => {
    assert.equal(parseIssueNumber(REPOSITORY, URL), 13);
    assert.equal(parseIssueNumber(REPOSITORY, `${REPOSITORY}#13`), 13);
    assert.equal(parseIssueNumber(REPOSITORY, '13'), 13);
    for (const invalid of [
      '0',
      '#13',
      'other/repository#13',
      'https://github.com/other/repository/issues/13',
      `${URL}/comments`,
    ]) {
      assert.throws(
        () => parseIssueNumber(REPOSITORY, invalid),
        /fixed repository authority|invalid/
      );
    }
  });

  it('renders the bounded issue context agents need without repository credentials', () => {
    const context = renderIssue(REPOSITORY, 13, issue());
    for (const expected of [
      URL,
      'Implement proration',
      'Handle upgrades and downgrades atomically.',
      '- enhancement',
      '- @octocat',
      'reviewer (2026-08-12T10:00:00.000Z)',
      'Cover rollback behavior.',
    ]) {
      assert.ok(context.includes(expected));
    }
  });

  it('converts issue input into an internal prompt after trusted retrieval', async () => {
    const request = Object.freeze({
      source: 'issue',
      issue: URL,
      prompt: null,
      artifacts: [],
      repository: REPOSITORY,
    });
    const calls = [];
    const hydrated = await hydrateIssueRequest({ repository: REPOSITORY }, request, {
      fetchIssue(repository, number) {
        calls.push([repository, number]);
        return issue();
      },
    });
    assert.deepEqual(calls, [[REPOSITORY, 13]]);
    assert.equal(hydrated.source, 'prompt');
    assert.equal(hydrated.issue, null);
    assert.match(hydrated.prompt, /Implement proration/);
    assert.equal(request.source, 'issue');
  });

  it('passes prompt input through without touching GitHub', async () => {
    const request = Object.freeze({ source: 'prompt', prompt: 'do work' });
    assert.equal(
      await hydrateIssueRequest({ repository: REPOSITORY }, request, {
        fetchIssue() {
          throw new Error('must not fetch');
        },
      }),
      request
    );
  });

  it('rejects mismatched responses and oversized issue content', () => {
    assert.throws(
      () => renderIssue(REPOSITORY, 13, { ...issue(), number: 14 }),
      /invalid hosted issue/
    );
    assert.throws(
      () =>
        renderIssue(REPOSITORY, 13, { ...issue(), url: 'https://github.com/other/repo/issues/13' }),
      /outside the fixed repository authority/
    );
    assert.throws(
      () => renderIssue(REPOSITORY, 13, { ...issue(), body: 'x'.repeat(512 * 1024) }),
      /supported size/
    );
  });
});
