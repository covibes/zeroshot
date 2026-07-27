/**
 * Regression test for issue #452:
 * `zeroshot run <issue> --pr` created a PR and immediately auto-merged it,
 * instead of stopping at PR creation for human review.
 *
 * The fix threads a single `autoMerge` boolean end-to-end:
 *   --ship (or repo settings github.autoMerge=true) -> autoMerge=true -> create + merge
 *   --pr alone                                       -> autoMerge=false -> create + STOP
 */
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { generateGitPusherAgent } = require('../src/agents/git-pusher-template');
const Orchestrator = require('../src/orchestrator');

function withTmpCwd(fn) {
  // Avoid picking up repo settings (.zeroshot/settings.json) from this repo's own cwd.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-git-pusher-pr-mode-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRepoSettings(cwd, settings) {
  execSync('git init', { cwd, stdio: 'ignore' });
  const settingsDir = path.join(cwd, '.zeroshot');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function addUpstreamRemote(cwd) {
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git remote add upstream https://github.com/acme/widgets.git', {
    cwd,
    stdio: 'ignore',
  });
}

describe('git-pusher --pr vs --ship (autoMerge)', function () {
  it('review mode (autoMerge=false): prompt has no merge step, output template is merged:false', function () {
    withTmpCwd((cwd) => {
      const agentConfig = generateGitPusherAgent('github', { autoMerge: false, cwd });

      assert.strictEqual(agentConfig.hooks.onComplete.config.autoMerge, false);
      assert(!/gh pr merge/i.test(agentConfig.prompt), 'prompt must not instruct gh pr merge');
      assert(
        !/MERGE THE PR \(MANDATORY/i.test(agentConfig.prompt),
        'prompt must not mandate merging the PR'
      );
      assert(
        /Do NOT merge the PR/i.test(agentConfig.prompt),
        'prompt must explicitly say do not merge'
      );
      assert(
        agentConfig.prompt.includes('"merged": false'),
        'final output template must report merged:false'
      );
      assert(
        !agentConfig.prompt.includes('"merged": true'),
        'review-mode prompt must never claim merged:true'
      );
    });
  });

  it('ship mode (autoMerge=true): prompt still merges, config carries autoMerge=true', function () {
    withTmpCwd((cwd) => {
      const agentConfig = generateGitPusherAgent('github', { autoMerge: true, cwd });

      assert.strictEqual(agentConfig.hooks.onComplete.config.autoMerge, true);
      assert(/gh pr merge/i.test(agentConfig.prompt), 'ship-mode prompt must merge the PR');
      assert(
        /MERGE THE PR \(MANDATORY/i.test(agentConfig.prompt),
        'ship-mode prompt must mandate merging'
      );
      assert(
        agentConfig.prompt.includes('"merged": true'),
        'ship-mode final output template must report merged:true'
      );
    });
  });

  it('default (no autoMerge option, no repo setting) behaves as review mode', function () {
    withTmpCwd((cwd) => {
      const agentConfig = generateGitPusherAgent('github', { cwd });
      assert.strictEqual(agentConfig.hooks.onComplete.config.autoMerge, false);
      assert(!/gh pr merge/i.test(agentConfig.prompt));
    });
  });

  it('pushes to the selected non-origin remote', function () {
    withTmpCwd((cwd) => {
      const agentConfig = generateGitPusherAgent('github', {
        autoMerge: false,
        gitRemote: 'upstream',
        cwd,
      });

      assert.match(agentConfig.prompt, /git push -u upstream HEAD/);
      assert.doesNotMatch(agentConfig.prompt, /git push -u origin HEAD/);
    });
  });

  it('threads an auto-detected non-origin remote into the PR agent', function () {
    withTmpCwd((cwd) => {
      addUpstreamRemote(cwd);
      const orchestrator = new Orchestrator({
        storageDir: path.join(cwd, 'storage'),
      });
      const config = { agents: [{ id: 'completion-detector' }] };

      try {
        orchestrator._applyAutoPrConfig(
          config,
          {
            number: 448,
            title: 'Support non-origin remotes',
            url: 'https://github.com/acme/widgets/issues/448',
          },
          {
            autoPr: true,
            cwd,
            requiredQualityGates: [],
          }
        );

        const gitPusher = config.agents.find((agent) => agent.id === 'git-pusher');
        assert.ok(gitPusher);
        assert.match(gitPusher.prompt, /git push -u upstream HEAD/);
      } finally {
        orchestrator.close();
      }
    });
  });

  it('--pr review mode overrides repo github.autoMerge=true', function () {
    withTmpCwd((cwd) => {
      writeRepoSettings(cwd, { github: { autoMerge: true } });

      const agentConfig = generateGitPusherAgent('github', { autoMerge: false, cwd });

      assert.strictEqual(agentConfig.hooks.onComplete.config.autoMerge, false);
      assert(!/gh pr merge/i.test(agentConfig.prompt), '--pr must not inherit repo auto-merge');
      assert(
        /Do NOT merge the PR/i.test(agentConfig.prompt),
        '--pr must remain a human-review prompt even when repo settings enable auto-merge'
      );
    });
  });

  it('repo github.autoMerge=true only applies when the caller has not selected --pr', function () {
    withTmpCwd((cwd) => {
      writeRepoSettings(cwd, { github: { autoMerge: true } });

      const agentConfig = generateGitPusherAgent('github', { cwd });

      assert.strictEqual(agentConfig.hooks.onComplete.config.autoMerge, true);
      assert(/gh pr merge/i.test(agentConfig.prompt));
    });
  });

  it('buildPrOptions persists autoMerge=false for --pr and autoMerge=true for --ship (resume-safe)', function () {
    const prOptionsForPr = Orchestrator.buildPrOptions({ ship: false }, []);
    const prOptionsForShip = Orchestrator.buildPrOptions({ ship: true }, []);

    assert.strictEqual(prOptionsForPr.autoMerge, false);
    assert.strictEqual(prOptionsForShip.autoMerge, true);

    // Persisted even when no other PR fields were passed (--pr with all defaults),
    // otherwise the distinction is lost on `zeroshot resume`.
    assert.notStrictEqual(prOptionsForPr, null);
  });

  it('buildPrOptions persists the selected remote for resume', function () {
    const prOptions = Orchestrator.buildPrOptions({ pr: true, gitRemote: 'upstream' }, []);

    assert.strictEqual(prOptions.gitRemote, 'upstream');
  });

  it('resolveRunPlan is the single source for the autoMerge decision', function () {
    assert.strictEqual(Orchestrator.resolveRunPlan({ ship: true }).autoMerge, true);
    assert.strictEqual(Orchestrator.resolveRunPlan({ pr: true }).autoMerge, false);
    // Explicit autoMerge is ship-equivalent and is NOT clobbered (the old
    // normalizeRunOptions overwrite bug reset this to false).
    assert.strictEqual(Orchestrator.resolveRunPlan({ pr: true, autoMerge: true }).autoMerge, true);
  });

  it('buildPrOptions and git-pusher config cannot diverge (both derive from resolveRunPlan)', function () {
    const shipOptions = { ship: true };
    const prOptions = { pr: true };

    assert.strictEqual(
      Orchestrator.buildPrOptions(shipOptions, []).autoMerge,
      Orchestrator.resolveRunPlan(shipOptions).autoMerge
    );
    assert.strictEqual(
      Orchestrator.buildPrOptions(prOptions, []).autoMerge,
      Orchestrator.resolveRunPlan(prOptions).autoMerge
    );
  });
});
