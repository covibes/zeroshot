const assert = require('assert');
const sinon = require('sinon');

const safeExec = require('../src/lib/safe-exec');

const jiraProviderPath = require.resolve('../src/issue-providers/jira-provider');

describe('JiraProvider.fetchIssue', function () {
  let execSyncStub;
  let JiraProvider;
  let originalJiraProviderCacheEntry;
  let jiraProviderCacheCaptured = false;
  let jiraProviderCacheReplaced = false;

  beforeEach(function () {
    originalJiraProviderCacheEntry = require.cache[jiraProviderPath];
    jiraProviderCacheCaptured = true;

    // Stub before requiring so the provider's destructured `execSync` is the stub.
    execSyncStub = sinon.stub(safeExec, 'execSync');
    delete require.cache[jiraProviderPath];
    jiraProviderCacheReplaced = true;
    JiraProvider = require(jiraProviderPath);
  });

  afterEach(function () {
    const cacheWasCaptured = jiraProviderCacheCaptured;
    const cacheWasReplaced = jiraProviderCacheReplaced;
    const cacheEntryToRestore = originalJiraProviderCacheEntry;

    try {
      sinon.restore();
    } finally {
      if (cacheWasReplaced) {
        delete require.cache[jiraProviderPath];
        if (cacheEntryToRestore) {
          require.cache[jiraProviderPath] = cacheEntryToRestore;
        }
      }

      originalJiraProviderCacheEntry = undefined;
      jiraProviderCacheCaptured = false;
      jiraProviderCacheReplaced = false;

      if (cacheWasCaptured) {
        assert.strictEqual(require.cache[jiraProviderPath], cacheEntryToRestore);
      }
    }
  });

  it('fetches an issue with the supported jira view command and parses its JSON', function () {
    execSyncStub.returns(
      JSON.stringify({
        key: 'PROJ-123',
        fields: {
          summary: 'Correct the Jira command',
          description: 'Use the supported go-jira command.',
          labels: ['bug'],
          comment: {
            comments: [
              {
                author: { displayName: 'Justin Carter' },
                created: '2026-03-09T19:42:24.000Z',
                body: 'Ready to verify.',
              },
            ],
          },
          self: 'https://company.atlassian.net/rest/api/2/issue/PROJ-123',
        },
      })
    );

    const issue = new JiraProvider().fetchIssue('PROJ-123', {});

    sinon.assert.calledOnceWithExactly(
      execSyncStub,
      'jira view PROJ-123 --template json',
      { encoding: 'utf8' }
    );
    assert.deepStrictEqual(issue, {
      number: 123,
      title: 'Correct the Jira command',
      body: 'Use the supported go-jira command.',
      labels: [{ name: 'bug' }],
      comments: [
        {
          author: { login: 'Justin Carter' },
          createdAt: '2026-03-09T19:42:24.000Z',
          body: 'Ready to verify.',
        },
      ],
      url: 'https://company.atlassian.net/rest/api/2/issue/PROJ-123',
      context:
        '# Jira Issue PROJ-123\n\n' +
        '## Title\nCorrect the Jira command\n\n' +
        '## Description\nUse the supported go-jira command.\n\n' +
        '## Labels\n- bug\n\n' +
        '## Comments\n\n' +
        '### Justin Carter (2026-03-09T19:42:24.000Z)\n' +
        'Ready to verify.\n\n',
    });
  });
});
