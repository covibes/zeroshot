/**
 * All three OMP session-partition cleanup surfaces required by issue #866:
 *   - standalone task `clean`   (task-lib/commands/clean.js -> cleanupOmpSessionPartitionForTask)
 *   - cluster clear             (cli/index.js deleteClusterData -> cleanupOmpSessionPartitionsForCluster)
 *   - global `purge`            (cli/index.js, which runs cluster clear then `clean --all`)
 *
 * The invariants under test:
 *   - deletion is validated against the *persisted* owner (uid, storage-root identity, partition
 *     identity), not just against a path that happens to exist
 *   - the check/use race is closed by staging the directory under an unguessable name before
 *     removing it, and a substitution is reported rather than recursively deleted
 *   - an unsafe or unresolvable path preserves the owner record with an actionable warning
 *   - the shared, machine-wide OMP CAS blob root is never touched by any surface
 *   - custom cluster storage roots and a custom standalone TASKS_DIR are both reclaimed
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { deleteOmpSessionPartition } = require('../../src/omp-session-partition');
const { makeBlobStore, makeSessionPartition } = require('../helpers/omp-session-fixtures');

const zeroshotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-cleanup-unit-'));
const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-ownership.js')
).href;
const cleanupUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-cleanup.js')
).href;
const cleanCommandUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/commands/clean.js')
).href;

async function runStoreScript(script, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZEROSHOT_HOME: zeroshotHome, ...env },
  });
  return stdout;
}

let idCounter = 0;
function nextTaskId(label) {
  idCounter += 1;
  return `omp-cleanup-${label}-${idCounter}`;
}

/**
 * Insert a task row owning `partition`, advanced to `state`.
 * `tasksHome` selects the store (used for the custom standalone TASKS_DIR case).
 */
async function seedOwnedTask(
  id,
  { owner, storageRoot, partition, state = 'committed', tasksHome }
) {
  const env = tasksHome ? { ZEROSHOT_HOME: tasksHome } : {};
  await runStoreScript(
    `
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership, commitOwnership, markCleanupRequired } =
      await import(${JSON.stringify(ownershipUrl)});
    addTask({
      id: ${JSON.stringify(id)},
      status: 'completed',
      provider: 'omp',
      cwd: ${JSON.stringify(storageRoot)},
      ompSessionOwnership: writeProvisionalOwnership({
        partitionId: ${JSON.stringify(partition.partitionId)},
        storageRoot: ${JSON.stringify(storageRoot)},
        canonicalWorkspace: ${JSON.stringify(storageRoot)},
        owner: ${JSON.stringify(owner)},
      }),
    });
    const state = ${JSON.stringify(state)};
    if (state === 'committed' || state === 'cleanup-required') {
      commitOwnership({
        taskId: ${JSON.stringify(id)},
        sessionId: 'sess-1',
        sessionFilePath: ${JSON.stringify(partition.sessionFilePath)},
        artifactManifestDigest: 'sha256:${'a'.repeat(64)}',
        executionFingerprint: 'sha256:${'b'.repeat(64)}',
        selectedProvider: 'anthropic',
        selectedModel: '@default',
      });
    }
    if (state === 'cleanup-required') {
      // Reach cleanup-required the way a failed turn does: retire a provisional record.
      const { getTaskStoreDatabase } = await import(${JSON.stringify(storeUrl)});
      const db = getTaskStoreDatabase();
      const row = db.prepare('SELECT omp_session_ownership AS o FROM tasks WHERE id = ?')
        .get(${JSON.stringify(id)});
      const record = { ...JSON.parse(row.o), state: 'provisional' };
      db.prepare('UPDATE tasks SET omp_session_ownership = ? WHERE id = ?')
        .run(JSON.stringify(record), ${JSON.stringify(id)});
      markCleanupRequired(${JSON.stringify(id)});
    }
  `,
    env
  );
}

async function cleanupTask(id, { tasksHome, clearRecord = false } = {}) {
  const stdout = await runStoreScript(
    `
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    const { cleanupOmpSessionPartitionForTask } = await import(${JSON.stringify(cleanupUrl)});
    const warnings = [];
    const safe = cleanupOmpSessionPartitionForTask(
      getTask(${JSON.stringify(id)}),
      (m) => warnings.push(m),
      { clearRecord: ${clearRecord} }
    );
    process.stdout.write(JSON.stringify({ safe, warnings, ownership: getTask(${JSON.stringify(id)})?.ompSessionOwnership ?? null }));
  `,
    tasksHome ? { ZEROSHOT_HOME: tasksHome } : {}
  );
  return JSON.parse(stdout);
}

async function cleanupCluster(clusterId, { tasksHome } = {}) {
  const stdout = await runStoreScript(
    `
    const { cleanupOmpSessionPartitionsForCluster } = await import(${JSON.stringify(cleanupUrl)});
    const warnings = [];
    const result = cleanupOmpSessionPartitionsForCluster(${JSON.stringify(clusterId)}, (m) => warnings.push(m));
    process.stdout.write(JSON.stringify({ ...result, warnings }));
  `,
    tasksHome ? { ZEROSHOT_HOME: tasksHome } : {}
  );
  return JSON.parse(stdout);
}

/** Run the real `clean --all` command surface end to end against an isolated store. */
async function runCleanAll(tasksHome) {
  const stdout = await runStoreScript(
    `
    const { cleanTasks } = await import(${JSON.stringify(cleanCommandUrl)});
    const { loadTasks } = await import(${JSON.stringify(storeUrl)});
    cleanTasks({ all: true });
    process.stdout.write('\\n@@' + JSON.stringify(Object.keys(loadTasks())));
  `,
    { ZEROSHOT_HOME: tasksHome }
  );
  return JSON.parse(stdout.split('@@').pop());
}

const clusterOwner = (id, clusterId = 'cluster-1') => ({
  kind: 'cluster-agent',
  clusterId,
  agentId: 'agent-1',
  taskId: id,
});
const standaloneOwner = (id) => ({
  kind: 'standalone',
  clusterId: null,
  agentId: null,
  taskId: id,
});

describe('OMP session partition cleanup (task clean / cluster clear / purge)', function () {
  this.timeout(30000);

  let storageRoot;
  let blobs;

  beforeEach(function () {
    storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'storage-'));
    blobs = makeBlobStore('omp-cleanup-blobs-');
  });

  describe('standalone task clean', function () {
    it('deletes a committed partition and reports the row as safe to remove', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const id = nextTaskId('committed');
      await seedOwnedTask(id, { owner: standaloneOwner(id), storageRoot, partition });

      const result = await cleanupTask(id);
      assert.strictEqual(result.safe, true);
      assert.deepStrictEqual(result.warnings, []);
      assert.ok(!fs.existsSync(partition.partitionPath), 'the partition must be gone');
    });

    it('deletes a cleanup-required partition', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const id = nextTaskId('retired');
      await seedOwnedTask(id, {
        owner: standaloneOwner(id),
        storageRoot,
        partition,
        state: 'cleanup-required',
      });
      assert.strictEqual((await cleanupTask(id)).safe, true);
      assert.ok(!fs.existsSync(partition.partitionPath));
    });

    it('deletes a provisional partition too, since the row itself is going away', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const id = nextTaskId('provisional');
      await seedOwnedTask(id, {
        owner: standaloneOwner(id),
        storageRoot,
        partition,
        state: 'provisional',
      });
      assert.strictEqual((await cleanupTask(id)).safe, true);
      assert.ok(
        !fs.existsSync(partition.partitionPath),
        'a provisional partition left behind would be an unreclaimable orphan'
      );
    });

    it('is a no-op for a task with no ownership record', async function () {
      const id = nextTaskId('no-ownership');
      await runStoreScript(`
        const { addTask } = await import(${JSON.stringify(storeUrl)});
        addTask({ id: ${JSON.stringify(id)}, status: 'completed', provider: 'claude', cwd: '/tmp' });
      `);
      const result = await cleanupTask(id);
      assert.strictEqual(result.safe, true);
      assert.deepStrictEqual(result.warnings, []);
    });

    it('reports success when the partition is already gone', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const id = nextTaskId('already-absent');
      await seedOwnedTask(id, { owner: standaloneOwner(id), storageRoot, partition });
      fs.rmSync(partition.partitionPath, { recursive: true });
      assert.strictEqual((await cleanupTask(id)).safe, true);
    });

    it('preserves the owner record with a warning when another row still owns the partition', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const priorId = nextTaskId('shared-prior');
      const resumedId = nextTaskId('shared-resumed');
      await seedOwnedTask(priorId, { owner: standaloneOwner(priorId), storageRoot, partition });
      await seedOwnedTask(resumedId, {
        owner: standaloneOwner(resumedId),
        storageRoot,
        partition,
        state: 'provisional',
      });

      const result = await cleanupTask(resumedId);
      assert.strictEqual(result.safe, false);
      assert.match(result.warnings.join('\n'), /still committed to/);
      assert.ok(fs.existsSync(partition.partitionPath), 'the committed owner keeps its session');
      assert.ok(result.ownership, 'the owner record is preserved for a retry');
    });

    it('clearRecord NULLs the ownership after a successful delete', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const id = nextTaskId('clear-record');
      await seedOwnedTask(id, { owner: standaloneOwner(id), storageRoot, partition });
      const result = await cleanupTask(id, { clearRecord: true });
      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.ownership, null);
    });
  });

  describe('owner validation and the check/use race', function () {
    function ownershipFor(partition, overrides = {}) {
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
      const rootStat = fs.statSync(storageRoot);
      return {
        schemaVersion: 1,
        state: 'committed',
        partitionId: partition.partitionId,
        storageRoot,
        partitionPath: partition.partitionPath,
        ownerUid: uid,
        storageRootIdentity: { device: String(rootStat.dev), inode: String(rootStat.ino) },
        partitionIdentity: partition.identity(),
        canonicalWorkspace: storageRoot,
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 't' },
        session: {
          sessionId: 'sess-1',
          fileName: partition.sessionFileName,
          fileIdentity: partition.sessionFileIdentity(),
          artifactManifestDigest: `sha256:${'a'.repeat(64)}`,
          executionFingerprint: `sha256:${'b'.repeat(64)}`,
          selectedProvider: 'anthropic',
          selectedModel: '@default',
        },
        ...overrides,
      };
    }

    it('refuses when the recorded owner uid is not the current uid', function () {
      const partition = makeSessionPartition({ storageRoot });
      const result = deleteOmpSessionPartition(ownershipFor(partition, { ownerUid: '424242' }));
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /owner uid/);
      assert.ok(fs.existsSync(partition.partitionPath));
    });

    it('refuses when the storage root identity no longer matches the recorded one', function () {
      const partition = makeSessionPartition({ storageRoot });
      const result = deleteOmpSessionPartition(
        ownershipFor(partition, { storageRootIdentity: { device: '1', inode: '999999999' } })
      );
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /does not match the recorded/);
      assert.ok(fs.existsSync(partition.partitionPath));
    });

    it('refuses when the partition identity no longer matches the recorded one', function () {
      const partition = makeSessionPartition({ storageRoot });
      const recorded = partition.identity();
      const result = deleteOmpSessionPartition(
        ownershipFor(partition, {
          partitionIdentity: { device: recorded.device, inode: String(Number(recorded.inode) + 1) },
        })
      );
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /does not match the recorded/);
      assert.ok(
        fs.existsSync(partition.partitionPath),
        'a substituted directory must never be recursively deleted'
      );
    });

    it('refuses a symlinked partition path instead of deleting through it', function () {
      const partition = makeSessionPartition({ storageRoot });
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-cleanup-decoy-'));
      fs.writeFileSync(path.join(decoy, 'precious.txt'), 'do not delete');
      const ownership = ownershipFor(partition);
      fs.rmSync(partition.partitionPath, { recursive: true });
      fs.symlinkSync(decoy, partition.partitionPath);

      const result = deleteOmpSessionPartition(ownership);
      assert.strictEqual(result.deleted, false);
      assert.ok(
        fs.existsSync(path.join(decoy, 'precious.txt')),
        'the symlink target must be untouched'
      );
    });

    it('refuses a partitionPath that is not the canonical path for its partition id', function () {
      const partition = makeSessionPartition({ storageRoot });
      const result = deleteOmpSessionPartition(
        ownershipFor(partition, { partitionPath: path.join(storageRoot, 'omp-sessions') })
      );
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /canonical partition path/);
      assert.ok(fs.existsSync(partition.partitionPath));
    });

    it('refuses a non-UUID partition id', function () {
      const partition = makeSessionPartition({ storageRoot });
      const result = deleteOmpSessionPartition(
        ownershipFor(partition, { partitionId: '../../etc' })
      );
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /Invalid OMP session partition id/);
    });

    it('stages under an unguessable name before removing, leaving nothing behind on success', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['a.txt', 'deep/b.txt'] });
      const result = deleteOmpSessionPartition(ownershipFor(partition));
      assert.strictEqual(result.deleted, true);
      const sessionsRoot = path.join(storageRoot, 'omp-sessions');
      assert.deepStrictEqual(
        fs.readdirSync(sessionsRoot),
        [],
        'no staging directory may survive a successful delete'
      );
    });
  });

  describe('the shared OMP CAS blob root is never touched', function () {
    it('leaves every blob byte-identical across delete', async function () {
      const ref = blobs.put('shared-across-sessions');
      const partition = makeSessionPartition({
        storageRoot,
        records: [{ type: 'message', content: [{ data: ref }] }],
      });
      const before = blobs.snapshot();

      const id = nextTaskId('blob-root');
      await seedOwnedTask(id, { owner: standaloneOwner(id), storageRoot, partition });
      assert.strictEqual((await cleanupTask(id)).safe, true);

      assert.ok(!fs.existsSync(partition.partitionPath));
      assert.ok(fs.existsSync(blobs.blobsDir), 'the shared store must still exist');
      assert.deepStrictEqual(blobs.snapshot(), before, 'no blob may be added, removed, or altered');
    });

    it('refuses outright if a partition path ever resolves inside the shared blob store', function () {
      const blobStorageRoot = blobs.blobRoot;
      // A tampered/migrated storageRoot that would place omp-sessions/ under the blob root.
      const partition = makeSessionPartition({ storageRoot: path.join(blobs.blobsDir, 'evil') });
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
      const rootStat = fs.statSync(path.join(blobs.blobsDir, 'evil'));
      const result = require('../helpers/omp-session-fixtures').withEnv(blobs.env, () =>
        deleteOmpSessionPartition({
          schemaVersion: 1,
          state: 'committed',
          partitionId: partition.partitionId,
          storageRoot: path.join(blobs.blobsDir, 'evil'),
          partitionPath: partition.partitionPath,
          ownerUid: uid,
          storageRootIdentity: { device: String(rootStat.dev), inode: String(rootStat.ino) },
          partitionIdentity: partition.identity(),
          canonicalWorkspace: blobStorageRoot,
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 't' },
          session: null,
        })
      );
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /shared OMP blob store/);
      assert.ok(fs.existsSync(partition.partitionPath));
    });
  });

  describe('cluster clear', function () {
    it('reclaims every partition owned by the cluster under its custom storageDir, and no others', async function () {
      const clusterStorage = fs.mkdtempSync(path.join(zeroshotHome, 'cluster-storage-'));
      const otherClusterStorage = fs.mkdtempSync(path.join(zeroshotHome, 'other-cluster-storage-'));

      const mine = makeSessionPartition({ storageRoot: clusterStorage });
      const alsoMine = makeSessionPartition({ storageRoot: clusterStorage });
      const theirs = makeSessionPartition({ storageRoot: otherClusterStorage });
      const standalone = makeSessionPartition({ storageRoot });

      const mineId = nextTaskId('cluster-mine');
      const alsoMineId = nextTaskId('cluster-also-mine');
      const theirsId = nextTaskId('cluster-theirs');
      const standaloneId = nextTaskId('cluster-standalone');

      await seedOwnedTask(mineId, {
        owner: clusterOwner(mineId, 'cluster-A'),
        storageRoot: clusterStorage,
        partition: mine,
      });
      await seedOwnedTask(alsoMineId, {
        owner: clusterOwner(alsoMineId, 'cluster-A'),
        storageRoot: clusterStorage,
        partition: alsoMine,
        state: 'cleanup-required',
      });
      await seedOwnedTask(theirsId, {
        owner: clusterOwner(theirsId, 'cluster-B'),
        storageRoot: otherClusterStorage,
        partition: theirs,
      });
      await seedOwnedTask(standaloneId, {
        owner: standaloneOwner(standaloneId),
        storageRoot,
        partition: standalone,
      });

      const result = await cleanupCluster('cluster-A');
      assert.deepStrictEqual(result.retained, []);
      assert.deepStrictEqual(
        result.deleted.sort(),
        [mine.partitionId, alsoMine.partitionId].sort()
      );
      assert.ok(!fs.existsSync(mine.partitionPath));
      assert.ok(!fs.existsSync(alsoMine.partitionPath));
      assert.ok(fs.existsSync(theirs.partitionPath), 'another cluster is untouched');
      assert.ok(fs.existsSync(standalone.partitionPath), 'standalone tasks are untouched');
    });

    it('is a no-op for an unknown cluster id', async function () {
      const result = await cleanupCluster('cluster-does-not-exist');
      assert.deepStrictEqual(result.deleted, []);
      assert.deepStrictEqual(result.retained, []);
    });
  });

  describe('global purge (cluster clear then clean --all) under a custom TASKS_DIR', function () {
    it('reclaims cluster and standalone partitions and removes every row', async function () {
      const tasksHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-purge-home-'));
      const clusterStorage = fs.mkdtempSync(path.join(tasksHome, 'cluster-storage-'));
      const standaloneStorage = fs.mkdtempSync(path.join(tasksHome, 'standalone-storage-'));

      const clusterPartition = makeSessionPartition({ storageRoot: clusterStorage });
      const standalonePartition = makeSessionPartition({ storageRoot: standaloneStorage });
      const ref = blobs.put('purge-should-not-touch-this');
      const blobsBefore = blobs.snapshot();

      const clusterTaskId = nextTaskId('purge-cluster');
      const standaloneTaskId = nextTaskId('purge-standalone');
      await seedOwnedTask(clusterTaskId, {
        owner: clusterOwner(clusterTaskId, 'cluster-P'),
        storageRoot: clusterStorage,
        partition: clusterPartition,
        tasksHome,
      });
      await seedOwnedTask(standaloneTaskId, {
        owner: standaloneOwner(standaloneTaskId),
        storageRoot: standaloneStorage,
        partition: standalonePartition,
        tasksHome,
      });

      // Phase 1 of purge: cluster clear.
      const clusterResult = await cleanupCluster('cluster-P', { tasksHome });
      assert.deepStrictEqual(clusterResult.deleted, [clusterPartition.partitionId]);
      assert.ok(!fs.existsSync(clusterPartition.partitionPath));
      assert.ok(fs.existsSync(standalonePartition.partitionPath), 'not a cluster partition');

      // Phase 2 of purge: clean --all over the same store.
      const remaining = await runCleanAll(tasksHome);
      assert.deepStrictEqual(remaining, [], 'every task row is removed');
      assert.ok(
        !fs.existsSync(standalonePartition.partitionPath),
        'the standalone partition is reclaimed under its custom TASKS_DIR'
      );
      assert.deepStrictEqual(blobs.snapshot(), blobsBefore, 'purge never touches the shared CAS');
      assert.ok(fs.existsSync(path.join(blobs.blobsDir, ref.slice('blob:sha256:'.length))));
    });
  });
});
