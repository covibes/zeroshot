const assert = require('node:assert/strict');

const helper = require('../lib/agent-cli-provider');

describe('Codex Git worktree sandbox', function () {
  it('uses the capsule as the boundary for unattended cloud runs', function () {
    const command = helper.buildProviderCommand('codex', 'exercise the full capsule', {
      autoApprove: true,
      executionContext: 'docker',
      cwd: '/workspace/repo',
      cliFeatures: {
        supportsAutoApprove: true,
        supportsSandbox: true,
        supportsAddDir: true,
        supportsCwd: true,
      },
    });

    assert.ok(command.args.includes('danger-full-access'));
    assert.strictEqual(command.args.includes('workspace-write'), false);
    assert.strictEqual(command.args.includes('--add-dir'), false);
  });

  it('adds only the resolved external Git metadata directory to normal unattended runs', function () {
    const command = helper.buildProviderCommand('codex', 'ship the tested change', {
      autoApprove: true,
      executionContext: 'detached',
      cwd: '/workspace/repo',
      additionalWritableDirectories: ['/parent/repo/.git', '/parent/repo/.git'],
      cliFeatures: {
        supportsAutoApprove: true,
        supportsSandbox: true,
        supportsAddDir: true,
        supportsCwd: true,
      },
    });

    assert.deepStrictEqual(command.args.slice(0, 10), [
      'exec',
      '-C',
      '/workspace/repo',
      '--sandbox',
      'workspace-write',
      '--config',
      'approval_policy="never"',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--add-dir',
    ]);
    assert.strictEqual(command.args[10], '/parent/repo/.git');
    assert.strictEqual(command.args.filter((arg) => arg === '--add-dir').length, 1);
  });

  it('keeps host filesystem isolation while enabling networked user journeys', function () {
    const command = helper.buildProviderCommand('codex', 'use an API and deliver the change', {
      autoApprove: true,
      executionContext: 'host',
      cliFeatures: {
        supportsAutoApprove: true,
        supportsSandbox: true,
      },
    });

    assert.ok(command.args.includes('workspace-write'));
    assert.ok(command.args.includes('sandbox_workspace_write.network_access=true'));
    assert.strictEqual(command.args.includes('danger-full-access'), false);
  });
});

describe('Codex restricted and linked-worktree boundaries', function () {
  it('does not grant the metadata directory to restricted recovery runs', function () {
    const prepared = helper.prepareSingleAgentProviderCommand({
      provider: 'codex',
      context: 'repair structured output',
      options: {
        structuredOutputRecovery: true,
        executionContext: 'docker',
        additionalWritableDirectories: ['/parent/repo/.git'],
        cliFeatures: {
          supportsSandbox: true,
          supportsEphemeral: true,
          supportsIgnoreUserConfig: true,
          supportsIgnoreRules: true,
          supportsStrictConfig: true,
          supportsConfigOverride: true,
          supportsAddDir: true,
        },
      },
    });

    assert.strictEqual(prepared.commandSpec.args.includes('--add-dir'), false);
    assert.ok(prepared.commandSpec.args.includes('read-only'));
    assert.strictEqual(prepared.commandSpec.args.includes('danger-full-access'), false);
  });

  it('resolves only Git common directories outside the task workspace', async function () {
    const { resolveCodexGitMetadataDirectories } = await import('../task-lib/runner.js');
    const git = (_binary, _args, options) => {
      assert.strictEqual(options.cwd, '/workspace/repo');
      return '../../parent/.git\n';
    };

    assert.deepStrictEqual(resolveCodexGitMetadataDirectories('/workspace/repo', git), [
      '/parent/.git',
    ]);
    assert.deepStrictEqual(
      resolveCodexGitMetadataDirectories('/workspace/repo', () => '.git\n'),
      []
    );
  });
});
