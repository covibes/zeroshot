import fs = require('fs');
import os = require('os');
import path = require('path');

interface LockOptions {
  lockfilePath: string;
  stale: number;
  retries: {
    retries: number;
    minTimeout: number;
    maxTimeout: number;
    randomize: boolean;
  };
}

type ReleaseLock = () => Promise<void>;

interface LockfileFacade {
  lock(filePath: string, options: LockOptions): Promise<ReleaseLock>;
}

interface RunOptions extends Record<string, unknown> {
  autoMerge?: unknown;
  closeIssue?: unknown;
  docker?: unknown;
  mergeQueue?: unknown;
  pr?: unknown;
  prBase?: unknown;
  ship?: unknown;
  worktree?: unknown;
}

interface RunPlan {
  isolation: 'none' | 'worktree' | 'docker';
  delivery: 'none' | 'pr' | 'ship';
  autoMerge: boolean;
}

interface RunPlanFacade {
  resolveRunPlan(options?: RunOptions): Readonly<RunPlan>;
}

interface ProcessLivenessFacade {
  isProcessRunning(pid: unknown): boolean;
}

interface IsolationManagerFacade {
  getDetachedSetupResources(clusterId: string): unknown;
}

interface ClusterRecord extends Record<string, unknown> {
  createdAt?: number;
  id?: string;
  pid?: number | null;
  resumeDaemonPid?: number | null;
  setupLogPath?: string | null;
  state?: string;
}

type ClusterRegistry = Record<string, ClusterRecord>;
type ClusterUpdater = (clusters: ClusterRegistry) => ClusterRegistry | void;

interface DetachedSetupParams {
  clusterId: string;
  pid?: number;
  storageDir?: string;
  logPath?: string | null;
  worktree?: unknown;
  runOptions?: RunOptions;
  cwd?: string;
}

interface ClusterIdentityParams {
  clusterId: string;
  storageDir?: string;
}

interface SetupFailureParams extends ClusterIdentityParams {
  error: unknown;
  logPath?: string | null;
}

interface ResumePatchParams extends ClusterIdentityParams {
  daemonPid: number;
}

interface RegistrationWaitParams extends ClusterIdentityParams {
  timeoutMs?: number;
  pollMs?: number;
  daemonPid?: number;
  logPath?: string | null;
}

interface OwnershipWaitParams extends ResumePatchParams {
  timeoutMs?: number;
  pollMs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const lockfile: LockfileFacade = require('proper-lockfile');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const runPlan: RunPlanFacade = require('./run-plan');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const processLiveness: ProcessLivenessFacade = require('./process-liveness');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const IsolationManager: IsolationManagerFacade = require('../src/isolation-manager');

const { resolveRunPlan } = runPlan;
const { isProcessRunning } = processLiveness;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;
const DEFAULT_WAIT_POLL_MS = 1000;
const CLUSTERS_LOCK_STALE_MS = 5000;
const DEFAULT_OWNERSHIP_TIMEOUT_MS = 10000;

function isClusterRegistry(value: unknown): value is ClusterRegistry {
  return value !== null && typeof value === 'object';
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

function getStorageDir(storageDir?: string | null): string {
  return storageDir || path.join(os.homedir(), '.zeroshot');
}

function getClustersFilePath(storageDir?: string | null): string {
  return path.join(getStorageDir(storageDir), 'clusters.json');
}

function resolveWaitTimeoutMs(waitTimeoutSeconds: unknown): number {
  const parsed = Number(waitTimeoutSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAIT_TIMEOUT_SECONDS * 1000;
  }
  return Math.floor(parsed * 1000);
}

// Kept as an alias: this module used to carry its own copy of this check.
const isProcessAlive = isProcessRunning;

function isClusterRegistered(clusterId: string, storageDir?: string): boolean {
  const clustersFile = getClustersFilePath(storageDir);
  if (!fs.existsSync(clustersFile)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(clustersFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isClusterRegistry(parsed) && Boolean(parsed[clusterId]);
  } catch {
    return false;
  }
}

function ensureStorageDir(storageDir?: string): string {
  const resolvedStorageDir = getStorageDir(storageDir);
  fs.mkdirSync(resolvedStorageDir, { recursive: true });
  return resolvedStorageDir;
}

function ensureClustersFile(storageDir?: string): string {
  const resolvedStorageDir = ensureStorageDir(storageDir);
  const clustersFile = getClustersFilePath(resolvedStorageDir);
  try {
    fs.writeFileSync(clustersFile, '{}', { flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
  return clustersFile;
}

function readClustersFile(clustersFile: string): ClusterRegistry {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
    return isClusterRegistry(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function updateClustersFile(
  storageDir: string | undefined,
  updater: ClusterUpdater
): Promise<ClusterRegistry> {
  const clustersFile = ensureClustersFile(storageDir);
  const lockfilePath = path.join(path.dirname(clustersFile), 'clusters.json.lock');
  let release: ReleaseLock | undefined;

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
}: DetachedSetupParams): Promise<void> {
  const plan = resolveRunPlan(runOptions);
  const setupResources =
    plan.isolation === 'docker' ? IsolationManager.getDetachedSetupResources(clusterId) : null;
  await updateClustersFile(storageDir, (clusters) => {
    clusters[clusterId] = {
      id: clusterId,
      state: 'setup',
      createdAt: Date.now(),
      pid: typeof pid === 'number' && Number.isInteger(pid) ? pid : null,
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

async function removeDetachedSetupCluster({
  clusterId,
  storageDir,
}: ClusterIdentityParams): Promise<void> {
  await updateClustersFile(storageDir, (clusters) => {
    delete clusters[clusterId];
    return clusters;
  });
}

async function markDetachedSetupFailed({
  clusterId,
  storageDir,
  error,
  logPath,
}: SetupFailureParams): Promise<void> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLogHint(logPath?: string | null): string {
  return logPath ? ` Check log: ${logPath}` : '';
}

async function waitForClusterRegistration({
  clusterId,
  timeoutMs,
  pollMs = DEFAULT_WAIT_POLL_MS,
  storageDir,
  daemonPid,
  logPath,
}: RegistrationWaitParams): Promise<{ ready: true; elapsedMs: number }> {
  const effectiveTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_WAIT_TIMEOUT_SECONDS * 1000;
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
 * Atomically claim the right to resume-daemon an existing cluster record.
 * Ownership for the handoff is tracked separately from cluster.pid/state so
 * orchestrator.resume() can still perform its own eligibility check.
 */
async function patchDetachedResumeCluster({
  clusterId,
  daemonPid,
  storageDir,
}: ResumePatchParams): Promise<void> {
  await updateClustersFile(storageDir, (clusters) => {
    const existing = clusters[clusterId];
    if (!existing) {
      throw new Error(`Cannot start resume daemon: cluster "${clusterId}" not found in registry`);
    }
    if (existing.resumeDaemonPid && isProcessRunning(existing.resumeDaemonPid)) {
      const ownership = `Cluster "${clusterId}" already has a live resume daemon`;
      throw new Error(
        `${ownership} (PID ${existing.resumeDaemonPid}); refusing to start a second one`
      );
    }
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
 * Undo a resume handoff that did not complete so a dead daemon cannot leave
 * the cluster stuck in a running state.
 */
async function revertDetachedResumeCluster({
  clusterId,
  storageDir,
  error,
}: SetupFailureParams): Promise<void> {
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

function getRegisteredResumeDaemonPid(clusterId: string, storageDir?: string): number | null {
  const clustersFile = getClustersFilePath(storageDir);
  if (!fs.existsSync(clustersFile)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(clustersFile, 'utf8'));
    if (!isClusterRegistry(parsed)) {
      return null;
    }
    return parsed[clusterId]?.resumeDaemonPid ?? null;
  } catch {
    return null;
  }
}

/**
 * Daemon-side half of the resume handoff: wait until the registry shows this
 * process's PID as resumeDaemonPid before touching the cluster.
 */
async function waitForResumeOwnership({
  clusterId,
  daemonPid,
  storageDir,
  timeoutMs = DEFAULT_OWNERSHIP_TIMEOUT_MS,
  pollMs = DEFAULT_WAIT_POLL_MS,
}: OwnershipWaitParams): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getRegisteredResumeDaemonPid(clusterId, storageDir) === daemonPid) {
      return true;
    }
    await sleep(pollMs);
  }
  return getRegisteredResumeDaemonPid(clusterId, storageDir) === daemonPid;
}

export = {
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
