const spawnBoundary = require('../helpers/omp-spawn-boundary-harness');
const { assert, fs, path } = spawnBoundary;
const { killCommandUrl, makeHome, ownershipUrl, runInHome, storeUrl, tasksDir } = spawnBoundary;

describe('OMP ownership at durable task boundaries (issue #866)', function () {
  this.timeout(60000);

  describe('provider death and cancellation (task-lib/commands/kill.js)', function () {
    /** Seed a running OMP task holding a provisional claim, with `pid` under the test's control. */
    async function seedRunningOmpTask(homeInfo, { id, pid, partitionId }) {
      const storageRoot = await tasksDir(homeInfo);
      fs.mkdirSync(path.join(storageRoot, 'omp-sessions', partitionId), {
        recursive: true,
        mode: 0o700,
      });
      await runInHome(
        homeInfo,
        `
        const { addTask } = await import(${JSON.stringify(storeUrl)});
        const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
        const owner = {
          kind: 'standalone', clusterId: null, agentId: null, taskId: ${JSON.stringify(id)},
        };
        const ownership = writeProvisionalOwnership({
          partitionId: ${JSON.stringify(partitionId)},
          storageRoot: ${JSON.stringify(storageRoot)},
          canonicalWorkspace: ${JSON.stringify(storageRoot)},
          owner,
        });
        addTask({
          id: ${JSON.stringify(id)},
          status: 'running',
          provider: 'omp',
          pid: ${JSON.stringify(pid)},
          cwd: ${JSON.stringify(storageRoot)},
          ompSessionOwnership: ownership,
        });
      `
      );
    }

    async function killTask(homeInfo, id, terminateResult) {
      const stdout = await runInHome(
        homeInfo,
        `
        const { getTask } = await import(${JSON.stringify(storeUrl)});
        const { killTaskCommand } = await import(${JSON.stringify(killCommandUrl)});
        await killTaskCommand(${JSON.stringify(id)}, {
          terminateProcessFn: async () => (${JSON.stringify(terminateResult)}),
        });
        const task = getTask(${JSON.stringify(id)});
        process.stdout.write('\\n@@' + JSON.stringify({
          status: task.status,
          ownership: task.ompSessionOwnership,
        }));
      `
      );
      return JSON.parse(stdout.split('@@').pop());
    }

    it('retires the record when the provider is confirmed dead (stale)', async function () {
      // Provider death: the process is already gone, so no watcher will ever reach
      // finalizeOmpOwnership for this task. The kill boundary is the only place left that knows.
      const homeInfo = makeHome('kill-stale');
      const id = 'omp-kill-stale';
      const partitionId = '2f5a1c00-0000-4000-8000-000000000001';
      await seedRunningOmpTask(homeInfo, { id, pid: 424242, partitionId });

      const result = await killTask(homeInfo, id, { terminated: true, alreadyDead: true });
      assert.strictEqual(result.status, 'stale');
      assert.strictEqual(result.ownership.state, 'cleanup-required');
    });

    it('retires the record when the task is killed by the user', async function () {
      const homeInfo = makeHome('kill-killed');
      const id = 'omp-kill-killed';
      const partitionId = '2f5a1c00-0000-4000-8000-000000000002';
      await seedRunningOmpTask(homeInfo, { id, pid: 424243, partitionId });

      const result = await killTask(homeInfo, id, { terminated: true, alreadyDead: false });
      assert.strictEqual(result.status, 'killed');
      assert.strictEqual(result.ownership.state, 'cleanup-required');
    });

    it('leaves the claim alone when termination FAILED, because the provider may still be running', async function () {
      // Fail-closed in the other direction: an unconfirmed termination is not a terminal boundary.
      // Retiring here would let cleanup delete the partition of a provider still writing into it.
      const homeInfo = makeHome('kill-failed');
      const id = 'omp-kill-failed';
      const partitionId = '2f5a1c00-0000-4000-8000-000000000003';
      await seedRunningOmpTask(homeInfo, { id, pid: 424244, partitionId });

      const result = await killTask(homeInfo, id, {
        terminated: false,
        error: 'still alive',
      });
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.ownership.state, 'provisional');
    });

    it('persists a pending cancellation without retiring the claim, since the provider may still start', async function () {
      // `zeroshot task kill` on a task that has not published a PID persists the cancellation and
      // waits. That is deliberately NOT a terminal boundary: the provider may be seconds from
      // spawning, and retiring the claim here would let cleanup delete a partition it is about to
      // write into. The watcher owns that boundary (rpc-watcher.js retires the record on both its
      // cancellation paths, proven end to end in tests/omp-rpc-watcher.test.js).
      const homeInfo = makeHome('kill-cancel');
      const id = 'omp-kill-cancel';
      const partitionId = '2f5a1c00-0000-4000-8000-000000000004';
      await seedRunningOmpTask(homeInfo, { id, pid: null, partitionId });

      const stdout = await runInHome(
        homeInfo,
        `
        const { getTask } = await import(${JSON.stringify(storeUrl)});
        const { killTaskCommand } = await import(${JSON.stringify(killCommandUrl)});
        await killTaskCommand(${JSON.stringify(id)}, {
          startupCancelTimeoutMs: 300,
          startupCancelPollMs: 25,
        });
        const task = getTask(${JSON.stringify(id)});
        process.stdout.write('\\n@@' + JSON.stringify({
          status: task.status,
          cancelRequested: task.cancelRequested,
          ownership: task.ompSessionOwnership,
        }));
      `
      );
      const result = JSON.parse(stdout.split('@@').pop());
      assert.strictEqual(result.cancelRequested, true);
      assert.strictEqual(result.ownership.state, 'provisional');
    });
  });
});
