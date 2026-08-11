// Where OMP session partitions live on disk: the owning cluster's storageDir for cluster-agent
// tasks (passed down via env since agent-task-executor.js spawns this CLI as a child process), or
// the standalone TASKS_DIR otherwise. Never derived from prompt text or cwd.
import { TASKS_DIR } from './config.js';

interface OmpSessionlessOptions {
  readonly sessionless?: boolean;
}

interface OmpStorageRootOptions {
  readonly storageRoot?: string;
}

interface OmpOwnerOptions {
  readonly clusterId?: string;
  readonly agentId?: string;
}

interface ClusterAgentOwner {
  readonly kind: 'cluster-agent';
  readonly clusterId: string;
  readonly agentId: string;
}

interface StandaloneOwner {
  readonly kind: 'standalone';
  readonly clusterId: null;
  readonly agentId: null;
}

export const OMP_STORAGE_ROOT_ENV = 'ZEROSHOT_OMP_STORAGE_ROOT';
export const OMP_OWNER_CLUSTER_ID_ENV = 'ZEROSHOT_CLUSTER_ID';
export const OMP_OWNER_AGENT_ID_ENV = 'ZEROSHOT_AGENT_ID';
/**
 * Set by the agent for a Docker-isolated OMP run. Issue #866 keeps Docker fresh-only, and the
 * container is the reason: its filesystem is ephemeral, so a partition allocated inside it could
 * never be resumed and an ownership row pointing at it would be unreclaimable the moment the
 * container is removed. A task carrying this marker allocates no partition and persists no
 * ownership row — the adapter launches `--no-session`.
 */
export const OMP_SESSIONLESS_ENV = 'ZEROSHOT_OMP_SESSIONLESS';

/** True when this task must run without any session partition at all. */
export function isOmpSessionlessRun(options: OmpSessionlessOptions = {}): boolean {
  return options.sessionless === true || process.env[OMP_SESSIONLESS_ENV] === '1';
}

export function resolveOmpStorageRoot(options: OmpStorageRootOptions = {}): string {
  return options.storageRoot || process.env[OMP_STORAGE_ROOT_ENV] || TASKS_DIR;
}

/** cluster-agent when both a cluster and agent id are known, standalone otherwise. */
export function resolveOmpOwnerKind(
  options: OmpOwnerOptions = {}
): ClusterAgentOwner | StandaloneOwner {
  const clusterId = options.clusterId || process.env[OMP_OWNER_CLUSTER_ID_ENV] || null;
  const agentId = options.agentId || process.env[OMP_OWNER_AGENT_ID_ENV] || null;
  if (clusterId && agentId) {
    return { kind: 'cluster-agent', clusterId, agentId };
  }
  return { kind: 'standalone', clusterId: null, agentId: null };
}
