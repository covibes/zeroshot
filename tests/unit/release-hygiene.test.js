const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function assertNoMatch(label, text, patterns) {
  for (const pattern of patterns) {
    assert(
      !pattern.test(text),
      `${label} must not contain forbidden release surface ${pattern.source}`
    );
  }
}

function packageDependencySpecs(pkg) {
  return {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
}

function assertNoTarballDependencies(dependencySpecByName) {
  for (const [name, spec] of Object.entries(dependencySpecByName)) {
    const dependencyLabel = `${name}@${spec}`;
    assert(!/\.tgz(?:$|[?#])/.test(dependencyLabel), `${name} must not depend on tarball packages`);
    assert(
      !/^file:.*\.tgz(?:$|[?#])/.test(String(spec)),
      `${name} must not depend on local tarball packages`
    );
  }
}

function assertPackageScriptsClean(scriptText) {
  assertNoMatch('package scripts', scriptText, [
    /install-tui-binary/,
    /ZEROSHOT_TUI/,
    /tui-rs/,
    /tui-backend/,
    /libexec/,
  ]);
}

function assertPackageFilesClean(filesText) {
  assertNoMatch('package files', filesText, [
    /\.tgz/,
    /(?:^|[/"'])vendor(?:[/"']|$)/,
    /libexec/,
    /tui-rs/,
    /tui-backend/,
  ]);
}

function walkFiles(dirPath) {
  const ignoredDirectories = new Set([
    '.git',
    '.tmp',
    '.turbo',
    '.zeroshot',
    'coverage',
    'node_modules',
    'tmp',
  ]);
  const files = [];
  const pending = [dirPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else files.push(fullPath);
    }
  }
  return files;
}

function assertForbiddenPathsAbsent(forbiddenPaths) {
  for (const relativePath of forbiddenPaths) {
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, relativePath)),
      false,
      `${relativePath} must stay out of the public release tree`
    );
  }
}

function assertNoTarballsInTree() {
  const tarballFiles = walkFiles(projectRoot).filter((filePath) => filePath.endsWith('.tgz'));
  assert.deepStrictEqual(
    tarballFiles,
    [],
    'tarball packages must stay out of the public release tree'
  );
}

describe('release hygiene', function () {
  it('keeps package metadata limited to public release dependencies', function () {
    const pkg = require('../../package.json');

    assertNoTarballDependencies(packageDependencySpecs(pkg));
    assertPackageScriptsClean(JSON.stringify(pkg.scripts || {}));
    assertPackageFilesClean(JSON.stringify(pkg.files || []));
  });

  it('does not keep tarballs or Rust TUI release paths in the repository', function () {
    const forbiddenPaths = [
      'libexec/zeroshot-tui',
      'scripts/install-tui-binary.js',
      'lib/tui-binary.js',
      'lib/tui-launcher.js',
      'tui-rs',
      'src/tui-backend',
    ];

    assertForbiddenPathsAbsent(forbiddenPaths);
    assertNoTarballsInTree();
  });

  it('does not publish TUI release assets from workflows', function () {
    const workflowText = [
      readText('.github/workflows/ci.yml'),
      readText('.github/workflows/release.yml'),
      JSON.stringify(require('../../package.json').release),
    ].join(' ');

    assertNoMatch('release workflows', workflowText, [
      /tui-binary/,
      /ZEROSHOT_TUI/,
      /zeroshot-tui/,
      /tui-rs/,
      /tui-backend/,
      /dist\/tui/,
    ]);
  });
});
