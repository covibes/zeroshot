const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('release topology', function () {
  it('uses main as the single development and release trunk', function () {
    const ci = readText('.github/workflows/ci.yml');
    const releaseWorkflow = readText('.github/workflows/release.yml');
    const setup = readText('scripts/setup-merge-queue.sh');
    const publishing = readText('PUBLISHING.md');
    const agents = readText('AGENTS.md');
    const repoSettings = JSON.parse(readText('.zeroshot/settings.json'));
    const packageJson = JSON.parse(readText('package.json'));

    assert(!/\bbranches:\s*\[main,\s*dev\]/.test(ci), 'CI must not target a retired dev branch');
    assert(!/enforce-main-pr-source/.test(ci), 'CI must not require dev-to-main promotions');
    assert(
      (ci.match(/\bbranches:\s*\[main\]/g) || []).length >= 3,
      'push, pull request, and merge queue CI must target main'
    );

    assert(
      /github\.event\.workflow_run\.head_sha/.test(releaseWorkflow),
      'release jobs must bind to the exact CI-tested main commit'
    );
    assert(
      /Recheck main immediately before publication/.test(releaseWorkflow),
      'release must fail closed if main moves after validation'
    );

    assert.strictEqual(packageJson.version, '0.0.0-development');
    assert.deepStrictEqual(packageJson.release.branches, ['main']);
    assert(
      !fs.existsSync(path.join(projectRoot, '.releaserc.json')),
      'package.json must be the only semantic-release configuration'
    );

    assert.strictEqual(repoSettings.github.prBase, 'main');
    assert.strictEqual(repoSettings.worktree.baseRef, 'origin/main');

    assert(
      !/branches\/dev\/protection/.test(setup),
      'setup must not protect dev as a merge target'
    );
    assert(!/refs\/heads\/dev/.test(setup), 'setup must not create a dev merge queue');
    assert(!/--base dev|--head dev/.test(setup), 'setup must send feature PRs directly to main');

    assert(!/dev\s*(?:→|->)\s*main/.test(publishing), 'publishing must not document promotions');
    assert(!/Dev required checks/.test(agents), 'agent policy must not assign release work to dev');
  });
});
