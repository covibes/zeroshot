const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  distribution,
  mutateWorkflowJob,
  nodeReleaseWorkflow,
  projectRoot,
  releaseWorkflow,
} = require('./rust-distribution-support');

describe('Rust release workflow dependency integrity', function () {
  it('accepts the independent Rust and Node release workflows', function () {
    assert.strictEqual(
      distribution.checkRepository(releaseWorkflow(), nodeReleaseWorkflow()),
      true
    );
  });

  it('requires dependency installation before every distribution-tool invocation', function () {
    const workflow = releaseWorkflow();
    for (const jobName of [
      'rust-binaries',
      'rust-manifest',
      'rust-image-input',
      'rust-publish',
      'rust-shim-input',
    ]) {
      const candidate = mutateWorkflowJob(workflow, jobName, (job) => {
        job.steps = job.steps.filter((step) => step.name !== 'Install pinned script dependencies');
      });
      assert.throws(
        () => distribution.checkRepository(candidate, nodeReleaseWorkflow()),
        /Install pinned script dependencies/
      );
    }
  });

  it('requires the script parser dependency to remain integrity-pinned', function () {
    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
    const packageLock = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    );
    const withoutYaml = JSON.parse(JSON.stringify(packageManifest));
    delete withoutYaml.dependencies['js-yaml'];
    assert.throws(
      () =>
        distribution.checkRepository(
          releaseWorkflow(),
          nodeReleaseWorkflow(),
          undefined,
          withoutYaml,
          packageLock
        ),
      /direct js-yaml dependency/
    );

    const unlocked = JSON.parse(JSON.stringify(packageLock));
    delete unlocked.packages['node_modules/js-yaml'].integrity;
    assert.throws(
      () =>
        distribution.checkRepository(
          releaseWorkflow(),
          nodeReleaseWorkflow(),
          undefined,
          packageManifest,
          unlocked
        ),
      /integrity-pinned resolved js-yaml/
    );
  });
});
