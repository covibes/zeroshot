const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function assertCiTrunkTriggers(ci) {
  assert(!/\bbranches:\s*\[main,\s*dev\]/.test(ci), 'CI must not target a retired dev branch');
  assert(!/enforce-main-pr-source/.test(ci), 'CI must not require dev-to-main promotions');
  assert(
    (ci.match(/\bbranches:\s*\[main\]/g) || []).length >= 2,
    'push and pull request CI must target main'
  );
  assert(
    /merge_group:\s*\n\s*types:\s*\[checks_requested\]/.test(ci),
    'merge queue CI must use the supported checks_requested trigger'
  );
}

describe('release topology', function () {
  it('uses main as the single development and release trunk', function () {
    const ci = readText('.github/workflows/ci.yml');
    const releaseWorkflow = readText('.github/workflows/release.yml');
    const setup = readText('scripts/setup-merge-queue.sh');
    const dependabot = readText('.github/dependabot.yml');
    const prPolicy = readText('.github/workflows/pr-policy.yml');
    const publishing = readText('PUBLISHING.md');
    const agents = readText('AGENTS.md');
    const repoSettings = JSON.parse(readText('.zeroshot/settings.json'));
    const packageJson = JSON.parse(readText('package.json'));
    const dryRunJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf('\n  dry-run:'),
      releaseWorkflow.indexOf('\n  release:')
    );
    const publishJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf('\n  release:'),
      releaseWorkflow.indexOf('\n  recover:')
    );

    assertCiTrunkTriggers(ci);

    assert(
      /github\.event\.workflow_run\.head_sha/.test(releaseWorkflow),
      'release jobs must bind to the exact CI-tested main commit'
    );
    assert(
      /workflow_run\.head_sha \|\| github\.sha/.test(releaseWorkflow),
      'manual dry runs must bind to the exact dispatched commit'
    );
    assert(
      /node scripts\/release-dry-run\.js/.test(releaseWorkflow),
      'manual dry runs must analyze the dispatched candidate as a release branch'
    );
    assert(/contents:\s*read/.test(dryRunJob), 'dry runs must remain read-only');
    assert(
      !/environment:\s*release/.test(dryRunJob),
      'dry runs must not enter release environment'
    );
    assert(!/id-token:\s*write/.test(dryRunJob), 'dry runs must not receive npm OIDC authority');
    assert(/environment:\s*release/.test(publishJob), 'publishing must use release environment');
    assert(/contents:\s*write/.test(publishJob), 'publishing must be allowed to create releases');
    assert(/id-token:\s*write/.test(publishJob), 'publishing must receive npm OIDC authority');
    assert(
      /Recheck main immediately before publication/.test(releaseWorkflow),
      'release must fail closed if main moves after validation'
    );
    assert(
      /RELEASE_AUTOMATION_ENABLED/.test(releaseWorkflow),
      'automatic publishing must have an explicit repository off-switch'
    );
    assert(
      /environment:\s*release/.test(releaseWorkflow),
      'publishing must use release environment'
    );
    assert(
      /recover-npm/.test(releaseWorkflow) && /recover-github-release/.test(releaseWorkflow),
      'release workflow must expose bounded recovery actions'
    );
    assert(
      /github\.event\.workflow_run\.event == 'push'/.test(releaseWorkflow),
      'pull request CI must never trigger publishing'
    );

    assert.strictEqual(packageJson.version, '0.0.0-development');
    assert.deepStrictEqual(packageJson.release.branches, ['main']);
    assert(packageJson.release.plugins.includes('./scripts/semantic-release-notes.js'));
    assert(
      !fs.existsSync(path.join(projectRoot, '.releaserc.json')),
      'package.json must be the only semantic-release configuration'
    );

    assert.strictEqual(repoSettings.github.prBase, 'main');
    assert.strictEqual(repoSettings.worktree.baseRef, 'origin/main');
    assert(/target-branch:\s*'main'/.test(dependabot), 'Dependabot must target main');

    assert(
      !/branches\/dev\/protection/.test(setup),
      'setup must not protect dev as a merge target'
    );
    assert(!/"include":\s*\["refs\/heads\/dev"\]/.test(setup), 'setup must not create a dev rule');
    assert(!/--base dev|--head dev/.test(setup), 'setup must send feature PRs directly to main');
    assert(/refs\/tags\/v\*/.test(setup), 'setup must make release tags immutable');
    assert(/required_review_thread_resolution/.test(setup), 'main must resolve review threads');
    assert(/"context": "required"/.test(setup), 'main must require aggregate CI');
    assert(/"context": "semantic"/.test(setup), 'main must require semantic policy');
    assert(
      !/prevent_self_review/.test(setup),
      'release environment setup must not send reviewer-only fields without reviewers'
    );

    assert(/branches:\s*\[main\]/.test(prPolicy), 'PR policy must target main');
    assert(/merge_group:/.test(prPolicy), 'semantic policy must run in the merge queue');
    assert(/commitlint/.test(prPolicy), 'PR policy must validate conventional commits');
    assert(/--no-merges/.test(prPolicy), 'merge queue policy must ignore synthetic merge commits');

    assert(!/dev\s*(?:→|->)\s*main/.test(publishing), 'publishing must not document promotions');
    assert(!/Dev required checks/.test(agents), 'agent policy must not assign release work to dev');
  });
});
