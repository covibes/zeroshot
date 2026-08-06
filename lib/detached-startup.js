const fs = require('fs');
const os = require('os');
const path = require('path');
const lockfile = require('proper-lockfile');
const { resolveRunPlan } = require('./run-plan');
const { isProcessRunning } = require('./process-liveness');
const IsolationManager = require('../src/isolation-manager');

const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;
const DEFAULT_WAIT_POLL_MS = 1000;
const CLUSTERS_LOCK_STALE_MS = 5000;
const DEFAULT_OWNERSHIP_TIMEOUT_MS = 10000;

function getStorageDir(storageDir) {
  return storageDir || path.join(os.homedir(), '.zeroshot');
}

function getClustersFilePath(storageDir) {
  return path.join(getStorageDir(storageDir), 'clusters.json');
}

function resolveWaitTimeoutMs(waitTimeoutSeconds) {
  const parsed = Number(waitTimeoutSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAIT_TIMEOUT_SECONDS * 1000;
  }
  return Math.floor(parsed * 1000);
}

// Kept as an alias: this module used to carry its own copy of this check.
const isProcessAlive = isProcessRunning;

function isClusterRegistered(clusterId, storageDir) {
  const clustersFile = getClustersFilePath(storageDir);
  if (!fs.existsSync(clustersFile)) {
    return false;
  }

  let parsed;
  try {
    const raw = fs.readFileSync(clustersFile, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  return parsed !== null && typeof parsed === 'object' && Boolean(parsed[clusterId]);
}

function ensureStorageDir(storageDir) {
  const resolvedStorageDir = getStorageDir(storageDir);
  fs.mkdirSync(resolvedStorageDir, { recursive: true });
  return resolvedStorageDir;
}

function ensureClustersFile(storageDir) {
  const resolvedStorageDir = ensureStorageDir(storageDir);
  const clustersFile = getClustersFilePath(resolvedStorageDir);
  try {
    fs.writeFileSync(clustersFile, '{}', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw error;
    }
  }
  return clustersFile;
}

function readClustersFile(clustersFile) {
  try {
    return JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
  } catch {
    return {};
  }
}

async function updateClustersFile(storageDir, updater) {
  const clustersFile = ensureClustersFile(storageDir);
  const lockfilePath = path.join(path.dirname(clustersFile), 'clusters.json.lock');
  let release;

  try {
    release = await lockfile.lock(clustersFile, {
      lockfilePath,
      stale: CLUSTERS_LOCK_STALE_MS,
      retries: {
        retries: 20,
        minTimeout: 100,
        maxTimeout: 250,
        randomize: true,
      },
    });

    const clusters = readClustersFile(clustersFile);
    const updated = updater(clusters) || clusters;
    fs.writeFileSync(clustersFile, JSON.stringify(updated, null, 2));
    return updated;
  } finally {
    if (release) {
      await release();
    }
  }
}

async function registerDetachedSetupCluster({
  clusterId,
  pid,
  storageDir,
  logPath,
  worktree,
  runOptions = {},
  cwd,
}) {
  const plan = resolveRunPlan(runOptions);
  const setupResources =
    plan.isolation === 'docker' ? IsolationManager.getDetachedSetupResources(clusterId) : null;
  await updateClustersFile(storageDir, (clusters) => {
    clusters[clusterId] = {
      id: clusterId,
      state: 'setup',
      createdAt: Date.now(),
      pid: Number.isInteger(pid) ? pid : null,
      setupLogPath: logPath || null,
      setupStartedAt: Date.now(),
      setupStage: 'starting',
      autoPr: plan.delivery !== 'none',
      prOptions: runOptions.prBase
        ? {
            prBase: runOptions.prBase,
            mergeQueue: runOptions.mergeQueue || false,
            closeIssue: runOptions.closeIssue || null,
            autoMerge: plan.autoMerge,
            cwd: cwd || null,
          }
        : null,
      worktree: worktree || null,
      config: null,
      issue: null,
      isolation: null,
      agentStates: [],
      failureInfo: null,
      setupResources,
      provisional: true,
    };
    return clusters;
  });
}

async function removeDetachedSetupCluster({ clusterId, storageDir }) {
  await updateClustersFile(storageDir, (clusters) => {
    delete clusters[clusterId];
    return clusters;
  });
}

async function markDetachedSetupFailed({ clusterId, storageDir, error, logPath }) {
  await updateClustersFile(storageDir, (clusters) => {
    const existing = clusters[clusterId] || { id: clusterId, createdAt: Date.now() };
    clusters[clusterId] = {
      ...existing,
      state: 'failed',
      pid: null,
      setupLogPath: existing.setupLogPath || logPath || null,
      setupFinishedAt: Date.now(),
      failureInfo: {
        type: 'setup',
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      provisional: true,
    };
    return clusters;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLogHint(logPath) {
  return logPath ? ` Check log: ${logPath}` : '';
}

async function waitForClusterRegistration({
  clusterId,
  timeoutMs,
  pollMs = DEFAULT_WAIT_POLL_MS,
  storageDir,
  daemonPid,
  logPath,
}) {
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_SECONDS * 1000;
  const startedAt = Date.now();
  const deadline = startedAt + effectiveTimeoutMs;
  const logHint = formatLogHint(logPath);

  while (Date.now() < deadline) {
    if (isClusterRegistered(clusterId, storageDir)) {
      return { ready: true, elapsedMs: Date.now() - startedAt };
    }

    if (daemonPid && !isProcessAlive(daemonPid)) {
      throw new Error(
        `Detached daemon exited before cluster "${clusterId}" registered in storage.${logHint}`
      );
    }

    await sleep(pollMs);
  }

  const timeoutSeconds = Math.ceil(effectiveTimeoutMs / 1000);
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for cluster "${clusterId}" to appear in status/list.${logHint}`
  );
}

/**
 * Atomically claim the right to resume-daemon an *existing* cluster record.
 *
 * This deliberately does NOT touch cluster.pid/state - those are the fields
 * orchestrator.resume()'s own eligibility guard inspects to decide "is
 * someone else already running this?". If this function stamped its PID onto
 * `cluster.pid` up front, the daemon's own subsequent resume() call would see
 * state:'running' with a PID that (trivially) belongs to itself and is
 * therefore alive, and reject itself as "still running" - which is exactly
 * what happened in early revisions of this fix. Ownership for the handoff is
 * tracked in a separate `resumeDaemonPid` field instead; orchestrator.resume()
 * never looks at it, and _restartClusterAgents sets the real cluster.pid once
 * resume() actually decides to proceed.
 *
 * Unlike registerDetachedSetupCluster (which writes a brand-new placeholder
 * record for a cluster ID that doesn't exist yet), this only adds
 * resumeDaemonPid to the existing record - config/agents/worktree/isolation
 * survive untouched, or the daemon's orchestrator.resume() would reload a
 * blank record and reject it as an unfinished setup cluster.
 *
 * The liveness re-check happens inside the same updateClustersFile lock that
 * performs the write, so two concurrent resume --detach invocations can't both
 * observe no live claimant and both win: whichever's write lands second sees
 * either the first daemon's (still-live) resumeDaemonPid, or - once that gets
 * overwritten by the first daemon's own early _saveClusters() call - its real
 * state:'running' + live pid, and aborts instead of clobbering it.
 */
async function patchDetachedResumeCluster({ clusterId, daemonPid, storageDir }) {
  await updateClustersFile(storageDir, (clusters) => {
    const existing = clusters[clusterId];
    if (!existing) {
      throw new Error(`Cannot start resume daemon: cluster "${clusterId}" not found in registry`);
    }
    if (existing.resumeDaemonPid && isProcessRunning(existing.resumeDaemonPid)) {
      throw new Error(
        `Cluster "${clusterId}" already has a live resume daemon (PID ${existing.resumeDaemonPid}); refusing to start a second one`
      );
    }
    // resumeDaemonPid only covers the window up to orchestrator.resume()
    // actually proceeding - _restartClusterAgents sets the real cluster.pid,
    // and _resumeFailedCluster/_resumeCleanCluster save that almost
    // immediately (well before the resumed work itself finishes), which wipes
    // resumeDaemonPid since it isn't in _saveClusters' persisted field list.
    // Falling back to state+pid here closes that second window: a first
    // daemon that has already progressed to actually running is just as much
    // a live claimant as one still mid-handoff.
    if (existing.state === 'running' && existing.pid && isProcessRunning(existing.pid)) {
      throw new Error(
        `Cluster "${clusterId}" is already running (PID ${existing.pid}); refusing to start a second resume daemon`
      );
    }
    clusters[clusterId] = { ...existing, resumeDaemonPid: daemonPid };
    return clusters;
  });
}

/**
 * Undo a resume handoff that didn't pan out (daemon died before completing
 * ownership, or orchestrator.resume() itself rejected it) so the cluster
 * doesn't end up stuck at state:'running' with a dead PID - the exact zombie
 * this whole mechanism exists to prevent.
 */
async function revertDetachedResumeCluster({ clusterId, storageDir, error }) {
  await updateClustersFile(storageDir, (clusters) => {
    const existing = clusters[clusterId];
    if (!existing) return clusters;
    clusters[clusterId] = {
      ...existing,
      state: 'failed',
      pid: null,
      resumeDaemonPid: null,
      failureInfo: {
        type: 'resume-daemon',
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
    };
    return clusters;
  });
}

function getRegisteredResumeDaemonPid(clusterId, storageDir) {
  const clustersFile = getClustersFilePath(storageDir);
  if (!fs.existsSync(clustersFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
    return parsed?.[clusterId]?.resumeDaemonPid ?? null;
  } catch {
    return null;
  }
}

/**
 * Daemon-side half of the resume handoff: block until the registry shows
 * *this process's* PID as resumeDaemonPid before touching the cluster.
 * Closes the window between spawn() returning a PID and the parent's
 * patchDetachedResumeCluster() write landing - without it, a losing daemon
 * from a concurrent resume --detach could start running orchestrator.resume()
 * before its parent's CAS check ever gets a chance to reject it.
 */
async function waitForResumeOwnership({
  clusterId,
  daemonPid,
  storageDir,
  timeoutMs = DEFAULT_OWNERSHIP_TIMEOUT_MS,
  pollMs = DEFAULT_WAIT_POLL_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getRegisteredResumeDaemonPid(clusterId, storageDir) === daemonPid) {
      return true;
    }
    await sleep(pollMs);
  }
  return getRegisteredResumeDaemonPid(clusterId, storageDir) === daemonPid;
}

module.exports = {
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  getClustersFilePath,
  getRegisteredResumeDaemonPid,
  isClusterRegistered,
  isProcessAlive,
  markDetachedSetupFailed,
  patchDetachedResumeCluster,
  registerDetachedSetupCluster,
  removeDetachedSetupCluster,
  resolveWaitTimeoutMs,
  revertDetachedResumeCluster,
  waitForClusterRegistration,
  waitForResumeOwnership,
};
