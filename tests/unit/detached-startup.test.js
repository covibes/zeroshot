const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Orchestrator = require('../../src/orchestrator');

const {
  getClustersFilePath,
  getRegisteredResumeDaemonPid,
  isClusterRegistered,
  markDetachedSetupFailed,
  patchDetachedResumeCluster,
  registerDetachedSetupCluster,
  removeDetachedSetupCluster,
  resolveWaitTimeoutMs,
  revertDetachedResumeCluster,
  waitForClusterRegistration,
  waitForResumeOwnership,
} = require('../../lib/detached-startup');

describe('detached-startup helpers', function () {
  let tempRoot = null;
  /** @type {NodeJS.Timeout | null} */
  let pendingTimer = null;

  function createTempStorageDir() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-detached-startup-'));
    return tempRoot;
  }

  afterEach(function () {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('uses default timeout when value is invalid', function () {
    assert.strictEqual(resolveWaitTimeoutMs(undefined), 180000);
    assert.strictEqual(resolveWaitTimeoutMs(0), 180000);
    assert.strictEqual(resolveWaitTimeoutMs(-10), 180000);
    assert.strictEqual(resolveWaitTimeoutMs('bad-value'), 180000);
  });

  it('converts valid wait timeout to milliseconds', function () {
    assert.strictEqual(resolveWaitTimeoutMs(2), 2000);
    assert.strictEqual(resolveWaitTimeoutMs('2.5'), 2500);
  });

  it('returns false when clusters.json does not exist', function () {
    const storageDir = createTempStorageDir();
    assert.strictEqual(isClusterRegistered('missing-cluster', storageDir), false);
  });

  it('returns true when cluster is present in clusters.json', function () {
    const storageDir = createTempStorageDir();
    const clustersFile = getClustersFilePath(storageDir);
    fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
    fs.writeFileSync(
      clustersFile,
      JSON.stringify({
        'ready-cluster': { id: 'ready-cluster' },
      })
    );

    assert.strictEqual(isClusterRegistered('ready-cluster', storageDir), true);
  });

  it('does not replace an existing clusters file when registering setup clusters', async function () {
    const storageDir = createTempStorageDir();
    const clustersFile = getClustersFilePath(storageDir);
    fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
    fs.writeFileSync(clustersFile, JSON.stringify({ existing: { id: 'existing' } }));

    await registerDetachedSetupCluster({ clusterId: 'new-cluster', storageDir });

    const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
    assert.deepStrictEqual(clusters.existing, { id: 'existing' });
    assert.strictEqual(clusters['new-cluster'].id, 'new-cluster');
  });

  it('registers detached setup clusters before the daemon creates a ledger', async function () {
    const storageDir = createTempStorageDir();

    await registerDetachedSetupCluster({
      clusterId: 'setup-cluster',
      pid: 12345,
      storageDir,
      logPath: path.join(storageDir, 'setup-cluster-daemon.log'),
      runOptions: { pr: true, prBase: 'dev', prBody: 'Issue {{issue_number}}' },
      cwd: '/repo',
    });

    const clusters = JSON.parse(fs.readFileSync(getClustersFilePath(storageDir), 'utf8'));
    assert.strictEqual(clusters['setup-cluster'].state, 'setup');
    assert.strictEqual(clusters['setup-cluster'].pid, 12345);
    assert.strictEqual(clusters['setup-cluster'].prOptions.prBase, 'dev');
    assert.strictEqual(clusters['setup-cluster'].prOptions.prBody, 'Issue {{issue_number}}');
    assert.strictEqual(isClusterRegistered('setup-cluster', storageDir), true);
  });

  it('keeps setup clusters visible in list/status before a ledger exists', async function () {
    const storageDir = createTempStorageDir();

    await registerDetachedSetupCluster({
      clusterId: 'visible-setup-cluster',
      pid: process.pid,
      storageDir,
      logPath: path.join(storageDir, 'visible-setup-cluster-daemon.log'),
    });

    const orchestrator = await Orchestrator.create({ quiet: true, storageDir });
    const listed = orchestrator
      .listClusters()
      .find((cluster) => cluster.id === 'visible-setup-cluster');
    assert(listed);
    assert.strictEqual(listed.state, 'setup');
    assert.strictEqual(listed.agentCount, 0);

    const status = orchestrator.getStatus('visible-setup-cluster');
    assert.strictEqual(status.state, 'setup');
    assert.strictEqual(status.messageCount, 0);
  });

  it('marks detached setup failures while keeping the setup log path', async function () {
    const storageDir = createTempStorageDir();
    const logPath = path.join(storageDir, 'failed-daemon.log');

    await registerDetachedSetupCluster({
      clusterId: 'failed-cluster',
      pid: 12345,
      storageDir,
      logPath,
    });
    await markDetachedSetupFailed({
      clusterId: 'failed-cluster',
      storageDir,
      error: new Error('setup exploded'),
    });

    const clusters = JSON.parse(fs.readFileSync(getClustersFilePath(storageDir), 'utf8'));
    assert.strictEqual(clusters['failed-cluster'].state, 'failed');
    assert.strictEqual(clusters['failed-cluster'].pid, null);
    assert.strictEqual(clusters['failed-cluster'].setupLogPath, logPath);
    assert.strictEqual(clusters['failed-cluster'].failureInfo.error, 'setup exploded');
  });

  it('removes a provisional setup cluster without leaving a phantom entry', async function () {
    const storageDir = createTempStorageDir();
    const clustersFile = getClustersFilePath(storageDir);
    fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
    fs.writeFileSync(clustersFile, JSON.stringify({ other: { id: 'other' } }));

    await registerDetachedSetupCluster({
      clusterId: 'rejected-cluster',
      pid: 12345,
      storageDir,
    });
    assert.strictEqual(isClusterRegistered('rejected-cluster', storageDir), true);

    await removeDetachedSetupCluster({ clusterId: 'rejected-cluster', storageDir });

    const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
    assert.strictEqual(clusters['rejected-cluster'], undefined);
    // Unrelated entries in the same file must be preserved.
    assert.deepStrictEqual(clusters.other, { id: 'other' });
  });

  it('waits until cluster is registered', async function () {
    this.timeout(5000);
    const storageDir = createTempStorageDir();
    const clustersFile = getClustersFilePath(storageDir);
    const clusterId = 'cluster-waits';

    fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
    fs.writeFileSync(clustersFile, JSON.stringify({}));

    pendingTimer = setTimeout(() => {
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          [clusterId]: { id: clusterId },
        })
      );
    }, 80);

    const result = await waitForClusterRegistration({
      clusterId,
      timeoutMs: 2000,
      pollMs: 20,
      storageDir,
    });

    assert.strictEqual(result.ready, true);
    assert(result.elapsedMs >= 0);
  });

  it('fails on timeout when cluster never appears', async function () {
    const storageDir = createTempStorageDir();
    const clustersFile = getClustersFilePath(storageDir);
    fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
    fs.writeFileSync(clustersFile, JSON.stringify({}));

    await assert.rejects(
      waitForClusterRegistration({
        clusterId: 'never-there',
        timeoutMs: 120,
        pollMs: 20,
        storageDir,
      }),
      /Timed out/
    );
  });

  it('fails fast when daemon exits before registration', async function () {
    this.timeout(5000);
    const storageDir = createTempStorageDir();
    const clustersFile = getClustersFilePath(storageDir);
    fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
    fs.writeFileSync(clustersFile, JSON.stringify({}));

    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise((resolve) => child.on('exit', resolve));

    await assert.rejects(
      waitForClusterRegistration({
        clusterId: 'daemon-died',
        timeoutMs: 1000,
        pollMs: 20,
        storageDir,
        daemonPid: child.pid,
      }),
      /exited before cluster/
    );
  });

  describe('patchDetachedResumeCluster', function () {
    it('only adds resumeDaemonPid, preserving pid/state/config/worktree/isolation', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          'resume-me': {
            id: 'resume-me',
            state: 'failed',
            pid: null,
            config: { agents: [{ id: 'worker' }] },
            worktree: { path: '/tmp/resume-me', branch: 'zeroshot/resume-me' },
            isolation: { enabled: false },
            failureInfo: { agentId: 'worker', error: 'boom' },
          },
        })
      );

      await patchDetachedResumeCluster({ clusterId: 'resume-me', daemonPid: 4242, storageDir });

      const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(clusters['resume-me'].resumeDaemonPid, 4242);
      // pid/state are intentionally left alone: orchestrator.resume()'s own
      // eligibility guard reads them, and _restartClusterAgents is what sets
      // the real cluster.pid once resume() actually proceeds. Stamping pid
      // here would make the daemon see its own (trivially alive) PID and
      // reject itself as "still running".
      assert.strictEqual(clusters['resume-me'].pid, null);
      assert.strictEqual(clusters['resume-me'].state, 'failed');
      // Everything else must survive untouched - this is what distinguishes
      // patching from registerDetachedSetupCluster's wholesale replacement.
      assert.deepStrictEqual(clusters['resume-me'].config, { agents: [{ id: 'worker' }] });
      assert.deepStrictEqual(clusters['resume-me'].worktree, {
        path: '/tmp/resume-me',
        branch: 'zeroshot/resume-me',
      });
      assert.deepStrictEqual(clusters['resume-me'].isolation, { enabled: false });
      assert.deepStrictEqual(clusters['resume-me'].failureInfo, {
        agentId: 'worker',
        error: 'boom',
      });
    });

    it('throws when the cluster does not exist', async function () {
      const storageDir = createTempStorageDir();
      await assert.rejects(
        patchDetachedResumeCluster({ clusterId: 'missing', daemonPid: 123, storageDir }),
        /not found in registry/
      );
    });

    it('refuses a second handoff while the first resumeDaemonPid is alive', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      // process.pid (this test process) is guaranteed alive.
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          'owned-cluster': { id: 'owned-cluster', state: 'failed', resumeDaemonPid: process.pid },
        })
      );

      await assert.rejects(
        patchDetachedResumeCluster({ clusterId: 'owned-cluster', daemonPid: 55555, storageDir }),
        /already has a live resume daemon/
      );

      // The losing write must not have landed - the live claimant stays recorded.
      const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(clusters['owned-cluster'].resumeDaemonPid, process.pid);
    });

    it('succeeds when a previously recorded resumeDaemonPid is dead (stale handoff)', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          stale: { id: 'stale', state: 'failed', resumeDaemonPid: 999999 },
        })
      );

      await patchDetachedResumeCluster({ clusterId: 'stale', daemonPid: 4242, storageDir });

      const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(clusters.stale.resumeDaemonPid, 4242);
    });

    it('succeeds against a zombie record (state=running, dead pid) without touching pid/state', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          zombie: { id: 'zombie', state: 'running', pid: 999999 },
        })
      );

      await patchDetachedResumeCluster({ clusterId: 'zombie', daemonPid: 4242, storageDir });

      const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(clusters.zombie.resumeDaemonPid, 4242);
      // The dead pid/state:'running' is exactly what orchestrator.resume()'s
      // own guard needs to see to correctly identify and recover the zombie.
      assert.strictEqual(clusters.zombie.pid, 999999);
      assert.strictEqual(clusters.zombie.state, 'running');
    });

    it("falls back to state+pid once resumeDaemonPid has been wiped by the winner's own save", async function () {
      // Reproduces the real race: _resumeFailedCluster/_resumeCleanCluster call
      // _saveClusters() almost immediately after a resume starts (well before
      // the resumed work itself finishes), and _saveClusters' field allowlist
      // doesn't include resumeDaemonPid - so it gets dropped even though the
      // first daemon is now genuinely, actively running the cluster. A second
      // racer must still be rejected via state+pid in that window.
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          'already-running': { id: 'already-running', state: 'running', pid: process.pid },
        })
      );

      await assert.rejects(
        patchDetachedResumeCluster({ clusterId: 'already-running', daemonPid: 55555, storageDir }),
        /is already running/
      );

      const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(clusters['already-running'].pid, process.pid);
      assert.strictEqual(clusters['already-running'].resumeDaemonPid, undefined);
    });
  });

  describe('revertDetachedResumeCluster', function () {
    it('marks the cluster failed, clears pid/resumeDaemonPid, leaving other fields intact', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({
          'botched-handoff': {
            id: 'botched-handoff',
            state: 'running',
            pid: 4242,
            resumeDaemonPid: 4242,
            config: { agents: [] },
          },
        })
      );

      await revertDetachedResumeCluster({
        clusterId: 'botched-handoff',
        storageDir,
        error: new Error('daemon died before ownership handoff'),
      });

      const clusters = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
      assert.strictEqual(clusters['botched-handoff'].state, 'failed');
      assert.strictEqual(clusters['botched-handoff'].pid, null);
      assert.strictEqual(clusters['botched-handoff'].resumeDaemonPid, null);
      assert.strictEqual(clusters['botched-handoff'].failureInfo.type, 'resume-daemon');
      assert.strictEqual(
        clusters['botched-handoff'].failureInfo.error,
        'daemon died before ownership handoff'
      );
      assert.deepStrictEqual(clusters['botched-handoff'].config, { agents: [] });
    });

    it('is a no-op when the cluster is missing (already cleaned up elsewhere)', async function () {
      const storageDir = createTempStorageDir();
      await revertDetachedResumeCluster({
        clusterId: 'never-existed',
        storageDir,
        error: new Error('boom'),
      });
      // Must not throw and must not create a phantom entry.
      const clusters = JSON.parse(fs.readFileSync(getClustersFilePath(storageDir), 'utf8'));
      assert.strictEqual(clusters['never-existed'], undefined);
    });
  });

  describe('getRegisteredResumeDaemonPid / waitForResumeOwnership', function () {
    it('returns null when the cluster or file is missing', function () {
      const storageDir = createTempStorageDir();
      assert.strictEqual(getRegisteredResumeDaemonPid('nope', storageDir), null);
    });

    it('reads back the pid patched by patchDetachedResumeCluster', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({ target: { id: 'target', state: 'failed', pid: null } })
      );

      await patchDetachedResumeCluster({ clusterId: 'target', daemonPid: 777, storageDir });

      assert.strictEqual(getRegisteredResumeDaemonPid('target', storageDir), 777);
    });

    it('resolves true once the registry shows this pid as owner', async function () {
      this.timeout(5000);
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({ handoff: { id: 'handoff', state: 'failed', pid: null } })
      );

      pendingTimer = setTimeout(() => {
        patchDetachedResumeCluster({ clusterId: 'handoff', daemonPid: 8888, storageDir });
      }, 60);

      const owned = await waitForResumeOwnership({
        clusterId: 'handoff',
        daemonPid: 8888,
        storageDir,
        timeoutMs: 2000,
        pollMs: 20,
      });

      assert.strictEqual(owned, true);
    });

    it('resolves false when ownership never lands (e.g. a losing daemon in a race)', async function () {
      const storageDir = createTempStorageDir();
      const clustersFile = getClustersFilePath(storageDir);
      fs.mkdirSync(path.dirname(clustersFile), { recursive: true });
      fs.writeFileSync(
        clustersFile,
        JSON.stringify({ raced: { id: 'raced', state: 'running', resumeDaemonPid: 111 } })
      );

      const owned = await waitForResumeOwnership({
        clusterId: 'raced',
        daemonPid: 222,
        storageDir,
        timeoutMs: 150,
        pollMs: 20,
      });

      assert.strictEqual(owned, false);
    });
  });
});
