const assert = require('node:assert').strict;

const {
  generateGitPusherAgent,
  getPlatformConfig,
  resolveGitHubConfig,
} = require('../src/agents/git-pusher-template');
const { MAX_PR_BODY_LENGTH, renderPullRequestBody } = require('../src/pr-body-template');

describe('git-pusher PR body rendering', function () {
  it('uses the issue reference by default and emits an empty body for manual tasks', function () {
    const issueAgent = generateGitPusherAgent('github', {
      issueNumber: 448,
      issueTitle: 'Body support',
    });
    const manualAgent = generateGitPusherAgent('github', {
      issueTitle: 'Manual task',
    });

    assert.match(issueAgent.prompt, /--body 'Closes #448'/);
    assert.match(manualAgent.prompt, /--body ''/);
    assert.doesNotMatch(manualAgent.prompt, /Closes #(unknown|N\/A)/);
  });

  it('expands all issue tokens to empty text when issue metadata is absent', function () {
    assert.strictEqual(
      renderPullRequestBody('{{issue_number}}|{{issue_title}}|{{issue_reference}}', {
        issueTitle: 'Manual task',
      }),
      '||'
    );
  });

  it('rejects NUL bytes and overlong source or rendered bodies', function () {
    assert.throws(() => renderPullRequestBody('bad\0body'), /NUL/);
    assert.throws(
      () => renderPullRequestBody('x'.repeat(MAX_PR_BODY_LENGTH + 1)),
      /must not exceed/
    );
    assert.throws(
      () =>
        renderPullRequestBody('{{issue_title}}'.repeat(4000), {
          issueNumber: 1,
          issueTitle: 'x'.repeat(20),
        }),
      /Rendered PR body must not exceed/
    );
  });
});

describe('git-pusher PR body platform commands', function () {
  it('uses the same safely quoted body for every supported platform', function () {
    const template = "Line one\nline ' two\n{{issue_reference}}";
    const resolved = resolveGitHubConfig({
      prBody: template,
      issueNumber: 'ABC-12',
      issueTitle: 'Cross-platform body',
    });

    for (const platform of ['github', 'gitlab', 'azure-devops']) {
      const command = getPlatformConfig(platform, resolved).createCmd;
      assert.ok(command.includes(`Line one\nline '`), `${platform} must retain multiline body`);
      assert.ok(command.includes('Closes #ABC-12'), `${platform} must render the issue reference`);
    }
  });
});
