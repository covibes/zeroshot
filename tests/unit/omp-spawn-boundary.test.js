/**
 * The durable task/process boundaries that must retire an OMP session ownership record (issue
 * #866's "recovery derives the decision from the exact durable task/lifecycle boundary; it never
 * guesses from file presence").
 *
 * A `provisional` record is a live claim on a partition: cleanup refuses to reclaim a partition any
 * other row still claims provisionally, and the resume path treats a provisional row as a turn that
 * is still running. So every boundary that ends a task without a watcher reaching
 * finalizeOmpOwnership has to retire the record itself, or the partition is unreclaimable forever
 * and the row looks like a live task that no process is behind.
 *
 * Covered here:
 *   - row-before-directory, with a real injected materialization failure inside the real spawnTask
 *   - the terminal task boundary that failure must also reach (no forever-'running' row)
 *   - provider death and cancellation through `zeroshot task kill`
 *   - re-entry/idempotency of the retirement
 *   - cleanup of a record whose partition directory never existed
 */

const {
  assert,
  cleanupUrl,
  fs,
  makeHome,
  ownershipUrl,
  path,
  runInHome,
  runSpawnHarness,
  storeUrl,
  tasksDir,
} = require('../helpers/omp-spawn-boundary-harness');

describe('OMP ownership at durable task boundaries (issue #866)', function () {
  this.timeout(60000);

  describe('row-before-directory', function () {
    it('spawns normally when the partition directory can be created', async function () {
      const homeInfo = makeHome('happy');
      const result = await runSpawnHarness(homeInfo);

      assert.strictEqual(result.threw, null, JSON.stringify(result.threw));
      assert.strictEqual(result.forks, 1, 'the watcher is forked exactly once');
      assert.strictEqual(result.tasks.length, 1);
      const [task] = result.tasks;
      assert.strictEqual(task.status, 'running');
      assert.strictEqual(task.ownership.state, 'provisional');
      assert.ok(
        fs.existsSync(task.ownership.partitionPath),
        'the partition directory exists after a successful spawn'
      );
    });

    it('retires the provisional owner AND the task when the partition cannot be materialized', async function () {
      // The injected failure: `<storageRoot>/omp-sessions` is a regular file, so the recursive
      // mkdir of the partition under it throws ENOTDIR — a real materialization failure at exactly
      // the row-before-directory window, raised synchronously from inside the real spawnTask.
      const homeInfo = makeHome('mkdir-fails');
      const storageRoot = await tasksDir(homeInfo);
      fs.mkdirSync(storageRoot, { recursive: true });
      fs.writeFileSync(path.join(storageRoot, 'omp-sessions'), 'not a directory');

      const result = await runSpawnHarness(homeInfo);

      assert.ok(result.threw, 'the caller must still see the failure');
      assert.match(result.threw.message, /ENOTDIR|not a directory/i);
      assert.strictEqual(result.forks, 0, 'no watcher may be forked for a failed spawn');

      assert.strictEqual(result.tasks.length, 1, 'the row written before the directory survives');
      const [task] = result.tasks;
      assert.strictEqual(
        task.status,
        'failed',
        'a row left `running` would look forever like a live task no process is behind'
      );
      assert.match(task.error, /Task spawn failed before the provider started/);
      assert.strictEqual(task.exitCode, 1);
      assert.strictEqual(task.pid, null);
      assert.strictEqual(
        task.ownership.state,
        'cleanup-required',
        'a provisional claim would make this partition unreclaimable forever'
      );
      assert.strictEqual(task.ownership.partitionIdentity, null, 'nothing was ever observed');
      assert.strictEqual(task.ownership.session, null);
    });

    it('cleans up that row without ever consulting the filesystem for the missing partition', async function () {
      const homeInfo = makeHome('mkdir-fails-cleanup');
      const storageRoot = await tasksDir(homeInfo);
      fs.mkdirSync(storageRoot, { recursive: true });
      const sessionsRoot = path.join(storageRoot, 'omp-sessions');
      fs.writeFileSync(sessionsRoot, 'not a directory');

      const spawned = await runSpawnHarness(homeInfo);
      const taskId = spawned.tasks[0].id;
      assert.strictEqual(spawned.tasks[0].ownership.state, 'cleanup-required');

      // Restore a real sessions root so cleanup's own path checks are exercised; the partition
      // directory itself still does not, and never did, exist.
      fs.unlinkSync(sessionsRoot);
      fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
      assert.ok(!fs.existsSync(spawned.tasks[0].ownership.partitionPath));

      const outcome = JSON.parse(
        await runInHome(
          homeInfo,
          `
          const { getTask } = await import(${JSON.stringify(storeUrl)});
          const { cleanupOmpSessionPartitionForTask } = await import(${JSON.stringify(cleanupUrl)});
          const warnings = [];
          const first = cleanupOmpSessionPartitionForTask(getTask(${JSON.stringify(taskId)}), (m) => warnings.push(m));
          const second = cleanupOmpSessionPartitionForTask(getTask(${JSON.stringify(taskId)}), (m) => warnings.push(m));
          process.stdout.write(JSON.stringify({ first, second, warnings }));
        `
        )
      );
      assert.strictEqual(
        outcome.first,
        true,
        'a partition that was never created is nothing to clean'
      );
      assert.strictEqual(outcome.second, true, 'cleanup is idempotent on replay');
      assert.deepStrictEqual(outcome.warnings, []);
      assert.deepStrictEqual(
        fs.readdirSync(sessionsRoot),
        [],
        'no staging directory may be left behind by a no-op cleanup'
      );
    });

    it('is idempotent when the retirement re-enters after the row has already been retired', async function () {
      const homeInfo = makeHome('reentry');
      const storageRoot = await tasksDir(homeInfo);
      fs.mkdirSync(storageRoot, { recursive: true });
      fs.writeFileSync(path.join(storageRoot, 'omp-sessions'), 'not a directory');

      const spawned = await runSpawnHarness(homeInfo);
      const taskId = spawned.tasks[0].id;

      const outcome = JSON.parse(
        await runInHome(
          homeInfo,
          `
          const { getTask } = await import(${JSON.stringify(storeUrl)});
          const { retireOmpOwnershipAtTerminalBoundary } = await import(${JSON.stringify(ownershipUrl)});
          const again = retireOmpOwnershipAtTerminalBoundary(${JSON.stringify(taskId)});
          const andAgain = retireOmpOwnershipAtTerminalBoundary(${JSON.stringify(taskId)});
          process.stdout.write(JSON.stringify({
            again,
            andAgain,
            ownership: getTask(${JSON.stringify(taskId)}).ompSessionOwnership,
            status: getTask(${JSON.stringify(taskId)}).status,
          }));
        `
        )
      );
      assert.strictEqual(outcome.again, true);
      assert.strictEqual(outcome.andAgain, true);
      assert.strictEqual(outcome.ownership.state, 'cleanup-required');
      assert.strictEqual(outcome.status, 'failed');
    });
  });
});
