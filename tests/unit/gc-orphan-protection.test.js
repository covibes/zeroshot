const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { gcOrphanedWorktrees, countOrphanedWorktrees } = require('../../src/lib/gc');

function createTempStorageDir() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gc-'));
  fs.mkdirSync(path.join(tempRoot, 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'clusters.json'), '{}', 'utf8');
  return tempRoot;
}

describe('gc orphan protection', function () {
  let storageDir;
  const originalClusterIdEnv = process.env.ZEROSHOT_CLUSTER_ID;

  beforeEach(function () {
    storageDir = createTempStorageDir();
    delete process.env.ZEROSHOT_CLUSTER_ID;
  });

  afterEach(function () {
    fs.rmSync(storageDir, { recursive: true, force: true });
    if (typeof originalClusterIdEnv === 'string') {
      process.env.ZEROSHOT_CLUSTER_ID = originalClusterIdEnv;
    } else {
      delete process.env.ZEROSHOT_CLUSTER_ID;
    }
  });

  it('supports extraKnownIds in orphan counting', function () {
    const clusterId = 'neural-mountain-14';
    fs.mkdirSync(path.join(storageDir, 'worktrees', clusterId), { recursive: true });

    const orphanCountWithoutProtection = countOrphanedWorktrees(storageDir);
    const orphanCountWithProtection = countOrphanedWorktrees({
      storageDir,
      extraKnownIds: new Set([clusterId]),
    });

    assert.strictEqual(orphanCountWithoutProtection, 1);
    assert.strictEqual(orphanCountWithProtection, 0);
  });

  it('skips database deletion when removeDbFiles=false', function () {
    const clusterId = 'neural-mountain-14';
    const dbPath = path.join(storageDir, `${clusterId}.db`);
    fs.writeFileSync(dbPath, '', 'utf8');

    const result = gcOrphanedWorktrees({
      storageDir,
      extraKnownIds: new Set([clusterId]),
      removeDbFiles: false,
    });

    assert.strictEqual(result.orphanedDbs.length, 0);
    assert.ok(fs.existsSync(dbPath));
  });

  it('still deletes orphaned database files by default', function () {
    const orphanClusterId = 'floating-hawk-22';
    const orphanDbPath = path.join(storageDir, `${orphanClusterId}.db`);
    fs.writeFileSync(orphanDbPath, '', 'utf8');

    const result = gcOrphanedWorktrees({ storageDir });

    assert.deepStrictEqual(result.orphanedDbs, [`${orphanClusterId}.db`]);
    assert.ok(!fs.existsSync(orphanDbPath));
  });

  it('auto-protects active cluster id from env and avoids db deletion in cluster context', function () {
    const clusterId = 'neural-mountain-14';
    const activeDbPath = path.join(storageDir, `${clusterId}.db`);
    const orphanDbPath = path.join(storageDir, 'floating-hawk-22.db');
    process.env.ZEROSHOT_CLUSTER_ID = clusterId;
    fs.writeFileSync(activeDbPath, '', 'utf8');
    fs.writeFileSync(orphanDbPath, '', 'utf8');
    fs.mkdirSync(path.join(storageDir, 'worktrees', clusterId), { recursive: true });

    const orphanCount = countOrphanedWorktrees({ storageDir });
    const result = gcOrphanedWorktrees({ storageDir });

    assert.strictEqual(orphanCount, 0);
    assert.strictEqual(result.orphanedDbs.length, 0);
    assert.ok(fs.existsSync(activeDbPath));
    assert.ok(fs.existsSync(orphanDbPath));
  });

  describe('orphaned provider-state dirs (IsolationManager._applyProviderStateMounts backstop)', function () {
    // PROVIDER_STATE_DIR is always os.tmpdir()/zeroshot-provider-state (not parameterized by
    // storageDir), matching IsolationManager's own hardcoded root, so these write there directly.
    const PROVIDER_STATE_DIR = path.join(os.tmpdir(), 'zeroshot-provider-state');
    let createdDirs;

    beforeEach(function () {
      createdDirs = [];
    });

    afterEach(function () {
      for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    function makeProviderStateDir(name) {
      const dir = path.join(PROVIDER_STATE_DIR, name);
      fs.mkdirSync(path.join(dir, 'omp', 'agent'), { recursive: true });
      createdDirs.push(dir);
      return dir;
    }

    it('removes an orphaned provider-state dir for an unknown clusterId', function () {
      const orphanId = `orphan-provider-state-${Date.now()}`;
      const orphanDir = makeProviderStateDir(orphanId);

      const result = gcOrphanedWorktrees({ storageDir });

      assert.ok(result.orphanedProviderState.includes(orphanId));
      assert.ok(!fs.existsSync(orphanDir));
      assert.deepStrictEqual(result.errors, []);
    });

    it('protects a known clusterId provider-state dir', function () {
      const clusterId = `known-provider-state-${Date.now()}`;
      const keptDir = makeProviderStateDir(clusterId);

      const result = gcOrphanedWorktrees({ storageDir, extraKnownIds: new Set([clusterId]) });

      assert.ok(!result.orphanedProviderState.includes(clusterId));
      assert.ok(fs.existsSync(keptDir));
    });

    it('protects the -validators suffixed dir of a known clusterId', function () {
      const clusterId = `known-validators-base-${Date.now()}`;
      const validatorsId = `${clusterId}-validators`;
      const keptDir = makeProviderStateDir(validatorsId);

      const result = gcOrphanedWorktrees({ storageDir, extraKnownIds: new Set([clusterId]) });

      assert.ok(!result.orphanedProviderState.includes(validatorsId));
      assert.ok(fs.existsSync(keptDir));
    });

    it('does not delete under dryRun, but reports it', function () {
      const orphanId = `dry-run-provider-state-${Date.now()}`;
      const orphanDir = makeProviderStateDir(orphanId);

      const result = gcOrphanedWorktrees({ storageDir, dryRun: true });

      assert.ok(result.orphanedProviderState.includes(orphanId));
      assert.ok(fs.existsSync(orphanDir));
    });
  });
});
