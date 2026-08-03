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

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const {
  createExplicitOmpRpcSettings,
  FAKE_OMP_WITH_RPC,
} = require('../helpers/explicit-omp-rpc-settings');

const execFileAsync = promisify(execFile);

const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const runnerUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/runner.js')).href;
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-ownership.js')
).href;
const cleanupUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-cleanup.js')
).href;
const killCommandUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/commands/kill.js')
).href;

/**
 * Run the real `spawnTask` for provider omp, with fork() stubbed so no watcher process is actually
 * created. Reports whether spawnTask threw, how many watchers it forked, and the resulting row.
 */
const SPAWN_HARNESS = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('child_process');

const forks = [];
childProcess.fork = (script, argv, options) => {
  forks.push({ script, argv, options });
  return {
    stdin: { on() {}, end() {} },
    unref() {},
    disconnect() {},
  };
};

const { spawnTask } = await import(${JSON.stringify(runnerUrl)});
const { loadTasks } = await import(${JSON.stringify(storeUrl)});

let threw = null;
let spawnedId = null;
try {
  spawnedId = spawnTask('do the thing', { provider: 'omp', model: 'test-model' })?.id ?? null;
} catch (error) {
  threw = { message: error.message, code: error.code ?? null };
}

process.stdout.write('\\n@@' + JSON.stringify({
  threw,
  spawnedId,
  forks: forks.length,
  tasks: Object.values(loadTasks()).map((task) => ({
    id: task.id,
    status: task.status,
    error: task.error,
    exitCode: task.exitCode,
    pid: task.pid,
    ownership: task.ompSessionOwnership,
  })),
}));
`;

function makeHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `zeroshot-omp-spawn-${label}-`));
  const { env: rpcSettingsEnv } = createExplicitOmpRpcSettings(home);
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const fakeOmp = path.join(binDir, 'omp');
  fs.writeFileSync(fakeOmp, FAKE_OMP_WITH_RPC);
  fs.chmodSync(fakeOmp, 0o755);
  return { home, binDir, rpcSettingsEnv };
}

function homeEnv({ home, binDir, rpcSettingsEnv }) {
  return {
    HOME: home,
    USERPROFILE: home,
    ZEROSHOT_HOME: home,
    ...rpcSettingsEnv,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
}

/** Runs a script against this home's store. A non-zero exit is a legitimate outcome for some of
 * these commands (`zeroshot task kill` sets process.exitCode when it cannot confirm termination),
 * so the stdout is returned either way and the assertions judge the durable state. */
async function runInHome(homeInfo, script) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, ...homeEnv(homeInfo) } }
    );
    return stdout;
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.includes('@@')) return error.stdout;
    throw error;
  }
}

async function runSpawnHarness(homeInfo) {
  const harnessPath = path.join(homeInfo.home, 'spawn-harness.mjs');
  fs.writeFileSync(harnessPath, SPAWN_HARNESS);
  const { stdout } = await execFileAsync(process.execPath, [harnessPath], {
    env: { ...process.env, ...homeEnv(homeInfo) },
  });
  return JSON.parse(stdout.split('@@').pop());
}

/** The standalone storage root spawnTask uses: TASKS_DIR under ZEROSHOT_HOME. */
async function tasksDir(homeInfo) {
  const stdout = await runInHome(
    homeInfo,
    `const { TASKS_DIR } = await import(${JSON.stringify(
      pathToFileURL(path.resolve(__dirname, '../../task-lib/config.js')).href
    )});
     process.stdout.write(TASKS_DIR);`
  );
  return stdout.trim();
}

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
        addTask({
          id: ${JSON.stringify(id)},
          status: 'running',
          provider: 'omp',
          pid: ${JSON.stringify(pid)},
          cwd: ${JSON.stringify(storageRoot)},
          ompSessionOwnership: writeProvisionalOwnership({
            partitionId: ${JSON.stringify(partitionId)},
            storageRoot: ${JSON.stringify(storageRoot)},
            canonicalWorkspace: ${JSON.stringify(storageRoot)},
            owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: ${JSON.stringify(id)} },
          }),
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
