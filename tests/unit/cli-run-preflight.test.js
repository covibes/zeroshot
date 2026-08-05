const assert = require('assert');

const { runClusterPreflight } = require('../../cli/index');

describe('runClusterPreflight effective plan', function () {
  async function capture(options, settings) {
    let received;
    await runClusterPreflight({
      input: { text: 'task' },
      options,
      settings,
      providerOverride: 'claude',
      forceProvider: null,
      deps: {
        requirePreflight: (value) => {
          received = value;
        },
      },
    });
    return received;
  }

  it('derives Docker, worktree, PR, and local gates from the effective plan', async function () {
    const docker = await capture({}, { defaultIsolation: 'docker' });
    assert.strictEqual(docker.requireDocker, true);
    assert.strictEqual(docker.requireGit, false);
    assert.strictEqual(docker.autoPr, false);

    const worktree = await capture({}, { defaultIsolation: 'worktree' });
    assert.strictEqual(worktree.requireDocker, false);
    assert.strictEqual(worktree.requireGit, true);
    assert.strictEqual(worktree.autoPr, false);

    const pr = await capture({}, { defaultDelivery: 'pr' });
    assert.strictEqual(pr.requireDocker, false);
    assert.strictEqual(pr.requireGit, true);
    assert.strictEqual(pr.autoPr, true);

    const local = await capture(
      { noIsolation: true },
      { defaultIsolation: 'worktree', defaultDelivery: 'none' }
    );
    assert.strictEqual(local.requireDocker, false);
    assert.strictEqual(local.requireGit, false);
    assert.strictEqual(local.autoPr, false);
  });
});
