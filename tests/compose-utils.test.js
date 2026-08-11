/**
 * Regression tests for lib/compose-utils.js — resolveWorktreeComposeTeardown()
 *
 * Bug (issue #543): worktree/PR cleanup ran `docker compose down --remove-orphans --volumes`
 * unconditionally. When the target repo's compose file (or COMPOSE_PROJECT_NAME) pinned a
 * project name, Compose resolved to the user's real, already-running project and --volumes
 * permanently deleted its named volumes.
 *
 * These tests would FAIL against the original behavior (which always returned a teardown
 * command including --volumes, regardless of project-name pinning) and PASS against the fix.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveWorktreeComposeTeardown,
  normalizeComposeProjectName,
} = require('../lib/compose-utils');

describe('compose-utils CommonJS API', function () {
  it('preserves the export surface and function arities', function () {
    const composeUtils = require('../lib/compose-utils');
    assert.deepStrictEqual(Reflect.ownKeys(composeUtils), [
      'resolveWorktreeComposeTeardown',
      'normalizeComposeProjectName',
    ]);
    assert.deepStrictEqual(
      Object.values(composeUtils).map((value) => value.length),
      [1, 1]
    );
  });
});

describe('resolveWorktreeComposeTeardown', function () {
  let tmpDir;
  let origComposeProjectName;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-compose-utils-'));
    origComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origComposeProjectName === undefined) {
      delete process.env.COMPOSE_PROJECT_NAME;
    } else {
      process.env.COMPOSE_PROJECT_NAME = origComposeProjectName;
    }
  });

  it('returns shouldTeardown:false when no compose file exists', function () {
    const result = resolveWorktreeComposeTeardown(tmpDir);
    assert.strictEqual(result.shouldTeardown, false);
    assert.strictEqual(result.reason, 'no compose file');
  });

  it('returns shouldTeardown:true with no --volumes for an unpinned compose file', function () {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres\n'
    );

    const result = resolveWorktreeComposeTeardown(tmpDir);
    assert.strictEqual(result.shouldTeardown, true);
    assert.ok(!result.args.includes('--volumes'), 'must never include --volumes');
    assert.ok(result.args.includes('--remove-orphans'));
    assert.strictEqual(
      result.args[result.args.indexOf('-p') + 1],
      normalizeComposeProjectName(path.basename(tmpDir))
    );
  });

  it('normalizes an uppercase/special-char worktree basename to match Docker Compose default project naming', function () {
    const worktreeDir = path.join(tmpDir, 'My.Worktree!');
    fs.mkdirSync(worktreeDir);
    fs.writeFileSync(
      path.join(worktreeDir, 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres\n'
    );

    const result = resolveWorktreeComposeTeardown(worktreeDir);
    assert.strictEqual(result.shouldTeardown, true);
    assert.strictEqual(result.args[result.args.indexOf('-p') + 1], 'myworktree');
  });

  it('returns shouldTeardown:false when the compose file pins a top-level project name', function () {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'name: myproj\nservices:\n  db:\n    image: postgres\n'
    );

    const result = resolveWorktreeComposeTeardown(tmpDir);
    assert.strictEqual(result.shouldTeardown, false);
    assert.strictEqual(result.reason, 'pinned compose project name (shared host project)');
  });

  it('returns shouldTeardown:false when COMPOSE_PROJECT_NAME env var is set', function () {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres\n'
    );
    process.env.COMPOSE_PROJECT_NAME = 'shared-host-project';

    const result = resolveWorktreeComposeTeardown(tmpDir);
    assert.strictEqual(result.shouldTeardown, false);
    assert.strictEqual(result.reason, 'pinned compose project name (shared host project)');
  });

  it('finds alternate compose filenames (compose.yaml)', function () {
    fs.writeFileSync(path.join(tmpDir, 'compose.yaml'), 'services:\n  db:\n    image: postgres\n');

    const result = resolveWorktreeComposeTeardown(tmpDir);
    assert.strictEqual(result.shouldTeardown, true);
    assert.ok(result.composePath.endsWith('compose.yaml'));
  });

  it('fails safe (shouldTeardown:false) when the compose file is malformed YAML', function () {
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), ':\n  - this is not: valid: yaml: [');

    const result = resolveWorktreeComposeTeardown(tmpDir);
    assert.strictEqual(result.shouldTeardown, false);
  });
});
