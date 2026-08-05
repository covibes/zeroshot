/**
 * All three OMP session-partition cleanup surfaces required by issue #866:
 *   - standalone task `clean`   (task-lib/commands/clean.js -> cleanupOmpSessionPartitionForTask)
 *   - cluster clear             (cli/index.js deleteClusterData -> cleanupOmpSessionPartitionsForCluster)
 *   - global `purge`            (cli/index.js, which runs cluster clear then `clean --all`)
 *
 * The invariants under test:
 *   - deletion is validated against the *persisted* owner (uid, storage-root identity, partition
 *     identity), not just against a path that happens to exist
 *   - the check/use race is closed by deterministic owner-bound staging before removal, and crash
 *     or removal failure retries recover that exact staged directory without deleting substitutes
 *   - an unsafe or unresolvable path preserves the owner record with an actionable warning
 *   - the shared, machine-wide OMP CAS blob root is never touched by any surface
 *   - custom cluster storage roots and a custom standalone TASKS_DIR are both reclaimed
 */

const assert = require('assert');
const { fs, os, path, pathToFileURL, runNodeModule } = require('../helpers/test-runtime');

const {
  deleteOmpSessionPartition,
  stageOmpSessionPartitionForDeletion,
} = require('../../src/omp-session-partition');
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

function runStoreScript(script, env = {}, { allowFailure = false } = {}) {
  return runNodeModule(
    script,
    { ZEROSHOT_HOME: zeroshotHome, ...env },
    allowFailure ? () => true : undefined
  );
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

/**
 * Run cleanup against an *explicit* task snapshot instead of a freshly read row — exactly what
 * every real surface does, since `clean` and cluster clear both iterate one `loadTasks()` result.
 * `ownership` is the record the snapshot carried when it was taken.
 */
async function cleanupTaskSnapshot(id, ownership) {
  const stdout = await runStoreScript(`
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    const { cleanupOmpSessionPartitionForTask } = await import(${JSON.stringify(cleanupUrl)});
    const warnings = [];
    const safe = cleanupOmpSessionPartitionForTask(
      { id: ${JSON.stringify(id)}, ompSessionOwnership: ${JSON.stringify(ownership)} },
      (m) => warnings.push(m)
    );
    process.stdout.write(JSON.stringify({ safe, warnings }));
  `);
  return JSON.parse(stdout);
}

async function getOwnership(id, tasksHome) {
  const stdout = await runStoreScript(
    `
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    process.stdout.write(JSON.stringify(getTask(${JSON.stringify(id)})?.ompSessionOwnership ?? null));
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
    { ZEROSHOT_HOME: tasksHome },
    { allowFailure: true }
  );
  return JSON.parse(stdout.split('@@').pop());
}

/** Every column of a row plus its rowid. A retained rowid proves cleanup did not perform a
 * destructive whole-table rewrite that could revert concurrent task mutations. */
async function rawRow(id, tasksHome) {
  const stdout = await runStoreScript(
    `
    const { getTaskStoreDatabase } = await import(${JSON.stringify(storeUrl)});
    const row = getTaskStoreDatabase()
      .prepare('SELECT rowid AS rowid, * FROM tasks WHERE id = ?')
      .get(${JSON.stringify(id)});
    process.stdout.write(JSON.stringify(row ?? null));
  `,
    tasksHome ? { ZEROSHOT_HOME: tasksHome } : {}
  );
  return JSON.parse(stdout);
}

/** Write arbitrary bytes straight into the ownership column, the way on-disk corruption, a partial
 * write, or a foreign writer would. Nothing in the codebase can produce these values. */
async function corruptOwnershipColumn(id, raw, tasksHome) {
  await runStoreScript(
    `
    const { getTaskStoreDatabase } = await import(${JSON.stringify(storeUrl)});
    getTaskStoreDatabase()
      .prepare('UPDATE tasks SET omp_session_ownership = ? WHERE id = ?')
      .run(${JSON.stringify(raw)}, ${JSON.stringify(id)});
  `,
    tasksHome ? { ZEROSHOT_HOME: tasksHome } : {}
  );
}

/** A stable digest of a partition subtree, for "not one byte changed" assertions. */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        entries.push(`d ${relPath}`);
        walk(abs, relPath);
      } else {
        entries.push(`f ${relPath} ${stat.ino} ${fs.readFileSync(abs).toString('hex')}`);
      }
    }
  };
  if (!fs.existsSync(root)) return null;
  entries.push(`root ${fs.statSync(root).ino}`);
  walk(root, '');
  return entries.join('\n');
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
      assert.match(result.warnings.join('\n'), /still claimed by .*\(committed\)/);
      assert.ok(fs.existsSync(partition.partitionPath), 'the committed owner keeps its session');
      assert.ok(result.ownership, 'the owner record is preserved for a retry');
    });

    it('preserves the partition of a resume that WON the transfer against a losing competitor', async function () {
      // Two competing resumes of one committed session put three rows on one partition. Only one
      // transfer can win; the winner's row is `provisional` and *no* row is committed while its
      // turn runs. A committed-only fence would see nothing here and let the retired loser delete
      // the winner's live session out from under it.
      const partition = makeSessionPartition({ storageRoot });
      const priorId = nextTaskId('race-prior');
      const winnerId = nextTaskId('race-winner');
      const loserId = nextTaskId('race-loser');

      await seedOwnedTask(priorId, { owner: standaloneOwner(priorId), storageRoot, partition });
      for (const id of [winnerId, loserId]) {
        await seedOwnedTask(id, {
          owner: standaloneOwner(id),
          storageRoot,
          partition,
          state: 'provisional',
        });
      }

      const transfers = await runStoreScript(`
        const { transferOmpSessionOwnership, markCleanupRequired } =
          await import(${JSON.stringify(ownershipUrl)});
        const won = transferOmpSessionOwnership({
          fromTaskId: ${JSON.stringify(priorId)},
          toTaskId: ${JSON.stringify(winnerId)},
        });
        const lost = transferOmpSessionOwnership({
          fromTaskId: ${JSON.stringify(priorId)},
          toTaskId: ${JSON.stringify(loserId)},
        });
        if (!lost) markCleanupRequired(${JSON.stringify(loserId)});
        process.stdout.write(JSON.stringify({ won: !!won, lost: !!lost }));
      `);
      const outcome = JSON.parse(transfers);
      assert.strictEqual(outcome.won, true);
      assert.strictEqual(outcome.lost, false, 'only one transfer may apply');

      const result = await cleanupTask(loserId);
      assert.strictEqual(result.safe, false, 'the retired loser must not reclaim the partition');
      assert.match(result.warnings.join('\n'), /still claimed by .*\(provisional\)/);
      assert.ok(
        fs.existsSync(partition.partitionPath),
        "the winning resume's live session must survive"
      );
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

  describe('the query-to-staging-rename race', function () {
    it('refuses a snapshot whose row transferred the partition away after it was loaded', async function () {
      // The pre-stage concurrent transfer. Every cleanup surface iterates one `loadTasks()`
      // result, so the record it validates is a snapshot; a resume that wins its owner transfer
      // between that read and the staging rename leaves the snapshot describing a record the row
      // no longer holds, while the partition itself is now a *live* turn's working session.
      const partition = makeSessionPartition({ storageRoot });
      const priorId = nextTaskId('prestage-prior');
      const resumedId = nextTaskId('prestage-resumed');
      await seedOwnedTask(priorId, { owner: standaloneOwner(priorId), storageRoot, partition });
      await seedOwnedTask(resumedId, {
        owner: standaloneOwner(resumedId),
        storageRoot,
        partition,
        state: 'provisional',
      });

      // The snapshot `clean` would be holding, taken while the prior owner was still committed.
      const snapshot = await getOwnership(priorId);
      assert.strictEqual(snapshot.state, 'committed');

      const transferred = await runStoreScript(`
        const { transferOmpSessionOwnership } = await import(${JSON.stringify(ownershipUrl)});
        process.stdout.write(JSON.stringify(!!transferOmpSessionOwnership({
          fromTaskId: ${JSON.stringify(priorId)},
          toTaskId: ${JSON.stringify(resumedId)},
        })));
      `);
      assert.strictEqual(JSON.parse(transferred), true, 'the resume must win the partition');

      const result = await cleanupTaskSnapshot(priorId, snapshot);
      assert.strictEqual(result.safe, false);
      assert.match(
        result.warnings.join('\n'),
        /ownership record changed while cleanup was running/,
        'the fenced re-read of the row must be what refuses, before any owner-claim check'
      );
      assert.ok(
        fs.existsSync(partition.partitionPath),
        "the resumed turn's live session must survive a stale-snapshot cleanup"
      );
      const winner = await getOwnership(resumedId);
      assert.strictEqual(winner.state, 'provisional');
      assert.ok(winner.session, 'the winner keeps the lineage it inherited');
    });

    it('refuses a stale snapshot even when no other row claims the partition', async function () {
      // The owner-claim fence cannot catch this one: the released row is the only row naming the
      // partition, so only the fenced re-read of the row's own record stands between a stale
      // snapshot and a deletion the current owner never authorised.
      const partition = makeSessionPartition({ storageRoot });
      const id = nextTaskId('prestage-released');
      await seedOwnedTask(id, { owner: standaloneOwner(id), storageRoot, partition });
      const snapshot = await getOwnership(id);

      await runStoreScript(`
        const { updateTask } = await import(${JSON.stringify(storeUrl)});
        updateTask(${JSON.stringify(id)}, { ompSessionOwnership: null });
      `);

      const result = await cleanupTaskSnapshot(id, snapshot);
      assert.strictEqual(result.safe, false);
      assert.match(
        result.warnings.join('\n'),
        /ownership record changed while cleanup was running/
      );
      assert.ok(fs.existsSync(partition.partitionPath));
    });

    it('stays idempotent across several retired rows naming one partition, without deadlocking', async function () {
      // The third-owner residue: competing resumes that both failed leave more than one
      // `cleanup-required` row on a single partition. A retired row makes no authoritative claim,
      // so these must not fence each other out — otherwise the partition is unreclaimable by
      // anybody and `clean` reports a permanent failure.
      const partition = makeSessionPartition({ storageRoot });
      const firstId = nextTaskId('retired-a');
      const secondId = nextTaskId('retired-b');
      for (const id of [firstId, secondId]) {
        await seedOwnedTask(id, {
          owner: standaloneOwner(id),
          storageRoot,
          partition,
          state: 'cleanup-required',
        });
      }

      const first = await cleanupTask(firstId);
      assert.strictEqual(first.safe, true);
      assert.deepStrictEqual(first.warnings, []);
      assert.ok(!fs.existsSync(partition.partitionPath), 'the first retired row reclaims it');

      const second = await cleanupTask(secondId);
      assert.strictEqual(
        second.safe,
        true,
        'the second retired row must not deadlock on the first'
      );
      assert.deepStrictEqual(second.warnings, []);

      const replay = await cleanupTask(firstId);
      assert.strictEqual(replay.safe, true, 'cleanup is idempotent on replay');
      assert.deepStrictEqual(replay.warnings, []);
    });
  });

  describe('an unreadable ownership record is evidence, not an absence', function () {
    // Its own task store per case: a corrupted row is deliberately never removed, so it would
    // otherwise accumulate into every later assertion that enumerates the shared store.
    let corruptHome;
    beforeEach(function () {
      corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-corrupt-home-'));
    });

    // `parseOmpSessionOwnership` collapses SQL NULL and unreadable bytes to the same `null`, and
    // those mean opposite things: NULL is exact truth that nothing was ever allocated, while
    // unreadable bytes may be the last remaining pointer to a real partition. Deleting the row on
    // that basis orphans the partition permanently — nothing else in the system knows it exists,
    // because cleanup is driven by task rows and never by scanning the partition tree.
    const CORRUPTIONS = [
      { label: 'truncated JSON', raw: '{"schemaVersion":1,"state":"comm' },
      { label: 'not JSON at all', raw: 'NUL bytes' },
      { label: 'empty string', raw: '' },
      { label: 'JSON of the wrong type', raw: '"just a string"' },
      { label: 'valid JSON, invalid record', raw: '{"schemaVersion":1,"state":"nonsense"}' },
    ];

    for (const { label, raw } of CORRUPTIONS) {
      it(`standalone clean retains the row and warns (${label})`, async function () {
        const partition = makeSessionPartition({ storageRoot });
        const id = nextTaskId('corrupt-clean');
        await seedOwnedTask(id, {
          owner: standaloneOwner(id),
          storageRoot,
          partition,
          tasksHome: corruptHome,
        });
        await corruptOwnershipColumn(id, raw, corruptHome);

        const result = await cleanupTask(id, { tasksHome: corruptHome });
        assert.strictEqual(result.safe, false, 'the row must not be reported safe to remove');
        assert.match(result.warnings.join('\n'), /present but unreadable/);
        assert.match(result.warnings.join('\n'), /reclaimed manually/);
        assert.ok(
          fs.existsSync(partition.partitionPath),
          'nothing may be deleted on the strength of an unreadable record'
        );

        const row = await rawRow(id, corruptHome);
        assert.strictEqual(row.omp_session_ownership, raw, 'the evidence is preserved verbatim');
      });
    }

    it('`clean --all` keeps the whole row, so the evidence survives the surface that deletes rows', async function () {
      const tasksHome = corruptHome;
      const home = fs.mkdtempSync(path.join(tasksHome, 'storage-'));
      const corrupt = makeSessionPartition({ storageRoot: home });
      const healthy = makeSessionPartition({ storageRoot: home });
      const corruptId = nextTaskId('corrupt-clean-all');
      const healthyId = nextTaskId('healthy-clean-all');

      await seedOwnedTask(corruptId, {
        owner: standaloneOwner(corruptId),
        storageRoot: home,
        partition: corrupt,
        tasksHome,
      });
      await seedOwnedTask(healthyId, {
        owner: standaloneOwner(healthyId),
        storageRoot: home,
        partition: healthy,
        tasksHome,
      });
      await corruptOwnershipColumn(corruptId, '{"schemaVersion":1,"state":"comm', tasksHome);
      const remaining = await runCleanAll(tasksHome);

      assert.deepStrictEqual(
        remaining.sort(),
        [corruptId, healthyId].sort(),
        'unknown ownership evidence globally blocks every partition deletion'
      );
      assert.ok(fs.existsSync(corrupt.partitionPath), 'its partition is retained too');
      assert.ok(
        fs.existsSync(healthy.partitionPath),
        'a healthy neighbour is retained until the unknown evidence is repaired'
      );
    });

    it('cluster clear reports it separately, because an unreadable record names no cluster', async function () {
      const clusterStorage = fs.mkdtempSync(path.join(zeroshotHome, 'corrupt-cluster-storage-'));
      const mine = makeSessionPartition({ storageRoot: clusterStorage });
      const broken = makeSessionPartition({ storageRoot: clusterStorage });
      const mineId = nextTaskId('corrupt-cluster-mine');
      const brokenId = nextTaskId('corrupt-cluster-broken');

      await seedOwnedTask(mineId, {
        owner: clusterOwner(mineId, 'cluster-C'),
        storageRoot: clusterStorage,
        partition: mine,
        tasksHome: corruptHome,
      });
      await seedOwnedTask(brokenId, {
        owner: clusterOwner(brokenId, 'cluster-C'),
        storageRoot: clusterStorage,
        partition: broken,
        tasksHome: corruptHome,
      });
      await corruptOwnershipColumn(brokenId, '{oh no', corruptHome);
      const result = await cleanupCluster('cluster-C', { tasksHome: corruptHome });

      assert.deepStrictEqual(result.deleted, []);
      assert.deepStrictEqual(result.retained, [mine.partitionId]);
      assert.deepStrictEqual(result.unreadable, [brokenId]);
      assert.match(result.warnings.join('\n'), /cannot be attributed to a cluster/);
      assert.match(result.warnings.join('\n'), /unreadable or invalid; inspect or repair/);
      assert.ok(fs.existsSync(mine.partitionPath), 'unknown evidence blocks cluster deletion');
      assert.ok(fs.existsSync(broken.partitionPath), 'the unattributable partition is retained');
      assert.strictEqual((await rawRow(brokenId, corruptHome)).omp_session_ownership, '{oh no');
    });

    it('globally blocks deletion when only a different malformed non-null row exists', async function () {
      const partition = makeSessionPartition({ storageRoot });
      const actingId = nextTaskId('unknown-fence-acting');
      const corruptId = nextTaskId('unknown-fence-corrupt');

      await seedOwnedTask(actingId, {
        owner: standaloneOwner(actingId),
        storageRoot,
        partition,
        state: 'cleanup-required',
        tasksHome: corruptHome,
      });
      const decoy = makeSessionPartition({ storageRoot });
      await seedOwnedTask(corruptId, {
        owner: standaloneOwner(corruptId),
        storageRoot,
        partition: decoy,
        tasksHome: corruptHome,
      });
      await corruptOwnershipColumn(corruptId, 'definitely not json', corruptHome);

      const result = await cleanupTask(actingId, { tasksHome: corruptHome });
      assert.strictEqual(result.safe, false, 'unknown evidence must block every partition');
      assert.ok(result.warnings.join('\n').includes(corruptId));
      assert.match(result.warnings.join('\n'), /unreadable or invalid; inspect or repair/);
      assert.ok(fs.existsSync(partition.partitionPath), 'the acting partition survives');
      assert.ok(
        await getOwnership(actingId, corruptHome),
        'the acting owner record remains retryable'
      );
    });
  });

  describe('concurrency: `clean` must not act on a stale snapshot', function () {
    it('never touches a running task, row or partition, even under --all', async function () {
      // A running task owns everything the row points at: the partition is a live provider
      // process's working directory. The live-task check used to sit *inside* the commandCleanup
      // branch, i.e. after the OMP partition had already been staged and recursively deleted, so a
      // running task without a cleanup receipt lost its session to `clean --all`.
      const tasksHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-live-home-'));
      const home = fs.mkdtempSync(path.join(tasksHome, 'storage-'));
      const live = makeSessionPartition({ storageRoot: home, artifacts: ['a.txt', 'deep/b.txt'] });
      const liveId = nextTaskId('live-running');

      await seedOwnedTask(liveId, {
        owner: standaloneOwner(liveId),
        storageRoot: home,
        partition: live,
        state: 'provisional',
        tasksHome,
      });
      await runStoreScript(
        `
        const { getTaskStoreDatabase } = await import(${JSON.stringify(storeUrl)});
        getTaskStoreDatabase()
          .prepare("UPDATE tasks SET status = 'running', pid = 4242 WHERE id = ?")
          .run(${JSON.stringify(liveId)});
      `,
        { ZEROSHOT_HOME: tasksHome }
      );

      const rowBefore = await rawRow(liveId, tasksHome);
      const treeBefore = snapshotTree(live.partitionPath);

      const remaining = await runCleanAll(tasksHome);
      assert.deepStrictEqual(remaining, [liveId], 'the running row is retained');
      assert.deepStrictEqual(
        await rawRow(liveId, tasksHome),
        rowBefore,
        'not one column of a live row may change, and the rowid proves the table was not rewritten'
      );
      assert.strictEqual(
        snapshotTree(live.partitionPath),
        treeBefore,
        "a live session's partition must be byte-identical after clean --all"
      );
    });

    it('leaves a retained row at its original rowid, proving no whole-table rewrite', async function () {
      // A whole-table snapshot replacement would mint fresh rowids and revert anything a
      // concurrent writer changed during the run. The stable rowid is its observable fingerprint.
      const tasksHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-rowid-home-'));
      const home = fs.mkdtempSync(path.join(tasksHome, 'storage-'));
      const keptPartition = makeSessionPartition({ storageRoot: home });
      const goneParition = makeSessionPartition({ storageRoot: home });
      const keptId = nextTaskId('rowid-kept');
      const goneId = nextTaskId('rowid-gone');

      await seedOwnedTask(keptId, {
        owner: standaloneOwner(keptId),
        storageRoot: home,
        partition: keptPartition,
        tasksHome,
      });
      await seedOwnedTask(goneId, {
        owner: standaloneOwner(goneId),
        storageRoot: home,
        partition: goneParition,
        tasksHome,
      });
      await corruptOwnershipColumn(keptId, '{retained because unreadable', tasksHome);
      const before = await rawRow(keptId, tasksHome);

      await runCleanAll(tasksHome);

      const after = await rawRow(keptId, tasksHome);
      assert.strictEqual(after.rowid, before.rowid, 'a retained row keeps its identity');
      assert.deepStrictEqual(after, before, 'and every one of its columns');
      assert.ok(
        fs.existsSync(goneParition.partitionPath),
        'unknown ownership evidence globally blocks the other partition too'
      );
    });

    it('refuses to remove a row whose ownership was transferred away after the snapshot was taken', async function () {
      // The exact interleave: `clean` decides what to remove from one loadTasks() snapshot, then
      // does real work before it gets to the delete. A resume that wins its ownership transfer in
      // that window leaves the snapshot describing a record the row no longer holds — and the
      // partition is now a live turn's working session. The removal is fenced on the snapshot, so
      // it refuses; crucially, it must also not write the snapshot back.
      const tasksHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-interleave-home-'));
      const home = fs.mkdtempSync(path.join(tasksHome, 'storage-'));
      const partition = makeSessionPartition({ storageRoot: home });
      const priorId = nextTaskId('interleave-prior');
      const resumedId = nextTaskId('interleave-resumed');

      await seedOwnedTask(priorId, {
        owner: standaloneOwner(priorId),
        storageRoot: home,
        partition,
        tasksHome,
      });
      await seedOwnedTask(resumedId, {
        owner: standaloneOwner(resumedId),
        storageRoot: home,
        partition,
        state: 'provisional',
        tasksHome,
      });

      const outcome = JSON.parse(
        (
          await runStoreScript(
            `
        const { getTask, loadTasks } = await import(${JSON.stringify(storeUrl)});
        const { transferOmpSessionOwnership } = await import(${JSON.stringify(ownershipUrl)});
        const { removeCleanedTask } = await import(${JSON.stringify(cleanCommandUrl)});

        // 1. clean loads its snapshot.
        const snapshot = loadTasks()[${JSON.stringify(priorId)}];

        // 2. a resume wins the partition in the window before the removal.
        const transferred = !!transferOmpSessionOwnership({
          fromTaskId: ${JSON.stringify(priorId)},
          toTaskId: ${JSON.stringify(resumedId)},
        });

        // 3. clean reaches the removal, still holding the stale snapshot.
        const warnings = [];
        const removal = removeCleanedTask(snapshot, { warn: (m) => warnings.push(m) });

        process.stdout.write('\\n@@' + JSON.stringify({
          transferred,
          removal,
          warnings,
          priorStillExists: getTask(${JSON.stringify(priorId)}) !== null,
          priorOwnership: getTask(${JSON.stringify(priorId)})?.ompSessionOwnership ?? null,
          winner: getTask(${JSON.stringify(resumedId)}).ompSessionOwnership,
        }));
      `,
            { ZEROSHOT_HOME: tasksHome }
          )
        )
          .split('@@')
          .pop()
      );

      assert.strictEqual(outcome.transferred, true, 'the resume must win the partition');
      assert.strictEqual(outcome.removal.removed, false, 'the stale removal must be refused');
      assert.match(
        outcome.warnings.join('\n') + outcome.removal.reason,
        /ownership record changed while cleanup was running|changed while it was being cleaned/
      );
      assert.strictEqual(outcome.priorStillExists, true, 'the row survives the refused removal');
      assert.strictEqual(
        outcome.priorOwnership,
        null,
        'the concurrent release must NOT be reverted by cleanup writing its snapshot back'
      );
      assert.strictEqual(outcome.winner.state, 'provisional');
      assert.ok(outcome.winner.session, 'the winner keeps the lineage it inherited');
      assert.ok(fs.existsSync(partition.partitionPath), "the live turn's session survives");
    });
    it('preserves a concurrent replacement cleanup receipt after processing the snapshot receipt', async function () {
      const tasksHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-cleanup-cas-home-'));
      const oldCleanup = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroshot-claude-settings-old-cleanup-')
      );
      const newCleanup = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zeroshot-claude-settings-new-cleanup-')
      );
      const id = nextTaskId('command-cleanup-cas');
      const receipt = (cleanupPath) => ({
        cleanup: [cleanupPath],
        cleanupMetadata: [
          {
            kind: 'temp-directory',
            provider: 'claude',
            path: cleanupPath,
            reason: 'settings-overlay',
          },
        ],
      });
      const oldReceipt = receipt(oldCleanup);
      const newReceipt = receipt(newCleanup);

      const outcome = JSON.parse(
        await runStoreScript(
          `
        const { addTask, getTask, loadTasks, updateTask } =
          await import(${JSON.stringify(storeUrl)});
        const { removeCleanedTask } = await import(${JSON.stringify(cleanCommandUrl)});
        addTask({
          id: ${JSON.stringify(id)},
          status: 'failed',
          provider: 'claude',
          cwd: process.cwd(),
          commandCleanup: ${JSON.stringify(oldReceipt)},
        });
        const snapshot = loadTasks()[${JSON.stringify(id)}];
        updateTask(${JSON.stringify(id)}, {
          status: 'stale',
          commandCleanup: ${JSON.stringify(newReceipt)},
        });
        const warnings = [];
        const removal = removeCleanedTask(snapshot, { warn: (m) => warnings.push(m) });
        process.stdout.write(JSON.stringify({
          removal,
          warnings,
          current: getTask(${JSON.stringify(id)}),
        }));
      `,
          { ZEROSHOT_HOME: tasksHome }
        )
      );

      assert.strictEqual(outcome.removal.removed, false);
      assert.match(outcome.removal.reason, /changed while it was being cleaned/);
      assert.ok(!fs.existsSync(oldCleanup), 'the processed snapshot receipt is cleaned');
      assert.ok(fs.existsSync(newCleanup), 'the concurrent replacement resource survives');
      assert.deepStrictEqual(
        outcome.current.commandCleanup,
        newReceipt,
        'the concurrent replacement receipt remains durable'
      );
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

    it('stages under its deterministic owner-bound name before removing', function () {
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

    it('recovers deterministic staged deletion after a crash between rename and removal', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['recover.txt'] });
      const ownership = ownershipFor(partition);
      const staged = stageOmpSessionPartitionForDeletion(ownership);
      assert.strictEqual(staged.staged, true);
      assert.ok(!fs.existsSync(partition.partitionPath), 'the canonical name is already gone');
      assert.ok(fs.existsSync(staged.stagingPath), 'the deterministic staged tree remains');

      const retried = deleteOmpSessionPartition(ownership);
      assert.strictEqual(retried.deleted, true);
      assert.ok(!fs.existsSync(staged.stagingPath), 'the exact staged tree is reclaimed on retry');
    });

    it('retries the exact staged directory after recursive removal fails', function () {
      const partition = makeSessionPartition({ storageRoot, artifacts: ['retry.txt'] });
      const ownership = ownershipFor(partition);
      const originalRmSync = fs.rmSync;
      let failedOnce = false;
      fs.rmSync = function failFirstStagedRemoval(target, options) {
        if (!failedOnce && path.basename(target).startsWith('.zeroshot-deleting-')) {
          failedOnce = true;
          throw Object.assign(new Error('injected rm failure'), { code: 'EIO' });
        }
        return originalRmSync.call(this, target, options);
      };

      let first;
      try {
        first = deleteOmpSessionPartition(ownership);
      } finally {
        fs.rmSync = originalRmSync;
      }
      assert.strictEqual(first.deleted, false);
      assert.match(first.reason, /injected rm failure/);
      assert.ok(!fs.existsSync(partition.partitionPath), 'the canonical name stays absent');
      const stagedNames = fs
        .readdirSync(path.join(storageRoot, 'omp-sessions'))
        .filter((name) => name.startsWith('.zeroshot-deleting-'));
      assert.strictEqual(stagedNames.length, 1, 'one deterministic staged tree remains');

      const retried = deleteOmpSessionPartition(ownership);
      assert.strictEqual(retried.deleted, true);
      assert.deepStrictEqual(fs.readdirSync(path.join(storageRoot, 'omp-sessions')), []);
    });

    it('fails closed when canonical and deterministic staged names both exist', function () {
      const partition = makeSessionPartition({ storageRoot });
      const ownership = ownershipFor(partition);
      const staged = stageOmpSessionPartitionForDeletion(ownership);
      assert.strictEqual(staged.staged, true);
      fs.mkdirSync(partition.partitionPath, { mode: 0o700 });

      const result = deleteOmpSessionPartition(ownership);
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /both canonical .* and staged .* exist/);
      assert.ok(fs.existsSync(partition.partitionPath));
      assert.ok(fs.existsSync(staged.stagingPath));
    });

    it('fails closed when a staged directory no longer has the persisted partition identity', function () {
      const partition = makeSessionPartition({ storageRoot });
      const ownership = ownershipFor(partition);
      const staged = stageOmpSessionPartitionForDeletion(ownership);
      assert.strictEqual(staged.staged, true);
      // Keep the original inode live under another name so filesystems cannot immediately reuse it
      // for the substitute and make this identity-mismatch regression nondeterministic.
      fs.renameSync(staged.stagingPath, `${staged.stagingPath}.displaced`);
      fs.mkdirSync(staged.stagingPath, { mode: 0o700 });

      const result = deleteOmpSessionPartition(ownership);
      assert.strictEqual(result.deleted, false);
      assert.match(result.reason, /does not match the recorded/);
      assert.ok(fs.existsSync(staged.stagingPath), 'the substitute is left for inspection');
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
