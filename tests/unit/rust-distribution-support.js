const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jsYaml = require('js-yaml');

const distribution = require('../../scripts/rust-distribution');
const shim = require('../../npm/zeroshot-rust/lib/install');

const projectRoot = path.resolve(__dirname, '..', '..');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-rust-distribution-'));
}

function relativeFiles(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? relativeFiles(root, absolute) : [path.relative(root, absolute)];
  });
}

function mutation(source, before, after = '') {
  assert(source.includes(before), `mutation precondition missing: ${before}`);
  return source.replace(before, after);
}

function mutateWorkflowJob(source, jobName, mutateJob) {
  const document = jsYaml.load(source);
  const job = document.jobs[jobName];
  assert(job, `workflow job missing: ${jobName}`);
  mutateJob(job);
  return JSON.stringify(document);
}

function releaseWorkflow() {
  return fs.readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'release-rust.yml'),
    'utf8'
  );
}

function nodeReleaseWorkflow() {
  return fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8');
}

function withRustStageFixture(
  { requirement, lockedDependencies, includeRegistryNameCollision = false, trailingTables = [] },
  assertion
) {
  const directory = temporaryDirectory();
  const packageDirectory = path.join(directory, 'zeroshot-rust');
  const workspacePath = path.join(directory, 'Cargo.toml');
  const manifestPath = path.join(packageDirectory, 'Cargo.toml');
  const lockPath = path.join(directory, 'Cargo.lock');
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(
    workspacePath,
    `[workspace]\nmembers = ["zeroshot-rust"]\n\n[workspace.dependencies]\nwindows-sys = "${requirement}"\n`
  );
  fs.writeFileSync(
    manifestPath,
    '[package]\nname = "zeroshot-rust"\nversion = "0.1.0"\nedition = "2024"\n\n[target.\'cfg(windows)\'.dependencies]\nwindows-sys = { workspace = true }\n'
  );
  const lockPackages = lockedDependencies.flatMap(({ version, source }) => [
    '[[package]]',
    'name = "windows-sys"',
    `version = "${version}"`,
    ...(source ? [`source = "${source}"`] : []),
    '',
  ]);
  if (includeRegistryNameCollision) {
    lockPackages.push(
      '[[package]]',
      'name = "zeroshot-rust"',
      'version = "99.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      ''
    );
  }
  lockPackages.push(
    '[[package]]',
    'name = "zeroshot-rust"',
    'version = "0.1.0"',
    'dependencies = [',
    ' "windows-sys",',
    ']',
    ''
  );
  lockPackages.push(...trailingTables);
  fs.writeFileSync(lockPath, ['version = 4', '', ...lockPackages].join('\n'));
  try {
    return assertion({ lockPath, manifestPath, workspacePath });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = {
  distribution,
  mutation,
  mutateWorkflowJob,
  nodeReleaseWorkflow,
  projectRoot,
  relativeFiles,
  releaseWorkflow,
  shim,
  temporaryDirectory,
  withRustStageFixture,
};
