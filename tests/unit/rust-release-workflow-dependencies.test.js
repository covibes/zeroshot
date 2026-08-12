const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  distribution,
  mutateWorkflowJob,
  projectRoot,
  releaseWorkflow,
} = require('./rust-distribution-support');

function messageIncludes(expected) {
  return (error) => {
    assert(error instanceof Error);
    assert(
      error.message.includes(expected),
      `expected error message to include ${JSON.stringify(expected)}, received ${JSON.stringify(error.message)}`
    );
    return true;
  };
}

function assertInstallOrdering({ jobName, installName, installCommand, mutateInstall }) {
  assert.throws(
    () =>
      distribution.checkRepository(
        mutateInstall((job) => {
          job.steps.find((step) => step.name === installName).run =
            `${installCommand} --foreground-scripts`;
        })
      ),
    messageIncludes(`${jobName} dependency install must execute at workspace root`)
  );
  assert.throws(
    () =>
      distribution.checkRepository(
        mutateInstall((job) => {
          job.steps = job.steps.filter((step) => step.name !== installName);
        })
      ),
    messageIncludes(installName)
  );
  assert.throws(
    () =>
      distribution.checkRepository(
        mutateInstall((job) => {
          const installIndex = job.steps.findIndex((step) => step.name === installName);
          const [install] = job.steps.splice(installIndex, 1);
          const invocationIndex = job.steps.findIndex((step) =>
            step.run?.includes('scripts/rust-distribution.js')
          );
          job.steps.splice(invocationIndex + 1, 0, install);
        })
      ),
    messageIncludes(`${jobName} must install dependencies before every`)
  );
  for (const command of [
    'node ./scripts/rust-distribution.js print-version',
    './scripts/rust-distribution.js print-version',
    'node "scripts/rust-distribution.js" print-version',
    "node 'scripts/rust-distribution.js' print-version",
    'node "./scripts/rust-distribution.js" print-version',
    "node './scripts/rust-distribution.js' print-version",
    '"scripts/rust-distribution.js" print-version',
    "'scripts/rust-distribution.js' print-version",
    '"./scripts/rust-distribution.js" print-version',
    "'./scripts/rust-distribution.js' print-version",
  ]) {
    assert.throws(
      () =>
        distribution.checkRepository(
          mutateInstall((job) => {
            job.steps.unshift({
              name: 'Invoke Rust distribution before dependency installation',
              run: command,
            });
          })
        ),
      messageIncludes(`${jobName} must install dependencies before every`)
    );
  }
}

function assertCheckoutAndSetup(workflow, jobName, installName, mutateInstall) {
  for (const mutateCheckout of [
    (checkout) => {
      checkout.if = false;
    },
    (checkout) => {
      checkout.with.path = 'nested';
    },
    (checkout) => {
      checkout.with.repository = 'other/repository';
    },
    (checkout) => {
      checkout.with.ref = 'main';
    },
  ]) {
    assert.throws(
      () =>
        distribution.checkRepository(
          mutateInstall((job) => {
            const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
            mutateCheckout(checkout);
          })
        ),
      messageIncludes(`${jobName} must checkout expected current repository source`)
    );
  }
  for (const mutateNodeSetup of [
    (job, setup) => {
      job.steps = job.steps.filter((step) => step !== setup);
    },
    (_job, setup) => {
      setup.if = false;
    },
    (_job, setup) => {
      setup.with.cache = '';
    },
    (_job, setup) => {
      setup.with['node-version'] = 20;
    },
    (job, setup) => {
      const setupIndex = job.steps.indexOf(setup);
      job.steps.splice(setupIndex, 1);
      const installIndex = job.steps.findIndex((step) => step.name === installName);
      job.steps.splice(installIndex + 1, 0, setup);
    },
  ]) {
    assert.throws(
      () =>
        distribution.checkRepository(
          mutateInstall((job) => {
            const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
            mutateNodeSetup(job, setup);
          })
        ),
      messageIncludes(`${jobName} must enable pinned Node 24 npm cache`)
    );
  }
}

function assertInstallLocation(workflow, jobName, installName, mutateInstall) {
  assert.throws(
    () =>
      distribution.checkRepository(
        mutateInstall((job) => {
          job.steps.find((step) => step.name === installName)['working-directory'] = 'nested';
        })
      ),
    messageIncludes(`${jobName} dependency install must execute at workspace root`)
  );
  assert.throws(
    () =>
      distribution.checkRepository(
        mutateInstall((job) => {
          const installIndex = job.steps.findIndex((step) => step.name === installName);
          const [install] = job.steps.splice(installIndex, 1);
          const checkoutIndex = job.steps.findIndex((step) =>
            step.uses?.startsWith('actions/checkout@')
          );
          job.steps.splice(checkoutIndex, 0, install);
        })
      ),
    messageIncludes(`${jobName} must checkout source before dependency installation`)
  );
}

function assertPackageLockEntries(workflow, packageManifest, mutatePackageLock) {
  assert.throws(
    () =>
      distribution.checkRepository(
        workflow,
        undefined,
        packageManifest,
        mutatePackageLock((candidate) => {
          delete candidate.packages[''].dependencies['js-yaml'];
        })
      ),
    /package-lock root js-yaml spec must match/
  );
  assert.throws(
    () =>
      distribution.checkRepository(
        workflow,
        undefined,
        packageManifest,
        mutatePackageLock((candidate) => {
          candidate.packages[''].dependencies['js-yaml'] = '^9.0.0';
        })
      ),
    /package-lock root js-yaml spec must match/
  );
  assert.throws(
    () =>
      distribution.checkRepository(
        workflow,
        undefined,
        packageManifest,
        mutatePackageLock((candidate) => {
          delete candidate.packages['node_modules/js-yaml'];
        })
      ),
    /integrity-pinned resolved js-yaml/
  );
  assert.throws(
    () =>
      distribution.checkRepository(
        workflow,
        undefined,
        packageManifest,
        mutatePackageLock((candidate) => {
          delete candidate.packages['node_modules/js-yaml'].integrity;
        })
      ),
    /integrity-pinned resolved js-yaml/
  );
}

function assertPackageLockResolution(workflow, packageManifest, mutatePackageLock) {
  for (const mutateResolution of [
    (candidate) => {
      candidate.packages['node_modules/js-yaml'].version = '';
    },
    (candidate) => {
      candidate.packages['node_modules/js-yaml'].resolved = ' ';
    },
    (candidate) => {
      candidate.packages['node_modules/js-yaml'].integrity = 'sha512-';
    },
    (candidate) => {
      candidate.packages['node_modules/js-yaml'].integrity = 'sha512-YQ==';
    },
  ]) {
    assert.throws(
      () =>
        distribution.checkRepository(
          workflow,
          undefined,
          packageManifest,
          mutatePackageLock(mutateResolution)
        ),
      /integrity-pinned resolved js-yaml/
    );
  }
}

describe('Rust release workflow dependency integrity', function () {
  it('causally guards build, matrix, upload, publication, recovery, and shim integrity', function () {
    const workflow = releaseWorkflow();
    assert.strictEqual(distribution.checkRepository(workflow), true);

    for (const [jobName, installName, installCommand] of [
      ['dry-run', 'Install pinned dependencies', 'npm ci'],
      ['release', 'Install pinned dependencies', 'npm ci'],
      ['rust-binaries', 'Install pinned script dependencies', 'npm ci --ignore-scripts'],
      ['rust-manifest', 'Install pinned script dependencies', 'npm ci --ignore-scripts'],
      ['rust-publish', 'Install pinned script dependencies', 'npm ci --ignore-scripts'],
    ]) {
      const mutateInstall = (mutateJob) => mutateWorkflowJob(workflow, jobName, mutateJob);
      assertInstallOrdering({
        workflow,
        jobName,
        installName,
        installCommand,
        mutateInstall,
      });
      assertCheckoutAndSetup(workflow, jobName, installName, mutateInstall);
      assertInstallLocation(workflow, jobName, installName, mutateInstall);
    }

    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
    const packageWithoutYaml = JSON.parse(JSON.stringify(packageManifest));
    delete packageWithoutYaml.dependencies['js-yaml'];
    assert.throws(
      () => distribution.checkRepository(workflow, undefined, packageWithoutYaml),
      /direct js-yaml dependency/
    );

    const packageLock = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    );
    const mutatePackageLock = (mutateLock) => {
      const candidate = JSON.parse(JSON.stringify(packageLock));
      mutateLock(candidate);
      return candidate;
    };
    assertPackageLockEntries(workflow, packageManifest, mutatePackageLock);
    assertPackageLockResolution(workflow, packageManifest, mutatePackageLock);
  });
});
